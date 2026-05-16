import { spawn, type ChildProcess } from 'node:child_process';
import { AdapterFailedError } from '../../errors.js';
import type { AgentMessage, AgentMessageType } from '../../types.js';
import { EventQueue } from '../../util/event-queue.js';

export interface RunArgs {
  binPath: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  onClose?: () => void | Promise<void>;
}

export async function* runOpenCode(args: RunArgs): AsyncIterable<AgentMessage> {
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

  let killTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    if (!child.killed) child.kill('SIGTERM');
    // Escalate to SIGKILL if the child ignores SIGTERM, so an aborted run
    // can never leave a process lingering. unref() keeps this timer from
    // holding the event loop open on its own.
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 2000);
    killTimer.unref();
    // Stop the consumer promptly rather than waiting for the child's
    // 'close' event — a wedged child must not stall iteration.
    stream.close();
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
    stream.push(parsed);
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
    if (killTimer) clearTimeout(killTimer);
    if (args.onClose) {
      try {
        await args.onClose();
      } catch {
        /* noop */
      }
    }
  }

  const code = exitRef.value?.code ?? null;
  const aborted = args.signal?.aborted ?? false;
  if (exitRef.value?.error) throw exitRef.value.error;
  if (code !== 0 && !aborted) {
    throw new AdapterFailedError(`opencode exited with code ${code}`, code, stderr.slice(-2000));
  }
}

function parseLine(line: string): AgentMessage | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = mapType(obj['type']);
  if (!type) return null;
  const sessionId =
    typeof obj['sessionID'] === 'string'
      ? (obj['sessionID'] as string)
      : typeof obj['session_id'] === 'string'
        ? (obj['session_id'] as string)
        : '';
  return {
    type,
    sessionId,
    content: obj['part'] ?? obj,
    raw: obj,
  };
}

function mapType(t: unknown): AgentMessageType | null {
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'text':
      return 'assistant';
    case 'tool_use':
      return 'tool_use';
    case 'step_start':
      return 'system';
    case 'step_finish':
      return 'result';
    default:
      return null;
  }
}
