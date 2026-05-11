import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface PackageJson {
  name?: string;
  bin?: unknown;
  exports?: Record<string, unknown>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson;
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
