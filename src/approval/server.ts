/**
 * Standalone MCP approval server (stdio).
 *
 * Launched by claude as a subprocess via --mcp-config. Speaks newline-delimited
 * JSON-RPC 2.0 (the MCP stdio transport) on stdin/stdout, and forwards each
 * approval request over a TCP socket to the parent superconnector process,
 * which invokes the user-supplied callback and returns the decision.
 *
 * Env vars:
 *   SUPERCONNECTOR_IPC_PORT   localhost TCP port of the parent
 *   SUPERCONNECTOR_IPC_TOKEN  shared secret (handshake)
 *   SUPERCONNECTOR_SESSION_ID session id to attach to every request
 *   SUPERCONNECTOR_CWD        cwd to attach to every request
 */
import net from 'node:net';
import readline from 'node:readline';
import type { ApprovalDecision, ApprovalRequest } from './types.js';

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function send(msg: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function err(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

class IpcClient {
  private socket: net.Socket | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, (decision: ApprovalDecision) => void>();
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  private connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port: this.port }, () => {
        s.write(`${JSON.stringify({ type: 'hello', token: this.token })}\n`);
        this.socket = s;
        resolve();
      });
      s.on('error', (e) => {
        this.connecting = null;
        reject(e);
      });
      s.on('data', (chunk: Buffer) => {
        this.buf += chunk.toString('utf8');
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line) as { id: number; decision: ApprovalDecision };
            const cb = this.pending.get(obj.id);
            if (cb) {
              this.pending.delete(obj.id);
              cb(obj.decision);
            }
          } catch {
            /* ignore */
          }
        }
      });
      s.on('close', () => {
        this.socket = null;
        for (const [, cb] of this.pending) {
          cb({ decision: 'deny', message: 'approval IPC closed' });
        }
        this.pending.clear();
      });
    });
    return this.connecting;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    await this.connect();
    return new Promise<ApprovalDecision>((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.socket!.write(`${JSON.stringify({ id, request: req })}\n`);
    });
  }
}

const port = Number(process.env['SUPERCONNECTOR_IPC_PORT'] ?? 0);
const token = process.env['SUPERCONNECTOR_IPC_TOKEN'] ?? '';
const sessionId = process.env['SUPERCONNECTOR_SESSION_ID'] ?? '';
const cwd = process.env['SUPERCONNECTOR_CWD'] ?? process.cwd();

if (!port || !token) {
  process.stderr.write('superconnector approval server: missing IPC env vars\n');
  process.exit(2);
}

const ipc = new IpcClient(port, token);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return;
  }
  void handle(msg);
});

async function handle(msg: JsonRpcRequest): Promise<void> {
  const id = msg.id ?? null;
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'superconnector', version: '0.1.0' },
        },
      });
      return;
    case 'notifications/initialized':
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'approve',
              description:
                'Permission gate: returns allow/deny for a tool call. Wired by superconnector for headless agents.',
              inputSchema: {
                type: 'object',
                properties: {
                  tool_name: { type: 'string' },
                  input: { type: 'object' },
                  tool_use_id: { type: 'string' },
                },
                required: ['tool_name', 'input'],
              },
            },
          ],
        },
      });
      return;
    case 'tools/call': {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (params.name !== 'approve') {
        err(id, -32601, `unknown tool: ${String(params.name)}`);
        return;
      }
      const args = params.arguments ?? {};
      const toolName = String(args['tool_name'] ?? '');
      const input = args['input'] ?? {};
      let decision: ApprovalDecision;
      try {
        decision = await ipc.request({ sessionId, cwd, toolName, input });
      } catch (e) {
        decision = {
          decision: 'deny',
          message: `approval IPC error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const payload =
        decision.decision === 'allow'
          ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
          : { behavior: 'deny', message: decision.message ?? 'denied' };
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: false,
        },
      });
      return;
    }
    default:
      if (id !== null) err(id, -32601, `method not found: ${msg.method}`);
  }
}
