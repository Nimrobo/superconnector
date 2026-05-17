import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface PackageJson {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as PackageJson;
}

function readSdkPackageJson(): PackageJson {
  return JSON.parse(
    readFileSync(new URL('../../sdk/package.json', import.meta.url), 'utf8'),
  ) as PackageJson;
}

test('cli package owns the superconnector binary and depends on the sdk', () => {
  const pkg = readPackageJson();
  const sdkPkg = readSdkPackageJson();

  assert.equal(pkg.name, '@nimrobo/superconnector-cli');
  assert.equal(pkg.bin?.superconnector, './dist/cli.js');
  assert.ok(pkg.dependencies?.['@nimrobo/superconnector'] !== undefined, 'CLI must depend on SDK');
  assert.equal(pkg.dependencies?.['@nimrobo/superconnector'], sdkPkg.version);
});
