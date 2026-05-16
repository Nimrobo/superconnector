import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_KINDS,
  createBuiltinAdapter,
  createBuiltinAdapters,
  isAdapterKind,
} from '../src/adapters/registry.js';

test('built-in adapter registry exposes supported adapters in priority order', () => {
  assert.deepEqual([...ADAPTER_KINDS], ['claude-code', 'opencode', 'codex']);
  assert.deepEqual(
    createBuiltinAdapters().map((adapter) => adapter.kind),
    ['claude-code', 'opencode', 'codex'],
  );
});

test('createBuiltinAdapter applies per-adapter model config', () => {
  const adapter = createBuiltinAdapter('codex', { models: { codex: 'configured-codex' } });
  assert.equal(adapter.kind, 'codex');
  assert.equal((adapter as unknown as { model?: string }).model, 'configured-codex');
});

test('isAdapterKind validates known adapter kinds', () => {
  assert.equal(isAdapterKind('claude-code'), true);
  assert.equal(isAdapterKind('opencode'), true);
  assert.equal(isAdapterKind('codex'), true);
  assert.equal(isAdapterKind('unknown'), false);
});
