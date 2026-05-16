import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isExecutableAvailable,
  isExecutableAvailableForPlatform,
} from '../src/util/executable.js';

function executable(path: string): string {
  writeFileSync(path, '#!/usr/bin/env node\nprocess.exit(0)\n', 'utf8');
  chmodSync(path, 0o755);
  return path;
}

test('isExecutableAvailable resolves explicit executable paths and rejects files without execute bit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-exec-'));
  const runnable = executable(join(dir, 'tool'));
  const notRunnable = join(dir, 'plain');
  writeFileSync(notRunnable, 'plain', 'utf8');

  assert.equal(isExecutableAvailable(runnable), true);
  assert.equal(isExecutableAvailable(notRunnable), false);
  assert.equal(isExecutableAvailable(join(dir, 'missing')), false);
});

test('isExecutableAvailable resolves commands from PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-exec-path-'));
  executable(join(dir, 'sc-tool'));

  assert.equal(
    isExecutableAvailableForPlatform('sc-tool', process.platform, { PATH: dir }),
    true,
  );
  assert.equal(
    isExecutableAvailableForPlatform('missing-tool', process.platform, { PATH: dir }),
    false,
  );
});

test('isExecutableAvailable honors Windows PATHEXT when checking PATH commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-exec-win-'));
  executable(join(dir, 'sc-tool.CMD'));

  assert.equal(
    isExecutableAvailableForPlatform('sc-tool', 'win32', {
      PATH: dir,
      PATHEXT: '.EXE;.CMD',
    }),
    true,
  );
  assert.equal(
    isExecutableAvailableForPlatform('sc-tool', 'win32', {
      PATH: dir,
      PATHEXT: '.EXE',
    }),
    false,
  );
});
