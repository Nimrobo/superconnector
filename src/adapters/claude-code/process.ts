import { spawn, type ChildProcess } from 'node:child_process';
import { AdapterFailedError, PermissionRequiredError } from '../../errors.js';
import type { AgentMessage, AgentMessageType } from '../../types.js';
import { EventQueue } from '../../util/event-queue.js';

export interface RunArgs {
  binPath: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  onClose?: () => void | Promise<void>;
  /**
   * External events (e.g. approval decisions) injected into the message stream.
   * Closed by the caller; runClaude does not own its lifetime.
   */
  externalEvents?: EventQueue<AgentMessage>;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildResumeCommand(cwd: string, sessionId: string): string {
  return `(cd ${shellQuote(cwd)} && claude --resume ${shellQuote(sessionId)})`;
}

const PERMISSION_RX = /permission|approval|denied|not allowed/i;

function looksLikePermissionResult(obj: Record<string, unknown>): boolean {
  if (obj['type'] !== 'result') return false;
  const subtype = obj['subtype'];
  if (typeof subtype === 'string' && PERMISSION_RX.test(subtype)) return true;
  if (obj['is_error'] === true) {
    const candidates = [obj['result'], obj['error'], obj['message']];
    for (const c of candidates) {
      if (typeof c === 'string' && PERMISSION_RX.test(c)) return true;
    }
  }
  return false;
}

export async function* runClaude(args: RunArgs): AsyncIterable<AgentMessage> {
  const child: ChildProcess = spawn(args.binPath, args.args, {
    cwd: args.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const stream = new EventQueue<AgentMessage>();

  // First message: superconnector spawn metadata.
  stream.push({
    type: 'superconnector',
    sessionId: '',
    content: {
      subtype: 'spawn_meta',
      pid: child.pid ?? null,
      binPath: args.binPath,
      args: args.args,
      cwd: args.cwd,
    },
    raw: { source: 'superconnector' },
  });

  const onAbort = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  if (args.signal) {
    if (args.signal.aborted) onAbort();
    else args.signal.addEventListener('abort', onAbort, { once: true });
  }

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let observedSessionId = '';
  let permissionFailure = false;

  let buf = '';
  const flushLine = (line: string) => {
    if (!line) return;
    const parsed = parseLine(line);
    if (!parsed) return;
    if (!observedSessionId && parsed.msg.sessionId) {
      observedSessionId = parsed.msg.sessionId;
    }
    if (looksLikePermissionResult(parsed.raw)) {
      permissionFailure = true;
      stream.push({
        type: 'superconnector',
        sessionId: observedSessionId,
        content: {
          subtype: 'permission_required',
          resumeCommand: buildResumeCommand(args.cwd, observedSessionId),
        },
        raw: { source: 'superconnector' },
      });
    }
    stream.push(parsed.msg);
  };

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        flushLine(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    });
    child.stdout.on('end', () => {
      if (buf.trim()) flushLine(buf.trim());
      buf = '';
    });
  }

  type ExitInfo = { code: number | null; error?: Error };
  const exitRef: { value: ExitInfo | null } = { value: null };
  child.once('error', (e) => {
    exitRef.value = { code: null, error: e };
    stream.close();
  });
  child.once('close', (code) => {
    exitRef.value = { code };
    stream.close();
  });

  // External-event forwarding: pump items from externalEvents into stream.
  let externalPump: Promise<void> | null = null;
  if (args.externalEvents) {
    const ext = args.externalEvents;
    externalPump = (async () => {
      while (true) {
        const r = await ext.next();
        if (r.done) return;
        stream.push(r.value);
      }
    })();
  }

  try {
    while (true) {
      const r = await stream.next();
      if (r.done) break;
      yield r.value;
    }
  } finally {
    if (args.signal) args.signal.removeEventListener('abort', onAbort);
    if (args.onClose) {
      try {
        await args.onClose();
      } catch {
        /* noop */
      }
    }
    if (externalPump) {
      try {
        await externalPump;
      } catch {
        /* noop */
      }
    }
  }

  const code = exitRef.value?.code ?? null;
  const aborted = args.signal?.aborted ?? false;
  if (exitRef.value?.error) throw exitRef.value.error;

  if (!permissionFailure && code !== 0 && !aborted) {
    if (PERMISSION_RX.test(stderr)) permissionFailure = true;
  }

  if (permissionFailure && observedSessionId) {
    throw new PermissionRequiredError(
      observedSessionId,
      args.cwd,
      buildResumeCommand(args.cwd, observedSessionId),
      code,
      stderr.slice(-2000),
    );
  }

  if (code !== 0 && !aborted) {
    throw new AdapterFailedError(`claude exited with code ${code}`, code, stderr.slice(-2000));
  }
}

function parseLine(line: string): { msg: AgentMessage; raw: Record<string, unknown> } | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = normalizeType(obj['type']);
  const sessionId =
    typeof obj['session_id'] === 'string'
      ? (obj['session_id'] as string)
      : typeof obj['sessionId'] === 'string'
        ? (obj['sessionId'] as string)
        : '';
  if (!type) return null;
  return {
    msg: {
      type,
      sessionId,
      content: obj['message'] ?? obj['content'] ?? obj['result'] ?? obj,
      raw: obj,
    },
    raw: obj,
  };
}

function normalizeType(t: unknown): AgentMessageType | null {
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'assistant':
    case 'user':
    case 'system':
    case 'result':
    case 'tool_use':
    case 'tool_result':
      return t;
    default:
      return null;
  }
}
