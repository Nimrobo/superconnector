import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createSuperconnector } from '../src/index.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { runClaude } from '../src/adapters/claude-code/process.js';
import { startApprovalHost } from '../src/approval/host.js';
import { sessionLogPath, readSessionLog } from '../src/registry.js';
import { PermissionRequiredError } from '../src/errors.js';
import type { Adapter, AgentMessage, ResumeOptions, SpawnOptions } from '../src/types.js';
import { withProcessCwd } from './test-util.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'fake-claude.mjs');

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sc-home-'));
  process.env.SUPERCONNECTOR_HOME = home;
  return home;
}

function withArgsFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(mkdtempSync(join(tmpdir(), 'claude-args-')), 'args');
  const prev = process.env.FAKE_ARGS_FILE;
  process.env.FAKE_ARGS_FILE = path;
  return fn(path).finally(() => {
    if (prev === undefined) delete process.env.FAKE_ARGS_FILE;
    else process.env.FAKE_ARGS_FILE = prev;
    if (existsSync(path)) unlinkSync(path);
  });
}

function readArgs(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n');
}

class MetaStubAdapter implements Adapter {
  readonly kind = 'claude-code' as const;
  nextSessionId = 'meta-sess-1';
  detect(_cwd: string): boolean {
    return false;
  }
  spawn(_opts: SpawnOptions, cwd: string): AsyncIterable<AgentMessage> {
    const sid = this.nextSessionId;
    return (async function* () {
      yield {
        type: 'superconnector',
        sessionId: '',
        content: {
          subtype: 'spawn_meta',
          pid: 9999,
          binPath: '/fake/claude',
          args: ['-p', 'go', '--permission-mode', 'acceptEdits'],
          cwd,
        },
      } satisfies AgentMessage;
      yield { type: 'system', sessionId: sid, content: { ok: true } } satisfies AgentMessage;
      yield { type: 'assistant', sessionId: sid, content: { text: 'hi' } } satisfies AgentMessage;
      yield { type: 'result', sessionId: sid, content: { ok: true } } satisfies AgentMessage;
    })();
  }
  resume(opts: ResumeOptions, _cwd: string): AsyncIterable<AgentMessage> {
    const sid = opts.sessionId;
    return (async function* () {
      yield { type: 'result', sessionId: sid, content: { ok: true } } satisfies AgentMessage;
    })();
  }
}

test('session log is written with metadata after spawn', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter: new MetaStubAdapter(), cwd }));

  const seenTypes: string[] = [];
  for await (const m of sc.spawn({ prompt: 'hello world', appId: 'app' })) {
    seenTypes.push(m.type);
  }
  // spawn_meta should be intercepted, not surfaced
  assert.ok(!seenTypes.includes('superconnector'));

  const log = readSessionLog('meta-sess-1');
  assert.ok(log, 'session log should exist');
  assert.equal(log!.sessionId, 'meta-sess-1');
  assert.equal(log!.cwd, realpathSync(cwd));
  assert.equal(log!.binPath, '/fake/claude');
  assert.equal(log!.permissionMode, 'acceptEdits');
  assert.equal(log!.approvalServerEnabled, false);
  assert.equal(log!.pid, 9999);
  assert.equal(log!.exitCode, 0);
  assert.ok(log!.closedAt);
  assert.match(log!.resumeCommand, /claude --resume/);
  assert.equal(log!.permissionFailure, false);
  assert.equal(log!.promptPreview, 'hello world');
});

test('PermissionRequiredError thrown by adapter is recorded in session log', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));

  class FailingAdapter implements Adapter {
    readonly kind = 'claude-code' as const;
    detect(_cwd: string): boolean {
      return false;
    }
    spawn(_o: SpawnOptions, c: string): AsyncIterable<AgentMessage> {
      return (async function* () {
        yield {
          type: 'superconnector',
          sessionId: '',
          content: { subtype: 'spawn_meta', pid: 1, binPath: '/x', args: [], cwd: c },
        } satisfies AgentMessage;
        yield { type: 'system', sessionId: 'fail-sess', content: {} } satisfies AgentMessage;
        throw new PermissionRequiredError(
          'fail-sess',
          c,
          `(cd '${c}' && claude --resume 'fail-sess')`,
          1,
          'permission denied tail',
        );
      })();
    }
    resume(): AsyncIterable<AgentMessage> {
      throw new Error('not used');
    }
  }

  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter: new FailingAdapter(), cwd }));
  await assert.rejects(
    async () => {
      for await (const _ of sc.spawn({ prompt: 'p', appId: 'app' })) {
        /* drain */
      }
    },
    PermissionRequiredError,
  );

  const log = readSessionLog('fail-sess');
  assert.ok(log, 'log written before failure');
  assert.equal(log!.permissionFailure, true);
  assert.match(log!.resumeCommand, /--resume 'fail-sess'/);
  assert.equal(log!.stderrTail, 'permission denied tail');
});

test('runClaude detects permission-result and throws PermissionRequiredError', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const prev = process.env.SCENARIO;
  process.env.SCENARIO = 'permission-result';
  try {
    const it = runClaude({
      binPath: FAKE_CLAUDE,
      args: [],
      cwd,
    });
    const saw: AgentMessage[] = [];
    let err: unknown = null;
    try {
      for await (const m of it) saw.push(m);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof PermissionRequiredError, 'should throw permission error');
    const pe = err as PermissionRequiredError;
    assert.equal(pe.sessionId, 'fake-sess-1');
    assert.match(pe.resumeCommand, /claude --resume/);
    assert.equal(saw[0]!.type, 'superconnector'); // spawn_meta
    const permMsg = saw.find(
      (m) =>
        m.type === 'superconnector' &&
        (m.content as { subtype?: string } | null)?.subtype === 'permission_required',
    );
    assert.ok(permMsg, 'permission_required message emitted');
  } finally {
    if (prev === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prev;
  }
});

test('runClaude ok scenario yields normal stream and exits cleanly', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const prev = process.env.SCENARIO;
  process.env.SCENARIO = 'ok';
  try {
    const types: string[] = [];
    for await (const m of runClaude({
      binPath: FAKE_CLAUDE,
      args: [],
      cwd,
    })) {
      types.push(m.type);
    }
    assert.equal(types[0], 'superconnector'); // spawn_meta
    assert.ok(types.includes('system'));
    assert.ok(types.includes('assistant'));
    assert.ok(types.includes('result'));
  } finally {
    if (prev === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prev;
  }
});

test('runClaude ignores malformed/unknown lines and handles partial large stream chunks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const prev = process.env.SCENARIO;
  process.env.SCENARIO = 'malformed-stream';
  try {
    const msgs: AgentMessage[] = [];
    for await (const m of runClaude({
      binPath: FAKE_CLAUDE,
      args: [],
      cwd,
    })) {
      msgs.push(m);
    }
    assert.deepEqual(
      msgs.map((m) => m.type),
      ['superconnector', 'system', 'assistant', 'assistant', 'result'],
    );
    assert.equal((msgs[2]!.content as { content?: string }).content, 'partial');
    assert.equal((msgs[3]!.content as { content?: string }).content?.length, 8192);
  } finally {
    if (prev === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prev;
  }
});

test('runClaude stops cleanly when aborted', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const prev = process.env.SCENARIO;
  process.env.SCENARIO = 'slow';
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  try {
    const msgs: AgentMessage[] = [];
    for await (const m of runClaude({
      binPath: FAKE_CLAUDE,
      args: [],
      cwd,
      signal: ctrl.signal,
    })) {
      msgs.push(m);
    }
    assert.ok(ctrl.signal.aborted);
    assert.ok(msgs.some((m) => m.type === 'superconnector'));
  } finally {
    if (prev === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prev;
  }
});

// --- Approval host tests ----------------------------------------------------
//
// These test the parent-side IPC host directly by simulating the child
// connecting over TCP and exchanging the same protocol the bundled MCP server
// uses. This avoids depending on a running claude binary.

interface ChildLink {
  send: (id: number, request: unknown) => void;
  recv: () => Promise<{ id: number; decision: { decision: 'allow' | 'deny'; message?: string } }>;
  end: () => void;
}

async function connectChild(port: number, token: string): Promise<ChildLink> {
  const sock = net.createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', reject);
  });
  sock.write(`${JSON.stringify({ type: 'hello', token })}\n`);

  let buf = '';
  const queue: Array<{ id: number; decision: { decision: 'allow' | 'deny'; message?: string } }> = [];
  const waiters: Array<(v: { id: number; decision: { decision: 'allow' | 'deny'; message?: string } }) => void> = [];
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      const w = waiters.shift();
      if (w) w(obj);
      else queue.push(obj);
    }
  });

  return {
    send: (id, request) => sock.write(`${JSON.stringify({ id, request })}\n`),
    recv: () =>
      new Promise((resolve) => {
        const v = queue.shift();
        if (v) resolve(v);
        else waiters.push(resolve);
      }),
    end: () => sock.destroy(),
  };
}

function readMcpConfig(path: string): { port: number; token: string } {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as {
    mcpServers: { superconnector: { env: Record<string, string> } };
  };
  const env = cfg.mcpServers.superconnector.env;
  return { port: Number(env.SUPERCONNECTOR_IPC_PORT), token: env.SUPERCONNECTOR_IPC_TOKEN! };
}

test('approval host: callback returning allow is delivered to child', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const decisions: string[] = [];
  const host = await startApprovalHost({
    callback: async () => ({ decision: 'allow' }),
    sessionId: 'sess-A',
    cwd,
    timeoutMs: 5000,
    onDecision: (_req, dec, reason) => decisions.push(`${dec.decision}:${reason}`),
  });

  const { port, token } = readMcpConfig(host.mcpConfigPath);
  const child = await connectChild(port, token);
  child.send(1, { sessionId: 'sess-A', cwd, toolName: 'Bash', input: { cmd: 'ls' } });
  const resp = await child.recv();
  assert.equal(resp.id, 1);
  assert.equal(resp.decision.decision, 'allow');
  assert.deepEqual(decisions, ['allow:callback']);

  child.end();
  await host.dispose();
  assert.ok(!existsSync(host.mcpConfigPath), 'config file cleaned up');
});

test('approval host: callback returning deny is delivered with message', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const host = await startApprovalHost({
    callback: async () => ({ decision: 'deny', message: 'nope' }),
    sessionId: 'sess-B',
    cwd,
    timeoutMs: 5000,
  });
  const { port, token } = readMcpConfig(host.mcpConfigPath);
  const child = await connectChild(port, token);
  child.send(7, { sessionId: 'sess-B', cwd, toolName: 'Write', input: { path: '/x' } });
  const resp = await child.recv();
  assert.equal(resp.id, 7);
  assert.equal(resp.decision.decision, 'deny');
  assert.equal(resp.decision.message, 'nope');

  child.end();
  await host.dispose();
});

test('approval host: callback that hangs times out and returns deny', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const timeouts: string[] = [];
  const host = await startApprovalHost({
    callback: () => new Promise(() => { /* never resolves */ }),
    sessionId: 'sess-T',
    cwd,
    timeoutMs: 80,
    onTimeout: (toolName) => timeouts.push(toolName),
  });
  const { port, token } = readMcpConfig(host.mcpConfigPath);
  const child = await connectChild(port, token);
  child.send(2, { sessionId: 'sess-T', cwd, toolName: 'Bash', input: {} });
  const resp = await child.recv();
  assert.equal(resp.decision.decision, 'deny');
  assert.match(resp.decision.message ?? '', /timed out/);
  assert.deepEqual(timeouts, ['Bash']);
  child.end();
  await host.dispose();
});

test('approval host: bad token closes the socket', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const host = await startApprovalHost({
    callback: async () => ({ decision: 'allow' }),
    sessionId: 'sess-X',
    cwd,
    timeoutMs: 5000,
  });
  const { port } = readMcpConfig(host.mcpConfigPath);
  const sock = net.createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((r) => sock.once('connect', () => r()));
  sock.write(`${JSON.stringify({ type: 'hello', token: 'wrong' })}\n`);
  await new Promise<void>((r) => sock.once('close', () => r()));
  await host.dispose();
});

// --- ClaudeCodeAdapter integration -----------------------------------------

test('ClaudeCodeAdapter spawn writes session log + appends --permission-mode flag', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const prev = process.env.SCENARIO;
  process.env.SCENARIO = 'ok';
  process.env.FAKE_SESSION_ID = 'adapter-sess-1';
  try {
    const adapter = new ClaudeCodeAdapter({ binPath: FAKE_CLAUDE });
    const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));
    for await (const _ of sc.spawn({ prompt: 'hi', appId: 'app' })) {
      /* drain */
    }
    const log = readSessionLog('adapter-sess-1');
    assert.ok(log);
    assert.ok(log!.args.includes('--permission-mode'));
    assert.ok(log!.args.includes('acceptEdits'));
    assert.equal(log!.permissionMode, 'acceptEdits');
    assert.equal(log!.approvalServerEnabled, false);
    assert.ok(existsSync(sessionLogPath('adapter-sess-1')));
  } finally {
    if (prev === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prev;
    delete process.env.FAKE_SESSION_ID;
  }
});

test('ClaudeCodeAdapter with permissionMode "read" passes plan flag', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const prev = process.env.SCENARIO;
  process.env.SCENARIO = 'ok';
  process.env.FAKE_SESSION_ID = 'adapter-sess-2';
  try {
    const adapter = new ClaudeCodeAdapter({ binPath: FAKE_CLAUDE });
    const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));
    for await (const _ of sc.spawn({ prompt: 'r', appId: 'app', permissionMode: 'read' })) {
      /* drain */
    }
    const log = readSessionLog('adapter-sess-2');
    assert.ok(log);
    assert.ok(log!.args.includes('plan'), 'plan flag injected for read mode');
    assert.equal(log!.permissionMode, 'read');
  } finally {
    if (prev === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prev;
    delete process.env.FAKE_SESSION_ID;
  }
});

test('ClaudeCodeAdapter appends configured model and does not duplicate explicit model args', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const prevScenario = process.env.SCENARIO;
  process.env.SCENARIO = 'ok';
  try {
    await withArgsFile(async (argsPath) => {
      const adapter = new ClaudeCodeAdapter({
        binPath: FAKE_CLAUDE,
        model: 'sonnet-test',
      });
      for await (const _ of adapter.spawn({ prompt: 'm', appId: 'app' }, cwd)) {
        /* drain */
      }
      const args = readArgs(argsPath);
      const modelIdx = args.indexOf('--model');
      assert.ok(modelIdx >= 0);
      assert.equal(args[modelIdx + 1], 'sonnet-test');
    });

    await withArgsFile(async (argsPath) => {
      const adapter = new ClaudeCodeAdapter({
        binPath: FAKE_CLAUDE,
        model: 'sonnet-test',
        extraArgs: ['--model', 'opus-test'],
      });
      for await (const _ of adapter.spawn({ prompt: 'm', appId: 'app' }, cwd)) {
        /* drain */
      }
      const args = readArgs(argsPath);
      assert.equal(args.filter((a) => a === '--model').length, 1);
      assert.ok(args.includes('opus-test'));
      assert.ok(!args.includes('sonnet-test'));
    });
  } finally {
    if (prevScenario === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prevScenario;
  }
});

test('ClaudeCodeAdapter resume includes --resume session id and prompt', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const prevScenario = process.env.SCENARIO;
  process.env.SCENARIO = 'ok';
  try {
    await withArgsFile(async (argsPath) => {
      const adapter = new ClaudeCodeAdapter({ binPath: FAKE_CLAUDE });
      for await (const _ of adapter.resume({
        prompt: 'continue',
        appId: 'app',
        sessionId: 'claude-sess-1',
      }, cwd)) {
        /* drain */
      }
      const args = readArgs(argsPath);
      const promptIdx = args.indexOf('-p');
      const resumeIdx = args.indexOf('--resume');
      assert.ok(promptIdx >= 0);
      assert.equal(args[promptIdx + 1], 'continue');
      assert.ok(resumeIdx >= 0);
      assert.equal(args[resumeIdx + 1], 'claude-sess-1');
    });
  } finally {
    if (prevScenario === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prevScenario;
  }
});

test('ClaudeCodeAdapter with onApprovalRequest enables approval server', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const prev = process.env.SCENARIO;
  process.env.SCENARIO = 'ok';
  process.env.FAKE_SESSION_ID = 'adapter-sess-3';
  try {
    const adapter = new ClaudeCodeAdapter({ binPath: FAKE_CLAUDE });
    const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));
    for await (const _ of sc.spawn({
      prompt: 'a',
      appId: 'app',
      onApprovalRequest: async () => ({ decision: 'allow' }),
    })) {
      /* drain */
    }
    const log = readSessionLog('adapter-sess-3');
    assert.ok(log);
    assert.equal(log!.approvalServerEnabled, true);
    assert.ok(log!.args.includes('--permission-prompt-tool'));
    assert.ok(log!.args.includes('--mcp-config'));
  } finally {
    if (prev === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prev;
    delete process.env.FAKE_SESSION_ID;
  }
});
