import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSuperconnector } from '../src/index.js';
import { recordSpawn } from '../src/registry.js';
import type {
  Adapter,
  AdapterKind,
  AgentMessage,
  ResumeOptions,
  SpawnOptions,
} from '../src/types.js';
import { UnknownSessionError } from '../src/errors.js';
import { withProcessCwd } from './test-util.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(here, 'fake-codex.mjs');

class StubAdapter implements Adapter {
  readonly kind: AdapterKind;
  spawnCalls: SpawnOptions[] = [];
  resumeCalls: ResumeOptions[] = [];
  nextSessionId = 'stub-sess-1';

  constructor(kind: AdapterKind = 'claude-code') {
    this.kind = kind;
  }

  detect(_cwd: string): boolean {
    return false;
  }

  spawn(opts: SpawnOptions, _cwd: string): AsyncIterable<AgentMessage> {
    this.spawnCalls.push(opts);
    const sid = this.nextSessionId;
    return (async function* () {
      yield { type: 'system', sessionId: sid, content: { hello: true } } satisfies AgentMessage;
      yield { type: 'assistant', sessionId: sid, content: { text: 'hi' } } satisfies AgentMessage;
      yield { type: 'result', sessionId: sid, content: { ok: true } } satisfies AgentMessage;
    })();
  }

  resume(opts: ResumeOptions, _cwd: string): AsyncIterable<AgentMessage> {
    this.resumeCalls.push(opts);
    const sid = opts.sessionId;
    return (async function* () {
      yield {
        type: 'assistant',
        sessionId: sid,
        content: { text: 'resumed' },
      } satisfies AgentMessage;
      yield { type: 'result', sessionId: sid, content: { ok: true } } satisfies AgentMessage;
    })();
  }
}

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sc-home-'));
  process.env.SUPERCONNECTOR_HOME = home;
  return home;
}

async function drain(iterable: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const msg of iterable) out.push(msg);
  return out;
}

test('spawn streams messages and records the session', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));

  const types: string[] = [];
  for await (const m of sc.spawn({ prompt: 'go', appId: 'myapp' })) {
    types.push(m.type);
  }
  assert.deepEqual(types, ['system', 'assistant', 'result']);
  const sessions = sc.listSessions({ appId: 'myapp' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, 'stub-sess-1');
});

test('resume rejects unknown sessionId', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));

  await assert.rejects(async () => {
    for await (const _ of sc.resume({ prompt: 'x', appId: 'app', sessionId: 'nope' })) {
      // should not yield
    }
  }, UnknownSessionError);
});

test('resume works for a session this app created', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));

  for await (const _ of sc.spawn({ prompt: 'go', appId: 'app' })) {
    // drain
  }
  const [latest] = sc.listSessions({ appId: 'app' });
  assert.ok(latest);

  const types: string[] = [];
  for await (const m of sc.resume({
    prompt: 'continue',
    appId: 'app',
    sessionId: latest!.sessionId,
  })) {
    types.push(m.type);
  }
  assert.deepEqual(types, ['assistant', 'result']);
  assert.equal(adapter.resumeCalls.length, 1);
  assert.equal(adapter.resumeCalls[0]!.sessionId, 'stub-sess-1');
});

test('resume uses the adapter recorded for the session, not the current adapter', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const original = new StubAdapter('claude-code');
  const current = new StubAdapter('codex');
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter: original, cwd }));

  await drain(sc.spawn({ prompt: 'go', appId: 'app' }));
  sc.setAdapter(current);
  await drain(sc.resume({ prompt: 'continue', appId: 'app', sessionId: 'stub-sess-1' }));

  assert.equal(original.resumeCalls.length, 1);
  assert.equal(original.resumeCalls[0]!.sessionId, 'stub-sess-1');
  assert.equal(current.resumeCalls.length, 0);
});

test('resume rejects a session when provided sessionSelector does not match', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));

  for await (const _ of sc.spawn({ prompt: 'go', appId: 'app', sessionSelector: 'thread-a' })) {
    // drain
  }
  const [latest] = sc.listSessions({ appId: 'app' });
  assert.ok(latest);

  await assert.rejects(async () => {
    for await (const _ of sc.resume({
      prompt: 'continue',
      appId: 'app',
      sessionId: latest!.sessionId,
      sessionSelector: 'thread-b',
    })) {
      // should not yield
    }
  }, UnknownSessionError);
  assert.equal(adapter.resumeCalls.length, 0);
});

test('resumeLastCreatedSession=true resumes prior session if any', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));

  for await (const _ of sc.spawn({ prompt: 'first', appId: 'app' })) {
    /* drain */
  }
  adapter.nextSessionId = 'stub-sess-2';

  for await (const _ of sc.spawn({
    prompt: 'second',
    appId: 'app',
    resumeLastCreatedSession: true,
  })) {
    /* drain */
  }

  assert.equal(adapter.resumeCalls.length, 1);
  assert.equal(adapter.resumeCalls[0]!.sessionId, 'stub-sess-1');
  assert.equal(adapter.spawnCalls.length, 1);
});

test('resumeLastCreatedSession=true uses the adapter recorded for the session', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const original = new StubAdapter('claude-code');
  const current = new StubAdapter('codex');
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter: original, cwd }));

  await drain(sc.spawn({ prompt: 'first', appId: 'app' }));
  sc.setAdapter(current);
  await drain(
    sc.spawn({
      prompt: 'second',
      appId: 'app',
      resumeLastCreatedSession: true,
    }),
  );

  assert.equal(original.resumeCalls.length, 1);
  assert.equal(original.resumeCalls[0]!.sessionId, 'stub-sess-1');
  assert.equal(current.resumeCalls.length, 0);
  assert.equal(current.spawnCalls.length, 0);
});

test('resumeLastCreatedSession=true is scoped by sessionSelector', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));

  for await (const _ of sc.spawn({ prompt: 'first', appId: 'app', sessionSelector: 'thread-a' })) {
    /* drain */
  }
  adapter.nextSessionId = 'stub-sess-2';
  for await (const _ of sc.spawn({ prompt: 'second', appId: 'app', sessionSelector: 'thread-b' })) {
    /* drain */
  }
  adapter.nextSessionId = 'stub-sess-3';

  for await (const _ of sc.spawn({
    prompt: 'third',
    appId: 'app',
    sessionSelector: 'thread-a',
    resumeLastCreatedSession: true,
  })) {
    /* drain */
  }

  assert.equal(adapter.resumeCalls.length, 1);
  assert.equal(adapter.resumeCalls[0]!.sessionId, 'stub-sess-1');
  assert.equal(adapter.resumeCalls[0]!.sessionSelector, 'thread-a');
  assert.equal(adapter.spawnCalls.length, 2);
});

test('resumeLastCreatedSession=true without selector ignores selector-scoped sessions', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));

  for await (const _ of sc.spawn({ prompt: 'first', appId: 'app', sessionSelector: 'thread-a' })) {
    /* drain */
  }
  adapter.nextSessionId = 'stub-sess-2';

  for await (const _ of sc.spawn({
    prompt: 'second',
    appId: 'app',
    resumeLastCreatedSession: true,
  })) {
    /* drain */
  }

  assert.equal(adapter.resumeCalls.length, 0);
  assert.equal(adapter.spawnCalls.length, 2);
});

test('resumeLastCreatedSession=true falls back to spawn when no prior session', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter, cwd }));

  for await (const _ of sc.spawn({
    prompt: 'first',
    appId: 'fresh',
    resumeLastCreatedSession: true,
  })) {
    /* drain */
  }

  assert.equal(adapter.spawnCalls.length, 1);
  assert.equal(adapter.resumeCalls.length, 0);
});

test('resume rebuilds a recorded built-in adapter when it is not cached', async () => {
  const home = isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const current = new StubAdapter('claude-code');
  const prevCodexBin = process.env.CODEX_BIN;
  const prevScenario = process.env.SCENARIO;

  process.env.CODEX_BIN = FAKE_CODEX;
  process.env.SCENARIO = 'ok';
  recordSpawn(
    {
      cwd: realpathSync(cwd),
      appId: 'app',
      adapter: 'codex',
      sessionId: 'codex-recorded',
    },
    { root: home, file: join(home, 'registry.json') },
  );

  try {
    const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter: current, cwd }));
    const messages = await drain(
      sc.resume({
        prompt: 'continue',
        appId: 'app',
        sessionId: 'codex-recorded',
      }),
    );

    assert.equal(current.resumeCalls.length, 0);
    assert.deepEqual(
      messages.map((m) => m.type),
      ['system', 'assistant', 'tool_use', 'tool_result', 'result'],
    );
    assert.equal(messages[0]!.sessionId, 'codex-recorded');
  } finally {
    if (prevCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prevCodexBin;
    if (prevScenario === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prevScenario;
  }
});

test('setAdapter overrides adapter', () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const sc = withProcessCwd(cwd, () => createSuperconnector({ adapter: new StubAdapter(), cwd }));
  sc.setAdapter('codex');
  assert.equal(sc.getAdapter().kind, 'codex');
});
