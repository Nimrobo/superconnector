/**
 * Parent-side approval IPC host.
 *
 * Stands up a localhost TCP server that the child MCP approval server connects
 * to. For each approval request from claude, runs the user's onApprovalRequest
 * callback (with timeout) and sends back a decision.
 *
 * Also writes a temp mcp-config.json that points claude at the child server.
 */
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { ApprovalCallback, ApprovalDecision, ApprovalRequest } from './types.js';

const SERVER_NAME = 'superconnector';
const TOOL_NAME = 'approve';

export interface ApprovalHostOptions {
  callback: ApprovalCallback;
  sessionId: string;
  cwd: string;
  timeoutMs: number;
  onDecision?: (req: ApprovalRequest, decision: ApprovalDecision, reason: string) => void;
  onTimeout?: (toolName: string) => void;
}

export interface ApprovalHostHandle {
  permissionPromptToolName: string;
  mcpConfigPath: string;
  env: Record<string, string>;
  dispose(): Promise<void>;
}

function childServerScriptPath(): string {
  // Resolve to the compiled JS sibling in dist/approval/server.js
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), 'server.js');
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, ms);
    p.then((v) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(v);
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(onTimeout());
    });
  });
}

export async function startApprovalHost(opts: ApprovalHostOptions): Promise<ApprovalHostHandle> {
  const token = randomBytes(16).toString('hex');

  const server = net.createServer((sock) => {
    let authed = false;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!authed) {
          if (obj['type'] === 'hello' && obj['token'] === token) {
            authed = true;
          } else {
            sock.destroy();
          }
          continue;
        }
        const id = obj['id'] as number;
        const req = obj['request'] as ApprovalRequest;
        void (async () => {
          let decision: ApprovalDecision;
          let reason = 'callback';
          try {
            decision = await withTimeout(
              opts.callback(req),
              opts.timeoutMs,
              () => {
                reason = 'timeout';
                opts.onTimeout?.(req.toolName);
                return {
                  decision: 'deny',
                  message: `approval timed out after ${opts.timeoutMs}ms`,
                };
              },
            );
          } catch (e) {
            reason = 'handler-error';
            decision = {
              decision: 'deny',
              message: `approval handler error: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
          opts.onDecision?.(req, decision, reason);
          sock.write(`${JSON.stringify({ id, decision })}\n`);
        })();
      }
    });
    sock.on('error', () => sock.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('approval host: failed to bind TCP');
  }
  const port = addr.port;

  const scriptPath = childServerScriptPath();
  const mcpConfig = {
    mcpServers: {
      [SERVER_NAME]: {
        command: process.execPath,
        args: [scriptPath],
        env: {
          SUPERCONNECTOR_IPC_PORT: String(port),
          SUPERCONNECTOR_IPC_TOKEN: token,
          SUPERCONNECTOR_SESSION_ID: opts.sessionId,
          SUPERCONNECTOR_CWD: opts.cwd,
        },
      },
    },
  };
  const dir = join(tmpdir(), 'superconnector');
  mkdirSync(dir, { recursive: true });
  const cfgPath = join(dir, `mcp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(cfgPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

  return {
    permissionPromptToolName: `mcp__${SERVER_NAME}__${TOOL_NAME}`,
    mcpConfigPath: cfgPath,
    env: {},
    async dispose() {
      try {
        unlinkSync(cfgPath);
      } catch {
        /* noop */
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
