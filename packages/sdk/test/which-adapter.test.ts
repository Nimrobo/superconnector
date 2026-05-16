import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSuperconnector } from '../src/index.js';
import { globalConfigPath, writeConfig } from '../src/config.js';
import { recordSpawn } from '../src/registry.js';
import type { Adapter, AdapterKind, AgentMessage, ResumeOptions, SpawnOptions } from '../src/types.js';
import { withProcessCwd } from './test-util.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'fake-claude.mjs');
const FAKE_CODEX = join(here, 'fake-codex.mjs');
const FAKE_OPENCODE = join(here, 'fake-opencode.mjs');

class StubAdapter implements Adapter {
  readonly kind: AdapterKind;
  spawnCalls: SpawnOptions[] = [];
  resumeCalls: ResumeOptions[] = [];

  constructor(kind: AdapterKind = 'claude-code') {
    this.kind = kind;
  }

  detect(_cwd: string): boolean {
    return false;
  }

  spawn(opts: SpawnOptions, _cwd: string): AsyncIterable<AgentMessage> {
    this.spawnCalls.push(opts);
    return (async function* () {
      yield { type: 'assistant', sessionId: 'stub-sess', content: { text: 'spawned' } } satisfies AgentMessage;
    })();
  }

  resume(opts: ResumeOptions, _cwd: string): AsyncIterable<AgentMessage> {
    this.resumeCalls.push(opts);
    return (async function* () {
      yield { type: 'assistant', sessionId: opts.sessionId, content: { text: 'resumed' } } satisfies AgentMessage;
    })();
  }
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'sc-preview-cwd-'));
}

async function withIsolatedHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const prev = process.env.SUPERCONNECTOR_HOME;
  const home = mkdtempSync(join(tmpdir(), 'sc-preview-home-'));
  process.env.SUPERCONNECTOR_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.SUPERCONNECTOR_HOME;
    else process.env.SUPERCONNECTOR_HOME = prev;
  }
}

async function withBins<T>(
  bins: Partial<Record<'CLAUDE_BIN' | 'CODEX_BIN' | 'OPENCODE_BIN', string>>,
  fn: () => T | Promise<T>,
): Promise<T> {
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
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('whichAdapterWillRun reports an explicit adapter', async () => {
  await withIsolatedHome(() => {
    const cwd = tmpCwd();
    const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd, adapter: new StubAdapter('opencode') }));

    assert.deepEqual(sc.whichAdapterWillRun(), {
      cwd: realpathSync(cwd),
      action: 'spawn',
      adapter: 'opencode',
      source: 'explicit',
      ready: true,
      reason: 'explicit_adapter',
      session: null,
    });

    sc.setAdapter('codex');
    assert.equal(sc.whichAdapterWillRun().adapter, 'codex');
    assert.equal(sc.whichAdapterWillRun().source, 'explicit');
  });
});

test('whichAdapterWillRun reports a configured preferred adapter', async () => {
  await withIsolatedHome(() => {
    const cwd = tmpCwd();
    writeConfig(globalConfigPath(), { preferredAdapter: 'opencode' });

    const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd }));
    const preview = sc.whichAdapterWillRun({ appId: 'app' });

    assert.equal(preview.adapter, 'opencode');
    assert.equal(preview.source, 'config');
    assert.equal(preview.reason, 'configured_preferred_adapter');
    assert.equal(preview.action, 'spawn');
    assert.equal(preview.ready, true);
  });
});

test('whichAdapterWillRun reports a detected adapter', async () => {
  await withIsolatedHome(() =>
    withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX }, () => {
      const cwd = tmpCwd();
      mkdirSync(join(cwd, '.codex'));

      const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd }));
      const preview = sc.whichAdapterWillRun({ appId: 'app' });

      assert.equal(preview.adapter, 'codex');
      assert.equal(preview.source, 'detected');
      assert.equal(preview.reason, 'detected_project_adapter');
      assert.equal(preview.ready, true);
    }),
  );
});

test('createSuperconnector precedence is explicit adapter over config over detection', async () => {
  await withIsolatedHome(() =>
    withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX }, () => {
      const cwd = tmpCwd();
      mkdirSync(join(cwd, '.codex'));
      writeConfig(globalConfigPath(), { preferredAdapter: 'opencode' });

      const explicit = withProcessCwd(cwd, () => createSuperconnector({
        cwd,
        adapter: new StubAdapter('claude-code'),
      }));
      assert.equal(explicit.getAdapter().kind, 'claude-code');
      assert.equal(explicit.whichAdapterWillRun().source, 'explicit');

      const configured = withProcessCwd(cwd, () => createSuperconnector({ cwd }));
      assert.equal(configured.getAdapter().kind, 'opencode');
      assert.equal(configured.whichAdapterWillRun().source, 'config');
    }),
  );

  await withIsolatedHome(() =>
    withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX }, () => {
      const cwd = tmpCwd();
      mkdirSync(join(cwd, '.codex'));

      const detected = withProcessCwd(cwd, () => createSuperconnector({ cwd }));
      assert.equal(detected.getAdapter().kind, 'codex');
      assert.equal(detected.whichAdapterWillRun().source, 'detected');
    }),
  );
});

test('whichAdapterWillRun reports each detected built-in adapter with fake binaries', async () => {
  await withIsolatedHome(() =>
    withBins({ CLAUDE_BIN: FAKE_CLAUDE, OPENCODE_BIN: '/no/opencode', CODEX_BIN: '/no/codex' }, () => {
      const cwd = tmpCwd();
      writeFileSync(join(cwd, 'CLAUDE.md'), '# claude');
      assert.equal(withProcessCwd(cwd, () => createSuperconnector({ cwd }).whichAdapterWillRun().adapter), 'claude-code');
    }),
  );
  await withIsolatedHome(() =>
    withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: FAKE_OPENCODE, CODEX_BIN: '/no/codex' }, () => {
      const cwd = tmpCwd();
      writeFileSync(join(cwd, 'opencode.json'), '{}');
      assert.equal(withProcessCwd(cwd, () => createSuperconnector({ cwd }).whichAdapterWillRun().adapter), 'opencode');
    }),
  );
  await withIsolatedHome(() =>
    withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: FAKE_CODEX }, () => {
      const cwd = tmpCwd();
      writeFileSync(join(cwd, 'AGENTS.md'), '# agents');
      assert.equal(withProcessCwd(cwd, () => createSuperconnector({ cwd }).whichAdapterWillRun().adapter), 'codex');
    }),
  );
});

test('whichAdapterWillRun reports no adapter when none is resolved', async () => {
  await withIsolatedHome(() =>
    withBins({ CLAUDE_BIN: '/no/claude', OPENCODE_BIN: '/no/opencode', CODEX_BIN: '/no/codex' }, () => {
      const cwd = tmpCwd();
      const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd }));

      assert.deepEqual(sc.whichAdapterWillRun({ appId: 'app' }), {
        cwd: realpathSync(cwd),
        action: 'spawn',
        adapter: null,
        source: 'none',
        ready: false,
        reason: 'no_adapter',
        session: null,
      });
    }),
  );
});

test('whichAdapterWillRun resolves resumeLastCreatedSession to the recorded adapter', async () => {
  await withIsolatedHome((home) => {
    const cwd = tmpCwd();
    const session = recordSpawn({
      cwd: realpathSync(cwd),
      appId: 'app',
      sessionSelector: 'thread-a',
      adapter: 'claude-code',
      sessionId: 'recorded-1',
    }, { root: home, file: join(home, 'registry.json') });
    recordSpawn({
      cwd: realpathSync(cwd),
      appId: 'app',
      sessionSelector: 'thread-b',
      adapter: 'opencode',
      sessionId: 'recorded-2',
    }, { root: home, file: join(home, 'registry.json') });

    const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd, adapter: new StubAdapter('codex') }));
    const preview = sc.whichAdapterWillRun({
      appId: 'app',
      sessionSelector: 'thread-a',
      resumeLastCreatedSession: true,
    });

    assert.deepEqual(preview, {
      cwd: realpathSync(cwd),
      action: 'resume',
      adapter: 'claude-code',
      source: 'recorded-session',
      ready: true,
      reason: 'latest_session',
      session,
    });
    assert.equal(sc.whichAdapterWillRun({
      appId: 'app',
      sessionSelector: 'thread-b',
      resumeLastCreatedSession: true,
    }).adapter, 'opencode');
  });
});

test('whichAdapterWillRun falls back to spawn when resumeLastCreatedSession finds no match', async () => {
  await withIsolatedHome((home) => {
    const cwd = tmpCwd();
    recordSpawn({
      cwd: realpathSync(cwd),
      appId: 'app',
      sessionSelector: 'thread-a',
      adapter: 'claude-code',
      sessionId: 'recorded-1',
    }, { root: home, file: join(home, 'registry.json') });

    const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd, adapter: new StubAdapter('codex') }));
    const preview = sc.whichAdapterWillRun({
      appId: 'app',
      resumeLastCreatedSession: true,
    });

    assert.equal(preview.action, 'spawn');
    assert.equal(preview.adapter, 'codex');
    assert.equal(preview.source, 'explicit');
    assert.equal(preview.reason, 'explicit_adapter');
    assert.equal(preview.session, null);
  });
});

test('whichAdapterWillRun resolves explicit resume sessions without mutating session state', async () => {
  await withIsolatedHome((home) => {
    const cwd = tmpCwd();
    const session = recordSpawn({
      cwd: realpathSync(cwd),
      appId: 'app',
      sessionSelector: 'thread-a',
      adapter: 'opencode',
      sessionId: 'recorded-1',
    }, { root: home, file: join(home, 'registry.json') });

    const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd, adapter: new StubAdapter('codex') }));
    const before = sc.listSessions({ appId: 'app' })[0]!;
    const preview = sc.whichAdapterWillRun({
      operation: 'resume',
      appId: 'app',
      sessionSelector: 'thread-a',
      sessionId: 'recorded-1',
    });
    const after = sc.listSessions({ appId: 'app' })[0]!;

    assert.deepEqual(preview, {
      cwd: realpathSync(cwd),
      action: 'resume',
      adapter: 'opencode',
      source: 'recorded-session',
      ready: true,
      reason: 'explicit_session',
      session,
    });
    assert.equal(before.lastUsedAt, after.lastUsedAt);
  });
});

test('whichAdapterWillRun reports unknown explicit resume sessions', async () => {
  await withIsolatedHome(() => {
    const cwd = tmpCwd();
    const sc = withProcessCwd(cwd, () => createSuperconnector({ cwd, adapter: new StubAdapter('codex') }));
    const preview = sc.whichAdapterWillRun({
      operation: 'resume',
      appId: 'app',
      sessionId: 'missing',
    });

    assert.deepEqual(preview, {
      cwd: realpathSync(cwd),
      action: 'resume',
      adapter: null,
      source: 'none',
      ready: false,
      reason: 'unknown_session',
      session: null,
    });
  });
});
