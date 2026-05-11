import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSuperconnector } from '../src/index.js';
import { InvalidCwdError } from '../src/errors.js';
import type { Adapter, AgentMessage, ResumeOptions, SpawnOptions } from '../src/types.js';
import { withProcessCwd } from './test-util.js';

class CwdAdapter implements Adapter {
  readonly kind = 'claude-code' as const;
  spawnCwd: string | null = null;

  detect(_cwd: string): boolean {
    return true;
  }

  spawn(_opts: SpawnOptions, cwd: string): AsyncIterable<AgentMessage> {
    this.spawnCwd = cwd;
    return (async function* () {
      yield { type: 'system', sessionId: 'cwd-session', content: {} } satisfies AgentMessage;
    })();
  }

  resume(_opts: ResumeOptions, _cwd: string): AsyncIterable<AgentMessage> {
    return (async function* () {})();
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sc-cwd-'));
}

async function drain(iter: AsyncIterable<AgentMessage>): Promise<void> {
  for await (const _ of iter) {
    // drain
  }
}

test('createSuperconnector uses process.cwd() when cwd is omitted', async () => {
  const cwd = tmp();
  await withProcessCwd(cwd, async () => {
    const expectedCwd = realpathSync(cwd);
    const adapter = new CwdAdapter();
    const sc = createSuperconnector({ adapter });

    await drain(sc.spawn({ prompt: 'go', appId: 'app' }));

    assert.equal(adapter.spawnCwd, expectedCwd);
  });
});

test('createSuperconnector canonicalizes omitted and explicit cwd consistently', async () => {
  const cwd = tmp();
  await withProcessCwd(cwd, async () => {
    const implicitAdapter = new CwdAdapter();
    const explicitAdapter = new CwdAdapter();
    const implicit = createSuperconnector({ adapter: implicitAdapter });
    const explicit = createSuperconnector({ cwd, adapter: explicitAdapter });

    await drain(implicit.spawn({ prompt: 'implicit', appId: 'app' }));
    await drain(explicit.spawn({ prompt: 'explicit', appId: 'app' }));

    assert.equal(implicitAdapter.spawnCwd, realpathSync(cwd));
    assert.equal(explicitAdapter.spawnCwd, implicitAdapter.spawnCwd);
  });
});

test('createSuperconnector accepts explicit cwd equal to process.cwd()', () => {
  const cwd = tmp();
  withProcessCwd(cwd, () => {
    assert.doesNotThrow(() => createSuperconnector({ cwd, adapter: new CwdAdapter() }));
  });
});

test('createSuperconnector accepts explicit child cwd as relative or absolute path', () => {
  const cwd = tmp();
  const child = join(cwd, 'child');
  mkdirSync(child);

  withProcessCwd(cwd, () => {
    assert.doesNotThrow(() => createSuperconnector({ cwd: 'child', adapter: new CwdAdapter() }));
    assert.doesNotThrow(() => createSuperconnector({ cwd: child, adapter: new CwdAdapter() }));
  });
});

test('createSuperconnector rejects explicit parent cwd', () => {
  const parent = tmp();
  const child = join(parent, 'child');
  mkdirSync(child);

  withProcessCwd(child, () => {
    assert.throws(() => createSuperconnector({ cwd: '..', adapter: new CwdAdapter() }), InvalidCwdError);
  });
});

test('createSuperconnector rejects explicit sibling cwd', () => {
  const parent = tmp();
  const a = join(parent, 'a');
  const b = join(parent, 'b');
  mkdirSync(a);
  mkdirSync(b);

  withProcessCwd(a, () => {
    assert.throws(() => createSuperconnector({ cwd: '../b', adapter: new CwdAdapter() }), InvalidCwdError);
  });
});

test('createSuperconnector rejects unrelated absolute cwd', () => {
  const cwd = tmp();
  const other = tmp();

  withProcessCwd(cwd, () => {
    assert.throws(() => createSuperconnector({ cwd: other, adapter: new CwdAdapter() }), InvalidCwdError);
  });
});

test('createSuperconnector rejects nonexistent cwd and file paths', () => {
  const cwd = tmp();
  const file = join(cwd, 'file.txt');
  writeFileSync(file, 'not a directory', 'utf8');

  withProcessCwd(cwd, () => {
    assert.throws(() => createSuperconnector({ cwd: 'missing', adapter: new CwdAdapter() }), InvalidCwdError);
    assert.throws(() => createSuperconnector({ cwd: 'file.txt', adapter: new CwdAdapter() }), InvalidCwdError);
  });
});

test('createSuperconnector preserves cwd validation cause', () => {
  const cwd = tmp();

  withProcessCwd(cwd, () => {
    assert.throws(
      () => createSuperconnector({ cwd: 'missing', adapter: new CwdAdapter() }),
      (error) => {
        assert.ok(error instanceof InvalidCwdError);
        assert.ok(error.cause instanceof Error);
        assert.equal((error.cause as { code?: string }).code, 'ENOENT');
        return true;
      },
    );
  });
});

test('createSuperconnector rejects symlink escapes', () => {
  const cwd = tmp();
  const outside = tmp();
  symlinkSync(outside, join(cwd, 'outside-link'), 'dir');

  withProcessCwd(cwd, () => {
    assert.throws(() => createSuperconnector({ cwd: 'outside-link', adapter: new CwdAdapter() }), InvalidCwdError);
  });
});
