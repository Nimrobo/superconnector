import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
  recordSpawn({ cwd, appLabel: 'app1', adapter: 'claude-code', sessionId: 'sess-1' }, p);
  const sessions = listSessions({ cwd, appLabel: 'app1' }, p);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, 'sess-1');
  assert.equal(sessions[0]!.adapter, 'claude-code');
});

test('listSessions filters by appLabel and ignores other cwds', () => {
  const p = paths();
  recordSpawn({ cwd: '/a', appLabel: 'x', adapter: 'claude-code', sessionId: 's1' }, p);
  recordSpawn({ cwd: '/a', appLabel: 'y', adapter: 'claude-code', sessionId: 's2' }, p);
  recordSpawn({ cwd: '/b', appLabel: 'x', adapter: 'claude-code', sessionId: 's3' }, p);
  assert.equal(listSessions({ cwd: '/a' }, p).length, 2);
  assert.equal(listSessions({ cwd: '/a', appLabel: 'x' }, p).length, 1);
  assert.equal(listSessions({ cwd: '/a', appLabel: 'x' }, p)[0]!.sessionId, 's1');
});

test('recordResume updates lastUsedAt', async () => {
  const p = paths();
  const cwd = '/tmp/proj-b';
  recordSpawn({ cwd, appLabel: 'app', adapter: 'claude-code', sessionId: 'sess-r' }, p);
  const before = listSessions({ cwd, appLabel: 'app' }, p)[0]!;
  await new Promise((r) => setTimeout(r, 10));
  const updated = recordResume({ cwd, appLabel: 'app', sessionId: 'sess-r' }, p);
  assert.ok(updated);
  assert.notEqual(updated!.lastUsedAt, before.lastUsedAt);
});

test('recordResume returns null for unknown session', () => {
  const p = paths();
  const result = recordResume({ cwd: '/nope', appLabel: 'x', sessionId: 'missing' }, p);
  assert.equal(result, null);
});

test('findLatestSession returns most recently used', async () => {
  const p = paths();
  const cwd = '/tmp/proj-c';
  recordSpawn({ cwd, appLabel: 'app', adapter: 'claude-code', sessionId: 'old' }, p);
  await new Promise((r) => setTimeout(r, 10));
  recordSpawn({ cwd, appLabel: 'app', adapter: 'claude-code', sessionId: 'new' }, p);
  const latest = findLatestSession({ cwd, appLabel: 'app' }, p);
  assert.equal(latest?.sessionId, 'new');
});
