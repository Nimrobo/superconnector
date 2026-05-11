import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLatestSession,
  listSessions,
  recordResume,
  recordSpawn,
  type RegistryPaths,
} from '../src/registry.js';

function paths(): RegistryPaths {
  const root = mkdtempSync(join(tmpdir(), 'sc-reg-'));
  return { root, file: join(root, 'registry.json') };
}

test('recordSpawn then listSessions returns the record', () => {
  const p = paths();
  const cwd = '/tmp/proj-a';
  recordSpawn({ cwd, appId: 'app1', adapter: 'claude-code', sessionId: 'sess-1' }, p);
  const sessions = listSessions({ cwd, appId: 'app1' }, p);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, 'sess-1');
  assert.equal(sessions[0]!.adapter, 'claude-code');
});

test('recordSpawn groups selectors under one app entry in v2 registry', () => {
  const p = paths();
  const cwd = '/tmp/proj-selectors';
  recordSpawn({
    cwd,
    appId: 'app',
    adapter: 'claude-code',
    sessionId: 'sess-a',
    sessionSelector: 'thread-a',
  }, p);
  recordSpawn({
    cwd,
    appId: 'app',
    adapter: 'codex',
    sessionId: 'sess-b',
    sessionSelector: 'thread-b',
  }, p);

  const raw = JSON.parse(readFileSync(p.file, 'utf8')) as {
    version: number;
    apps: Array<{ cwd: string; appId: string; adapter?: string; sessions: Array<{ sessionId: string; sessionSelector?: string }> }>;
  };
  assert.equal(raw.version, 2);
  assert.equal(raw.apps.length, 1);
  assert.equal(raw.apps[0]!.cwd, cwd);
  assert.equal(raw.apps[0]!.appId, 'app');
  assert.equal(raw.apps[0]!.adapter, undefined);
  assert.deepEqual(raw.apps[0]!.sessions.map((s) => [s.sessionId, s.sessionSelector]), [
    ['sess-a', 'thread-a'],
    ['sess-b', 'thread-b'],
  ]);
});

test('listSessions filters by appId and ignores other cwds', () => {
  const p = paths();
  recordSpawn({ cwd: '/a', appId: 'x', adapter: 'claude-code', sessionId: 's1' }, p);
  recordSpawn({ cwd: '/a', appId: 'y', adapter: 'claude-code', sessionId: 's2' }, p);
  recordSpawn({ cwd: '/b', appId: 'x', adapter: 'claude-code', sessionId: 's3' }, p);
  assert.equal(listSessions({ cwd: '/a' }, p).length, 2);
  assert.equal(listSessions({ cwd: '/a', appId: 'x' }, p).length, 1);
  assert.equal(listSessions({ cwd: '/a', appId: 'x' }, p)[0]!.sessionId, 's1');
});

test('listSessions can list all app sessions or narrow by sessionSelector', () => {
  const p = paths();
  const cwd = '/tmp/proj-selector-list';
  recordSpawn({ cwd, appId: 'app', adapter: 'claude-code', sessionId: 'default' }, p);
  recordSpawn({ cwd, appId: 'app', adapter: 'claude-code', sessionId: 'a', sessionSelector: 'thread-a' }, p);
  recordSpawn({ cwd, appId: 'app', adapter: 'claude-code', sessionId: 'b', sessionSelector: 'thread-b' }, p);
  recordSpawn({ cwd, appId: 'other', adapter: 'claude-code', sessionId: 'other', sessionSelector: 'thread-a' }, p);

  assert.equal(listSessions({ cwd, appId: 'app' }, p).length, 3);
  assert.deepEqual(listSessions({ cwd, appId: 'app', sessionSelector: 'thread-a' }, p).map((s) => s.sessionId), ['a']);
  assert.deepEqual(listSessions({ cwd, sessionSelector: 'thread-a' }, p).map((s) => s.sessionId).sort(), ['a', 'other']);
});

test('recordResume updates lastUsedAt', async () => {
  const p = paths();
  const cwd = '/tmp/proj-b';
  recordSpawn({ cwd, appId: 'app', adapter: 'claude-code', sessionId: 'sess-r' }, p);
  const before = listSessions({ cwd, appId: 'app' }, p)[0]!;
  await new Promise((r) => setTimeout(r, 10));
  const updated = recordResume({ cwd, appId: 'app', sessionId: 'sess-r' }, p);
  assert.ok(updated);
  assert.notEqual(updated!.lastUsedAt, before.lastUsedAt);
});

test('recordResume only enforces sessionSelector when provided', () => {
  const p = paths();
  const cwd = '/tmp/proj-resume-selector';
  recordSpawn({ cwd, appId: 'app', adapter: 'claude-code', sessionId: 'sess-r', sessionSelector: 'thread-a' }, p);

  assert.ok(recordResume({ cwd, appId: 'app', sessionId: 'sess-r' }, p));
  assert.ok(recordResume({ cwd, appId: 'app', sessionId: 'sess-r', sessionSelector: 'thread-a' }, p));
  assert.equal(recordResume({ cwd, appId: 'app', sessionId: 'sess-r', sessionSelector: 'thread-b' }, p), null);
});

test('recordResume returns null for unknown session', () => {
  const p = paths();
  const result = recordResume({ cwd: '/nope', appId: 'x', sessionId: 'missing' }, p);
  assert.equal(result, null);
});

test('findLatestSession returns most recently used', async () => {
  const p = paths();
  const cwd = '/tmp/proj-c';
  recordSpawn({ cwd, appId: 'app', adapter: 'claude-code', sessionId: 'old' }, p);
  await new Promise((r) => setTimeout(r, 10));
  recordSpawn({ cwd, appId: 'app', adapter: 'claude-code', sessionId: 'new' }, p);
  const latest = findLatestSession({ cwd, appId: 'app' }, p);
  assert.equal(latest?.sessionId, 'new');
});

test('findLatestSession is scoped to the provided selector and defaults to unselected sessions', async () => {
  const p = paths();
  const cwd = '/tmp/proj-latest-selector';
  recordSpawn({ cwd, appId: 'app', adapter: 'claude-code', sessionId: 'default-old' }, p);
  await new Promise((r) => setTimeout(r, 10));
  recordSpawn({ cwd, appId: 'app', adapter: 'claude-code', sessionId: 'selector-new', sessionSelector: 'thread-a' }, p);
  await new Promise((r) => setTimeout(r, 10));
  recordSpawn({ cwd, appId: 'app', adapter: 'claude-code', sessionId: 'default-new' }, p);

  assert.equal(findLatestSession({ cwd, appId: 'app' }, p)?.sessionId, 'default-new');
  assert.equal(findLatestSession({ cwd, appId: 'app', sessionSelector: 'thread-a' }, p)?.sessionId, 'selector-new');
  assert.equal(findLatestSession({ cwd, appId: 'app', sessionSelector: 'missing' }, p), null);
});
