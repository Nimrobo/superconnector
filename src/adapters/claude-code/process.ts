import { spawn, type ChildProcess } from 'node:child_process';
import { AdapterFailedError } from '../../errors.js';
import type { AgentMessage, AgentMessageType } from '../../types.js';

export interface RunArgs {
  binPath: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
}

export async function* runClaude(args: RunArgs): AsyncIterable<AgentMessage> {
  const child: ChildProcess = spawn(args.binPath, args.args, {
    cwd: args.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
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

  const exitPromise = new Promise<{ code: number | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code }));
  });

  let buf = '';
  const stdout = child.stdout;
  if (!stdout) {
    throw new AdapterFailedError('claude child has no stdout', null, '');
  }
  stdout.setEncoding('utf8');

  try {
    for await (const chunk of stdout) {
      buf += chunk as string;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = parseLine(line);
        if (msg) yield msg;
      }
    }
    if (buf.trim()) {
      const msg = parseLine(buf.trim());
      if (msg) yield msg;
    }
  } finally {
    if (args.signal) args.signal.removeEventListener('abort', onAbort);
  }

  const { code } = await exitPromise;
  if (code !== 0 && !args.signal?.aborted) {
    throw new AdapterFailedError(
      `claude exited with code ${code}`,
      code,
      stderr.slice(-2000),
    );
  }
}

function parseLine(line: string): AgentMessage | null {
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
    type,
    sessionId,
    content: obj['message'] ?? obj['content'] ?? obj['result'] ?? obj,
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
