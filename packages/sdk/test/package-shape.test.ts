import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

interface PackageJson {
  name?: string;
  bin?: unknown;
  exports?: Record<string, unknown>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as PackageJson;
}

test('sdk package exposes sdk entrypoints without a cli binary', () => {
  const pkg = readPackageJson();

  assert.equal(pkg.name, '@nimrobo/superconnector');
  assert.equal(pkg.bin, undefined);
  assert.ok(pkg.exports?.['.']);
  assert.ok(pkg.exports?.['./config']);
  assert.ok(pkg.exports?.['./adapters/claude-code']);
  assert.ok(pkg.exports?.['./adapters/opencode']);
  assert.ok(pkg.exports?.['./adapters/codex']);
});

test('packed sdk can be installed by a consumer and exposes runtime/types/skills files', () => {
  const pkgDir = new URL('..', import.meta.url);
  const packDir = mkdtempSync(join(tmpdir(), 'sc-pack-'));
  const consumerDir = mkdtempSync(join(tmpdir(), 'sc-consumer-'));

  execFileSync('npm', ['run', 'build'], { cwd: pkgDir, stdio: 'pipe' });
  const raw = execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [packed] = JSON.parse(raw) as Array<{ filename: string; files: Array<{ path: string }> }>;
  assert.ok(packed);
  const packedFiles = new Set(packed.files.map((f) => f.path));
  assert.ok(packedFiles.has('dist/index.js'));
  assert.ok(packedFiles.has('dist/index.d.ts'));
  assert.ok(packedFiles.has('dist/adapters/claude-code/index.js'));
  assert.ok(packedFiles.has('dist/adapters/opencode/index.js'));
  assert.ok(packedFiles.has('dist/adapters/codex/index.js'));
  assert.ok([...packedFiles].some((p) => p.startsWith('skills/')));

  writeFileSync(join(consumerDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  const tarball = join(packDir, packed.filename);
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: consumerDir,
    stdio: 'pipe',
  });
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        'import { createSuperconnector } from "@nimrobo/superconnector";',
        'import { ClaudeCodeAdapter } from "@nimrobo/superconnector/adapters/claude-code";',
        'import { OpenCodeAdapter } from "@nimrobo/superconnector/adapters/opencode";',
        'import { CodexAdapter } from "@nimrobo/superconnector/adapters/codex";',
        'if (!createSuperconnector || !ClaudeCodeAdapter || !OpenCodeAdapter || !CodexAdapter) process.exit(1);',
      ].join('\n'),
    ],
    { cwd: consumerDir, stdio: 'pipe' },
  );

  const installed = join(consumerDir, 'node_modules', '@nimrobo', 'superconnector');
  assert.ok(existsSync(join(installed, 'dist', 'index.d.ts')));
  assert.ok(existsSync(join(installed, 'skills', 'superconnector-consumer', 'SKILL.md')));
});
