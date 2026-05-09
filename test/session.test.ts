import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSuperconnector } from '../src/index.js';
import type { Adapter, AgentMessage, ResumeOptions, SpawnOptions } from '../src/types.js';
import { UnknownSessionError } from '../src/errors.js';

class StubAdapter implements Adapter {
  readonly kind = 'claude-code' as const;
  spawnCalls: SpawnOptions[] = [];
  resumeCalls: ResumeOptions[] = [];
  nextSessionId = 'stub-sess-1';

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
      yield { type: 'assistant', sessionId: sid, content: { text: 'resumed' } } satisfies AgentMessage;
      yield { type: 'result', sessionId: sid, content: { ok: true } } satisfies AgentMessage;
    })();
  }
}

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sc-home-'));
  process.env.SUPERCONNECTOR_HOME = home;
  return home;
}

test('spawn streams messages and records the session', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = createSuperconnector({ adapter, cwd });

  const types: string[] = [];
  for await (const m of sc.spawn({ prompt: 'go', appLabel: 'myapp' })) {
    types.push(m.type);
  }
  assert.deepEqual(types, ['system', 'assistant', 'result']);
  const sessions = sc.listSessions({ appLabel: 'myapp' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, 'stub-sess-1');
});

test('resume rejects unknown sessionId', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = createSuperconnector({ adapter, cwd });

  await assert.rejects(async () => {
    for await (const _ of sc.resume({ prompt: 'x', appLabel: 'app', sessionId: 'nope' })) {
      // should not yield
    }
  }, UnknownSessionError);
});

test('resume works for a session this app created', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = createSuperconnector({ adapter, cwd });

  for await (const _ of sc.spawn({ prompt: 'go', appLabel: 'app' })) {
    // drain
  }
  const [latest] = sc.listSessions({ appLabel: 'app' });
  assert.ok(latest);

  const types: string[] = [];
  for await (const m of sc.resume({
    prompt: 'continue',
    appLabel: 'app',
    sessionId: latest!.sessionId,
  })) {
    types.push(m.type);
  }
  assert.deepEqual(types, ['assistant', 'result']);
  assert.equal(adapter.resumeCalls.length, 1);
  assert.equal(adapter.resumeCalls[0]!.sessionId, 'stub-sess-1');
});

test('resumeLastCreatedSession=true resumes prior session if any', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = createSuperconnector({ adapter, cwd });

  for await (const _ of sc.spawn({ prompt: 'first', appLabel: 'app' })) { /* drain */ }
  adapter.nextSessionId = 'stub-sess-2';

  for await (const _ of sc.spawn({
    prompt: 'second',
    appLabel: 'app',
    resumeLastCreatedSession: true,
  })) { /* drain */ }

  assert.equal(adapter.resumeCalls.length, 1);
  assert.equal(adapter.resumeCalls[0]!.sessionId, 'stub-sess-1');
  assert.equal(adapter.spawnCalls.length, 1);
});

test('resumeLastCreatedSession=true falls back to spawn when no prior session', async () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const adapter = new StubAdapter();
  const sc = createSuperconnector({ adapter, cwd });

  for await (const _ of sc.spawn({
    prompt: 'first',
    appLabel: 'fresh',
    resumeLastCreatedSession: true,
  })) { /* drain */ }

  assert.equal(adapter.spawnCalls.length, 1);
  assert.equal(adapter.resumeCalls.length, 0);
});

test('setAdapter overrides adapter', () => {
  isolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
  const sc = createSuperconnector({ adapter: new StubAdapter(), cwd });
  sc.setAdapter('codex');
  assert.equal(sc.getAdapter().kind, 'codex');
});
