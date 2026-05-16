import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { CodexAdapter } from '../src/adapters/codex/index.js';
import { OpenCodeAdapter } from '../src/adapters/opencode/index.js';
import { detectAdapter, detectAdapters } from '../src/detect.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'fake-claude.mjs');
const FAKE_CODEX = join(here, 'fake-codex.mjs');
const FAKE_OPENCODE = join(here, 'fake-opencode.mjs');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sc-detect-'));
}

function withBins<T>(
  bins: Partial<Record<'CLAUDE_BIN' | 'CODEX_BIN' | 'OPENCODE_BIN', string>>,
  fn: () => T,
): T {
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

test('ClaudeCodeAdapter detect accepts each marker variant and rejects wrong .claude type', () => {
  const dotClaude = tmp();
  mkdirSync(join(dotClaude, '.claude'));
  const claudeMd = tmp();
  writeFileSync(join(claudeMd, 'CLAUDE.md'), '# claude');
  const fileMarker = tmp();
  writeFileSync(join(fileMarker, '.claude'), 'not a directory');

  const adapter = new ClaudeCodeAdapter({ binPath: FAKE_CLAUDE });
  assert.equal(adapter.detect(dotClaude), true);
  assert.equal(adapter.detect(claudeMd), true);
  assert.equal(adapter.detect(fileMarker), false);
});

test('OpenCodeAdapter detect requires binary and opencode marker', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'opencode.json'), '{}');

  assert.equal(new OpenCodeAdapter({ binPath: FAKE_OPENCODE }).detect(dir), true);
  assert.equal(new OpenCodeAdapter({ binPath: '/nonexistent/sc-opencode' }).detect(dir), false);
  assert.equal(new OpenCodeAdapter({ binPath: FAKE_OPENCODE }).detect(tmp()), false);
});

test('OpenCodeAdapter detect accepts each marker variant and rejects wrong .opencode type', () => {
  const dotOpenCode = tmp();
  mkdirSync(join(dotOpenCode, '.opencode'));
  const jsonMarker = tmp();
  writeFileSync(join(jsonMarker, 'opencode.json'), '{}');
  const fileMarker = tmp();
  writeFileSync(join(fileMarker, '.opencode'), 'not a directory');

  const adapter = new OpenCodeAdapter({ binPath: FAKE_OPENCODE });
  assert.equal(adapter.detect(dotOpenCode), true);
  assert.equal(adapter.detect(jsonMarker), true);
  assert.equal(adapter.detect(fileMarker), false);
});

test('CodexAdapter detect requires binary and codex marker', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.codex'));

  assert.equal(new CodexAdapter({ binPath: FAKE_CODEX }).detect(dir), true);
  assert.equal(new CodexAdapter({ binPath: '/nonexistent/sc-codex' }).detect(dir), false);
  assert.equal(new CodexAdapter({ binPath: FAKE_CODEX }).detect(tmp()), false);
});

test('CodexAdapter detect accepts each marker variant and rejects wrong .codex type', () => {
  const dotCodex = tmp();
  mkdirSync(join(dotCodex, '.codex'));
  const agentsMd = tmp();
  writeFileSync(join(agentsMd, 'AGENTS.md'), '# agents');
  const fileMarker = tmp();
  writeFileSync(join(fileMarker, '.codex'), 'not a directory');

  const adapter = new CodexAdapter({ binPath: FAKE_CODEX });
  assert.equal(adapter.detect(dotCodex), true);
  assert.equal(adapter.detect(agentsMd), true);
  assert.equal(adapter.detect(fileMarker), false);
});

test('detectAdapter can discover a binary from PATH without explicit env bin', () => {
  const binDir = mkdtempSync(join(tmpdir(), 'sc-detect-path-bin-'));
  const fakeCodexOnPath = join(binDir, 'codex');
  writeFileSync(fakeCodexOnPath, '#!/usr/bin/env node\nprocess.exit(0)\n', 'utf8');
  chmodSync(fakeCodexOnPath, 0o755);

  const prev = {
    PATH: process.env.PATH,
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    OPENCODE_BIN: process.env.OPENCODE_BIN,
    CODEX_BIN: process.env.CODEX_BIN,
  };
  process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`;
  process.env.CLAUDE_BIN = '/no/claude';
  process.env.OPENCODE_BIN = '/no/opencode';
  delete process.env.CODEX_BIN;
  try {
    const dir = tmp();
    mkdirSync(join(dir, '.codex'));
    assert.equal(detectAdapter(dir), 'codex');
  } finally {
    if (prev.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = prev.PATH;
    if (prev.CLAUDE_BIN === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prev.CLAUDE_BIN;
    if (prev.OPENCODE_BIN === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = prev.OPENCODE_BIN;
    if (prev.CODEX_BIN === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prev.CODEX_BIN;
  }
});

test('detectAdapter detects claude-code via CLAUDE.md with env binary', () => {
  withBins(
    { CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: '/no/opencode', CODEX_BIN: '/no/codex' },
    () => {
      const dir = tmp();
      writeFileSync(join(dir, 'CLAUDE.md'), '# claude');
      assert.equal(detectAdapter(dir), 'claude-code');
    },
  );
});

test('detectAdapter detects opencode via opencode.json with env binary', () => {
  withBins(
    { CLAUDE_BIN: '/no/claude', OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: '/no/codex' },
    () => {
      const dir = tmp();
      writeFileSync(join(dir, 'opencode.json'), '{}');
      assert.equal(detectAdapter(dir), 'opencode');
    },
  );
});

test('detectAdapter detects codex via .codex with env binary', () => {
  withBins(
    { CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX },
    () => {
      const dir = tmp();
      mkdirSync(join(dir, '.codex'));
      assert.equal(detectAdapter(dir), 'codex');
    },
  );
});

test('detectAdapter skips matching adapter when its binary is unavailable', () => {
  withBins(
    { CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX },
    () => {
      const dir = tmp();
      writeFileSync(join(dir, 'opencode.json'), '{}');
      mkdirSync(join(dir, '.codex'));
      assert.equal(detectAdapter(dir), 'codex');
    },
  );
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
  withBins(
    { CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX },
    () => {
      const parent = tmp();
      const child = join(parent, 'a', 'b');
      mkdirSync(child, { recursive: true });
      writeFileSync(join(parent, 'AGENTS.md'), '# agents');
      assert.equal(detectAdapter(child), 'codex');
    },
  );
});

test('detectAdapter prefers the nearest ancestor before adapter priority at higher ancestors', () => {
  withBins({ CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX }, () => {
    const parent = tmp();
    const child = join(parent, 'a', 'b');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(parent, 'CLAUDE.md'), '# claude');
    mkdirSync(join(dirname(child), '.codex'));

    assert.equal(detectAdapter(child), 'codex');
  });
});

test('detectAdapter handles symlinked cwd paths and spaces', () => {
  withBins(
    { CLAUDE_BIN: '/no/claude', OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: '/no/codex' },
    () => {
      const targetParent = mkdtempSync(join(tmpdir(), 'sc detect target '));
      const target = join(targetParent, 'project with spaces');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'opencode.json'), '{}');

      const linkParent = mkdtempSync(join(tmpdir(), 'sc detect link '));
      const link = join(linkParent, 'linked project');
      symlinkSync(target, link, 'dir');

      assert.equal(detectAdapter(link), 'opencode');
    },
  );
});

test('detectAdapter does not walk above the home directory boundary', () => {
  withBins(
    { CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX },
    () => {
      const prevHome = process.env.HOME;
      const fakeRoot = mkdtempSync(join(tmpdir(), 'sc-home-root-'));
      const fakeHome = join(fakeRoot, 'home');
      const project = join(fakeHome, 'project');
      mkdirSync(project, { recursive: true });
      mkdirSync(join(fakeRoot, '.codex'));
      process.env.HOME = fakeHome;
      try {
        assert.equal(homedir(), fakeHome);
        assert.equal(detectAdapter(project), null);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    },
  );
});

test('detectAdapter returns null when no usable markers match', () => {
  withBins({ CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: FAKE_CODEX }, () => {
    assert.equal(detectAdapter(tmp()), null);
  });
});

test('detectAdapters returns every detected adapter in priority order', () => {
  withBins({ CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: FAKE_CODEX }, () => {
    const dir = tmp();
    mkdirSync(join(dir, '.codex'));
    writeFileSync(join(dir, 'opencode.json'), '{}');
    mkdirSync(join(dir, '.claude'));
    assert.deepEqual(detectAdapters(dir), ['claude-code', 'opencode', 'codex']);
  });
});

test('detectAdapters omits adapters whose binary is unavailable', () => {
  withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: FAKE_CODEX }, () => {
    const dir = tmp();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, 'opencode.json'), '{}');
    mkdirSync(join(dir, '.codex'));
    assert.deepEqual(detectAdapters(dir), ['opencode', 'codex']);
  });
});

test('detectAdapters de-duplicates a kind detected at multiple ancestors', () => {
  withBins(
    { CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX },
    () => {
      const parent = tmp();
      const child = join(parent, 'a', 'b');
      mkdirSync(child, { recursive: true });
      mkdirSync(join(parent, '.codex'));
      writeFileSync(join(child, 'AGENTS.md'), '# agents');
      assert.deepEqual(detectAdapters(child), ['codex']);
    },
  );
});

test('detectAdapters returns an empty array when nothing matches', () => {
  withBins({ CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: FAKE_CODEX }, () => {
    assert.deepEqual(detectAdapters(tmp()), []);
  });
});
