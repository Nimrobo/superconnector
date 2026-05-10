import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  globalConfigPath,
  localConfigPath,
  readConfig,
  resolveConfig,
  writeConfig,
} from '../src/config.js';
import { createSuperconnector } from '../src/index.js';

function withHome<T>(fn: (home: string) => T): T {
  const prev = process.env.SUPERCONNECTOR_HOME;
  const home = mkdtempSync(join(tmpdir(), 'sc-config-home-'));
  process.env.SUPERCONNECTOR_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.SUPERCONNECTOR_HOME;
    else process.env.SUPERCONNECTOR_HOME = prev;
  }
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'sc-config-cwd-'));
}

test('readConfig and writeConfig round-trip valid config', () => {
  withHome(() => {
    const path = join(mkdtempSync(join(tmpdir(), 'sc-config-file-')), 'config.json');
    writeConfig(path, {
      preferredAdapter: 'claude-code',
      permissionMode: 'read',
      models: { 'claude-code': 'sonnet-test' },
    });

    assert.deepEqual(readConfig(path), {
      preferredAdapter: 'claude-code',
      permissionMode: 'read',
      models: { 'claude-code': 'sonnet-test' },
    });
    assert.match(readFileSync(path, 'utf8'), /sonnet-test/);
  });
});

test('readConfig is tolerant of missing and corrupt files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-config-corrupt-'));
  assert.equal(readConfig(join(dir, 'missing.json')), null);
  const path = join(dir, 'config.json');
  writeFileSync(path, '{ nope', 'utf8');
  assert.equal(readConfig(path), null);
});

test('resolveConfig merges local over global with per-adapter model fallback', () => {
  withHome(() => {
    const cwd = tmpCwd();
    writeConfig(globalConfigPath(), {
      preferredAdapter: 'claude-code',
      permissionMode: 'acceptEdits',
      models: {
        'claude-code': 'global-claude',
        codex: 'global-codex',
      },
    });
    writeConfig(localConfigPath(cwd), {
      permissionMode: 'read',
      models: {
        'claude-code': 'local-claude',
      },
    });

    assert.deepEqual(resolveConfig(cwd).merged, {
      preferredAdapter: 'claude-code',
      permissionMode: 'read',
      models: {
        'claude-code': 'local-claude',
        codex: 'global-codex',
      },
    });
  });
});

test('createSuperconnector applies preferred adapter and configured model', () => {
  withHome(() => {
    const cwd = tmpCwd();
    writeConfig(globalConfigPath(), {
      preferredAdapter: 'claude-code',
      models: { 'claude-code': 'configured-model' },
    });

    const adapter = createSuperconnector({ cwd }).getAdapter();
    assert.equal(adapter.kind, 'claude-code');
    assert.equal((adapter as unknown as { model?: string }).model, 'configured-model');
  });
});
