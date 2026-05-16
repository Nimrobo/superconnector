import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSuperconnector } from '../src/index.js';
import { withProcessCwd } from './test-util.js';

import { globalConfigPath, writeConfig } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'fake-claude.mjs');
const FAKE_CODEX = join(here, 'fake-codex.mjs');
const FAKE_OPENCODE = join(here, 'fake-opencode.mjs');

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'sc-list-cwd-'));
}

async function withIsolatedHome<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.SUPERCONNECTOR_HOME;
  process.env.SUPERCONNECTOR_HOME = mkdtempSync(join(tmpdir(), 'sc-list-home-'));
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SUPERCONNECTOR_HOME;
    else process.env.SUPERCONNECTOR_HOME = prev;
  }
}

async function withBins<T>(
  bins: Partial<Record<'CLAUDE_BIN' | 'CODEX_BIN' | 'OPENCODE_BIN', string>>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const keys = ['CLAUDE_BIN', 'CODEX_BIN', 'OPENCODE_BIN'] as const;
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const [key, value] of Object.entries(bins)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test('listAdapters reports one entry per built-in adapter', async () => {
  await withIsolatedHome(() =>
    withBins(
      { CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: '/no/codex' },
      () => {
        const cwd = tmpCwd();
        const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd, adapter: 'claude-code' }));
        const adapters = sc.listAdapters();

        assert.deepEqual(
          adapters.map((a) => a.kind),
          ['claude-code', 'opencode', 'codex'],
        );
        assert.equal(
          adapters.every((a) => !a.detected),
          true,
        );
        assert.deepEqual(
          adapters.filter((a) => a.selected).map((a) => a.kind),
          ['claude-code'],
        );
      },
    ),
  );
});

test('listAdapters marks a detected adapter', async () => {
  await withIsolatedHome(() =>
    withBins(
      { CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: '/no/opencode', CODEX_BIN: '/no/codex' },
      () => {
        const cwd = tmpCwd();
        writeFileSync(join(cwd, 'CLAUDE.md'), '# claude');
        const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd }));
        const claude = sc.listAdapters().find((a) => a.kind === 'claude-code')!;

        assert.equal(claude.detected, true);
        assert.equal(claude.selected, true);
      },
    ),
  );
});

test('listAdapters marks every detected adapter in a multi-marker project', async () => {
  await withIsolatedHome(() =>
    withBins(
      { CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: FAKE_CODEX },
      () => {
        const cwd = tmpCwd();
        writeFileSync(join(cwd, 'CLAUDE.md'), '# claude');
        writeFileSync(join(cwd, 'opencode.json'), '{}');
        writeFileSync(join(cwd, 'AGENTS.md'), '# agents');
        const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd }));

        assert.deepEqual(
          sc
            .listAdapters()
            .filter((a) => a.detected)
            .map((a) => a.kind),
          ['claude-code', 'opencode', 'codex'],
        );
      },
    ),
  );
});

test('listAdapters selected flag follows config and setAdapter', async () => {
  await withIsolatedHome(() =>
    withBins(
      { CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: '/no/codex' },
      () => {
        const cwd = tmpCwd();
        writeConfig(globalConfigPath(), { preferredAdapter: 'opencode' });
        const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd }));

        assert.deepEqual(
          sc
            .listAdapters()
            .filter((a) => a.selected)
            .map((a) => a.kind),
          ['opencode'],
        );

        sc.setAdapter('codex');
        assert.deepEqual(
          sc
            .listAdapters()
            .filter((a) => a.selected)
            .map((a) => a.kind),
          ['codex'],
        );
      },
    ),
  );
});

test('listAdapters reports no selected adapter when none resolves', async () => {
  await withIsolatedHome(() =>
    withBins(
      { CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: '/no/codex' },
      () => {
        const cwd = tmpCwd();
        const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd }));
        const adapters = sc.listAdapters();

        assert.equal(adapters.length, 3);
        assert.equal(
          adapters.some((a) => a.selected),
          false,
        );
        assert.equal(
          adapters.some((a) => a.detected),
          false,
        );
      },
    ),
  );
});

test('listModels returns the static claude-code model list', async () => {
  await withIsolatedHome(async () => {
    const cwd = tmpCwd();
    const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd, adapter: 'codex' }));
    const models = await sc.listModels('claude-code');

    assert.deepEqual(models.map((m) => m.id).sort(), ['opus', 'sonnet']);
  });
});

test('listModels delegates to a non-selected adapter binary', async () => {
  await withIsolatedHome(() =>
    withBins({ OPENCODE_BIN: FAKE_OPENCODE }, async () => {
      const cwd = tmpCwd();
      // claude-code is selected; querying opencode must still reach its binary.
      const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd, adapter: 'claude-code' }));
      const models = await sc.listModels('opencode');

      assert.deepEqual(
        models.map((m) => m.id),
        ['opencode/big-pickle', 'anthropic/claude-sonnet-4-5', 'google/gemini-2.5-pro'],
      );
    }),
  );
});

test('listModels returns [] when the adapter binary is unavailable', async () => {
  await withIsolatedHome(() =>
    withBins({ OPENCODE_BIN: '/nonexistent/opencode-xyz' }, async () => {
      const cwd = tmpCwd();
      const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd, adapter: 'claude-code' }));

      assert.deepEqual(await sc.listModels('opencode'), []);
    }),
  );
});
