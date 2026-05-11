import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

function onceData(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<RegExpMatchArray> {
  return new Promise((resolveData, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), 5000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const match = out.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolveData(match);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cli exited before server URL was printed, code ${code}, output: ${out}`));
    });
  });
}

test('config CLI serves config API and persists local config', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sc-cli-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'sc-cli-cwd-'));
  const packageRoot = resolve('.');
  const repoRoot = resolve(packageRoot, '..', '..');
  const distCli = resolve('dist/cli.js');
  const args = existsSync(distCli)
    ? [distCli, 'config', '--port', '0', '--no-open']
    : [
        '--import',
        `file://${join(repoRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')}`,
        join(packageRoot, 'src', 'cli.ts'),
        'config',
        '--port',
        '0',
        '--no-open',
      ];

  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, SUPERCONNECTOR_HOME: home },
  });

  try {
    const match = await onceData(child, /(http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+)/);
    const url = match[1]!;
    const initial = await fetch(new URL('/api/config' + new URL(url).search, url));
    assert.equal(initial.status, 200);
    const data = (await initial.json()) as {
      localPath: string;
      globalPath: string;
      modelOptions?: Record<string, Array<{ id: string; label?: string }>>;
    };
    assert.match(data.globalPath, /config\.json$/);
    assert.deepEqual(data.modelOptions?.['claude-code'], [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
    ]);

    const putUrl = new URL('/api/config/local' + new URL(url).search, url);
    const saved = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        preferredAdapter: 'claude-code',
        permissionMode: 'read',
        models: { 'claude-code': 'cli-model' },
      }),
    });
    assert.equal(saved.status, 200);

    const written = JSON.parse(readFileSync(join(cwd, '.superconnector', 'config.json'), 'utf8')) as {
      preferredAdapter?: string;
      permissionMode?: string;
      models?: Record<string, string>;
    };
    assert.equal(written.preferredAdapter, 'claude-code');
    assert.equal(written.permissionMode, 'read');
    assert.equal(written.models?.['claude-code'], 'cli-model');
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolveDone) => {
      child.once('exit', () => resolveDone());
      setTimeout(resolveDone, 1000);
    });
  }
});
