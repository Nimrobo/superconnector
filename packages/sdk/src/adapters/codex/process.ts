import { spawn, type ChildProcess } from 'node:child_process';
import { AdapterFailedError } from '../../errors.js';
import type { AgentMessage, AgentMessageType } from '../../types.js';
import { EventQueue } from '../../util/event-queue.js';

export interface RunCodexArgs {
  binPath: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildCodexResumeCommand(cwd: string, sessionId: string): string {
  return `(cd ${shellQuote(cwd)} && codex exec resume ${shellQuote(sessionId)})`;
}

export async function* runCodex(args: RunCodexArgs): AsyncIterable<AgentMessage> {
  const child: ChildProcess = spawn(args.binPath, args.args, {
    cwd: args.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const stream = new EventQueue<AgentMessage>();

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
  let buf = '';
  let stdoutEnded = !child.stdout;
  let childClosed = false;
  const maybeCloseStream = () => {
    if (childClosed && stdoutEnded) stream.close();
  };
  const flushLine = (line: string) => {
    if (!line) return;
    const parsed = parseLine(line);
    if (!parsed) return;
    if (!observedSessionId && parsed.msg.sessionId) {
      observedSessionId = parsed.msg.sessionId;
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
      stdoutEnded = true;
      maybeCloseStream();
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
    childClosed = true;
    maybeCloseStream();
  });

  try {
    while (true) {
      const r = await stream.next();
      if (r.done) break;
      yield r.value;
    }
  } finally {
    if (args.signal) args.signal.removeEventListener('abort', onAbort);
  }

  const code = exitRef.value?.code ?? null;
  const aborted = args.signal?.aborted ?? false;
  if (exitRef.value?.error) throw exitRef.value.error;

  if (code !== 0 && !aborted) {
    throw new AdapterFailedError(`codex exited with code ${code}`, code, stderr.slice(-2000));
  }
  if (!observedSessionId && !aborted) {
    throw new AdapterFailedError('codex exited without emitting a session id', code, stderr.slice(-2000));
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
  const sessionId = readSessionId(obj);
  if (!type) return null;

  return {
    msg: {
      type,
      sessionId,
      content: readContent(obj),
      raw: obj,
    },
    raw: obj,
  };
}

function readSessionId(obj: Record<string, unknown>): string {
  const candidates = [obj['thread_id'], obj['session_id'], obj['sessionId'], obj['threadId']];
  for (const c of candidates) {
    if (typeof c === 'string') return c;
  }
  return '';
}

function readContent(obj: Record<string, unknown>): unknown {
  return obj['message'] ?? obj['content'] ?? obj['item'] ?? obj['text'] ?? obj['delta'] ?? obj;
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
    case 'thread.started':
    case 'codex.thread.started':
    case 'turn.started':
      return 'system';
    case 'agent_message':
    case 'agent_message_delta':
    case 'assistant.message':
    case 'response.output_text.delta':
      return 'assistant';
    case 'task_complete':
    case 'turn.completed':
    case 'turn.failed':
      return 'result';
    default:
      if (t.startsWith('item.')) {
        if (t.includes('completed') || t.includes('output')) return 'tool_result';
        return 'tool_use';
      }
      return 'system';
  }
}
