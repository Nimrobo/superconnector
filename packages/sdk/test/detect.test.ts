import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAdapter } from '../src/detect.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sc-detect-'));
}

test('detects claude-code via .claude dir', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude'));
  assert.equal(detectAdapter(dir), 'claude-code');
});

test('detects claude-code via CLAUDE.md', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'CLAUDE.md'), '# claude');
  assert.equal(detectAdapter(dir), 'claude-code');
});

test('detects opencode via opencode.json', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'opencode.json'), '{}');
  assert.equal(detectAdapter(dir), 'opencode');
});

test('detects codex via .codex dir', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.codex'));
  assert.equal(detectAdapter(dir), 'codex');
});

test('returns null when no markers', () => {
  const dir = tmp();
  assert.equal(detectAdapter(dir), null);
});
