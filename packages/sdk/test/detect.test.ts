import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { CodexAdapter } from '../src/adapters/codex/index.js';
import { OpenCodeAdapter } from '../src/adapters/opencode/index.js';
import { detectAdapter } from '../src/detect.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'fake-claude.mjs');
const FAKE_CODEX = join(here, 'fake-codex.mjs');
const FAKE_OPENCODE = join(here, 'fake-opencode.mjs');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sc-detect-'));
}

function withBins<T>(bins: Partial<Record<'CLAUDE_BIN' | 'CODEX_BIN' | 'OPENCODE_BIN', string>>, fn: () => T): T {
  const prev = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    CODEX_BIN: process.env.CODEX_BIN,
    OPENCODE_BIN: process.env.OPENCODE_BIN,
  };
  for (const [key, value] of Object.entries(bins)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('ClaudeCodeAdapter detect requires binary and claude marker', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude'));

  assert.equal(new ClaudeCodeAdapter({ binPath: FAKE_CLAUDE }).detect(dir), true);
  assert.equal(new ClaudeCodeAdapter({ binPath: '/nonexistent/sc-claude' }).detect(dir), false);
  assert.equal(new ClaudeCodeAdapter({ binPath: FAKE_CLAUDE }).detect(tmp()), false);
});

test('OpenCodeAdapter detect requires binary and opencode marker', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'opencode.json'), '{}');

  assert.equal(new OpenCodeAdapter({ binPath: FAKE_OPENCODE }).detect(dir), true);
  assert.equal(new OpenCodeAdapter({ binPath: '/nonexistent/sc-opencode' }).detect(dir), false);
  assert.equal(new OpenCodeAdapter({ binPath: FAKE_OPENCODE }).detect(tmp()), false);
});

test('CodexAdapter detect requires binary and codex marker', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.codex'));

  assert.equal(new CodexAdapter({ binPath: FAKE_CODEX }).detect(dir), true);
  assert.equal(new CodexAdapter({ binPath: '/nonexistent/sc-codex' }).detect(dir), false);
  assert.equal(new CodexAdapter({ binPath: FAKE_CODEX }).detect(tmp()), false);
});

test('detectAdapter detects claude-code via CLAUDE.md with env binary', () => {
  withBins({ CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: '/no/opencode', CODEX_BIN: '/no/codex' }, () => {
    const dir = tmp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# claude');
    assert.equal(detectAdapter(dir), 'claude-code');
  });
});

test('detectAdapter detects opencode via opencode.json with env binary', () => {
  withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: '/no/codex' }, () => {
    const dir = tmp();
    writeFileSync(join(dir, 'opencode.json'), '{}');
    assert.equal(detectAdapter(dir), 'opencode');
  });
});

test('detectAdapter detects codex via .codex with env binary', () => {
  withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX }, () => {
    const dir = tmp();
    mkdirSync(join(dir, '.codex'));
    assert.equal(detectAdapter(dir), 'codex');
  });
});

test('detectAdapter skips matching adapter when its binary is unavailable', () => {
  withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX }, () => {
    const dir = tmp();
    writeFileSync(join(dir, 'opencode.json'), '{}');
    mkdirSync(join(dir, '.codex'));
    assert.equal(detectAdapter(dir), 'codex');
  });
});

test('detectAdapter preserves same-directory adapter priority', () => {
  withBins({ CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: FAKE_CODEX }, () => {
    const dir = tmp();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, 'opencode.json'), '{}');
    mkdirSync(join(dir, '.codex'));
    assert.equal(detectAdapter(dir), 'claude-code');
  });
});

test('detectAdapter walks upward', () => {
  withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX }, () => {
    const parent = tmp();
    const child = join(parent, 'a', 'b');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(parent, 'AGENTS.md'), '# agents');
    assert.equal(detectAdapter(child), 'codex');
  });
});

test('detectAdapter returns null when no usable markers match', () => {
  withBins({ CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: FAKE_CODEX }, () => {
    assert.equal(detectAdapter(tmp()), null);
  });
});
