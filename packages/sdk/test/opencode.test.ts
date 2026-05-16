import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OpenCodeAdapter,
  hasModelFlag,
  parseModelsOutput,
} from '../src/adapters/opencode/index.js';
import { runOpenCode } from '../src/adapters/opencode/process.js';
import { AdapterFailedError } from '../src/errors.js';
import type { AgentMessage } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_OPENCODE = join(here, 'fake-opencode.mjs');

function withArgsFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(mkdtempSync(join(tmpdir(), 'oc-args-')), 'args');
  const prev = process.env.FAKE_ARGS_FILE;
  process.env.FAKE_ARGS_FILE = path;
  return fn(path).finally(() => {
    if (prev === undefined) delete process.env.FAKE_ARGS_FILE;
    else process.env.FAKE_ARGS_FILE = prev;
    if (existsSync(path)) unlinkSync(path);
  });
}

function readArgs(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n');
}

// --- hasModelFlag -----------------------------------------------------------

test('hasModelFlag detects long and short forms, including = form', () => {
  assert.equal(hasModelFlag(['run', '--model', 'foo']), true);
  assert.equal(hasModelFlag(['run', '-m', 'foo']), true);
  assert.equal(hasModelFlag(['run', '--model=foo']), true);
  assert.equal(hasModelFlag(['run', '-m=foo']), true);
  assert.equal(hasModelFlag(['run', '--format', 'json']), false);
  assert.equal(hasModelFlag([]), false);
});

// --- parseModelsOutput ------------------------------------------------------

test('parseModelsOutput parses plain `provider/id` lines', () => {
  const out = 'opencode/big-pickle\nanthropic/claude-sonnet-4-5\ngoogle/gemini-2.5-pro\n';
  const models = parseModelsOutput(out);
  assert.deepEqual(models, [
    { id: 'opencode/big-pickle', label: 'big-pickle' },
    { id: 'anthropic/claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
    { id: 'google/gemini-2.5-pro', label: 'gemini-2.5-pro' },
  ]);
});

test('parseModelsOutput tolerates whitespace prefixes and inline markers', () => {
  const out = [
    '  opencode/big-pickle',
    '✓ anthropic/claude-sonnet-4-5  (free)',
    '* google/gemini-2.5-pro',
    '',
    '   ',
  ].join('\n');
  const models = parseModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), [
    'opencode/big-pickle',
    'anthropic/claude-sonnet-4-5',
    'google/gemini-2.5-pro',
  ]);
});

test('parseModelsOutput strips ANSI color codes', () => {
  const out = '[32mopencode/big-pickle[0m\n';
  assert.deepEqual(parseModelsOutput(out), [
    { id: 'opencode/big-pickle', label: 'big-pickle' },
  ]);
});

test('parseModelsOutput dedupes and skips malformed slash tokens', () => {
  const out = ['opencode/big-pickle', 'opencode/big-pickle', '/oops', 'trailing/', 'header line'].join(
    '\n',
  );
  assert.deepEqual(parseModelsOutput(out), [
    { id: 'opencode/big-pickle', label: 'big-pickle' },
  ]);
});

// --- listModels -------------------------------------------------------------

test('listModels invokes the binary and parses output', async () => {
  const adapter = new OpenCodeAdapter({ binPath: FAKE_OPENCODE });
  const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
  const models = await adapter.listModels(cwd);
  assert.deepEqual(models.map((m) => m.id), [
    'opencode/big-pickle',
    'anthropic/claude-sonnet-4-5',
    'google/gemini-2.5-pro',
  ]);
});

test('listModels passes cwd to the spawned binary', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
  const prev = process.env.FAKE_MODELS_OUTPUT;
  process.env.FAKE_MODELS_OUTPUT = 'opencode/marker\n';
  try {
    // fake-opencode echoes the env-var output regardless of cwd; the assertion
    // that matters is that spawn() didn't throw because of an invalid cwd,
    // which would happen if we passed e.g. an undefined or removed dir.
    const adapter = new OpenCodeAdapter({ binPath: FAKE_OPENCODE });
    const models = await adapter.listModels(cwd);
    assert.deepEqual(models, [{ id: 'opencode/marker', label: 'marker' }]);
  } finally {
    if (prev === undefined) delete process.env.FAKE_MODELS_OUTPUT;
    else process.env.FAKE_MODELS_OUTPUT = prev;
  }
});

test('listModels returns [] when the binary does not exist', async () => {
  const adapter = new OpenCodeAdapter({ binPath: '/nonexistent/path/opencode-xyz' });
  const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
  const models = await adapter.listModels(cwd);
  assert.deepEqual(models, []);
});

// --- spawn / resume argv composition ---------------------------------------

test('spawn passes --format json and --dangerously-skip-permissions by default', async () => {
  await withArgsFile(async (argsPath) => {
    const adapter = new OpenCodeAdapter({ binPath: FAKE_OPENCODE });
    const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
    for await (const _ of adapter.spawn({ prompt: 'hello', appId: 'app' }, cwd)) {
      /* drain */
    }
    const args = readArgs(argsPath);
    assert.equal(args[0], 'run');
    assert.ok(args.includes('--format'));
    assert.ok(args.includes('json'));
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(args.includes('hello'));
  });
});

test('spawn with permissionMode "read" omits --dangerously-skip-permissions', async () => {
  await withArgsFile(async (argsPath) => {
    const adapter = new OpenCodeAdapter({ binPath: FAKE_OPENCODE });
    const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
    for await (const _ of adapter.spawn(
      { prompt: 'p', appId: 'app', permissionMode: 'read' },
      cwd,
    )) {
      /* drain */
    }
    const args = readArgs(argsPath);
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });
});

test('spawn appends --model when adapter has a model set', async () => {
  await withArgsFile(async (argsPath) => {
    const adapter = new OpenCodeAdapter({
      binPath: FAKE_OPENCODE,
      model: 'anthropic/claude-sonnet-4-5',
    });
    const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
    for await (const _ of adapter.spawn({ prompt: 'p', appId: 'app' }, cwd)) {
      /* drain */
    }
    const args = readArgs(argsPath);
    const idx = args.indexOf('--model');
    assert.ok(idx >= 0, '--model present');
    assert.equal(args[idx + 1], 'anthropic/claude-sonnet-4-5');
  });
});

test('spawn does not duplicate --model when extraArgs supplies --model=foo', async () => {
  await withArgsFile(async (argsPath) => {
    const adapter = new OpenCodeAdapter({
      binPath: FAKE_OPENCODE,
      model: 'anthropic/claude-sonnet-4-5',
      extraArgs: ['--model=google/gemini-2.5-pro'],
    });
    const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
    for await (const _ of adapter.spawn({ prompt: 'p', appId: 'app' }, cwd)) {
      /* drain */
    }
    const args = readArgs(argsPath);
    const modelOccurrences = args.filter(
      (a) => a === '--model' || a.startsWith('--model='),
    ).length;
    assert.equal(modelOccurrences, 1, 'only the extraArgs --model= form is present');
    assert.ok(args.includes('--model=google/gemini-2.5-pro'));
    assert.ok(!args.includes('anthropic/claude-sonnet-4-5'));
  });
});

test('resume includes --session <id> before the prompt', async () => {
  await withArgsFile(async (argsPath) => {
    const adapter = new OpenCodeAdapter({ binPath: FAKE_OPENCODE });
    const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
    for await (const _ of adapter.resume(
      { prompt: 'again', appId: 'app', sessionId: 'ses_abc' },
      cwd,
    )) {
      /* drain */
    }
    const args = readArgs(argsPath);
    const idx = args.indexOf('--session');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], 'ses_abc');
  });
});

// --- stream / lifecycle -----------------------------------------------------

test('spawn maps NDJSON events to AgentMessage stream with shared sessionId', async () => {
  const adapter = new OpenCodeAdapter({ binPath: FAKE_OPENCODE });
  const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
  const prev = process.env.FAKE_SESSION_ID;
  process.env.FAKE_SESSION_ID = 'ses_test-1';
  try {
    const seen: Array<{ type: string; sessionId: string }> = [];
    for await (const ev of adapter.spawn({ prompt: 'p', appId: 'app' }, cwd)) {
      seen.push({ type: ev.type, sessionId: ev.sessionId });
    }
    // First event is the superconnector spawn_meta with empty sessionId
    assert.equal(seen[0]!.type, 'superconnector');
    assert.equal(seen[0]!.sessionId, '');
    // Then the NDJSON events, all sharing ses_test-1
    const rest = seen.slice(1);
    assert.deepEqual(rest.map((s) => s.type), ['system', 'assistant', 'result']);
    assert.ok(rest.every((s) => s.sessionId === 'ses_test-1'));
  } finally {
    if (prev === undefined) delete process.env.FAKE_SESSION_ID;
    else process.env.FAKE_SESSION_ID = prev;
  }
});

test('spawn throws AdapterFailedError when the binary exits non-zero', async () => {
  const adapter = new OpenCodeAdapter({ binPath: FAKE_OPENCODE });
  const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
  const prev = process.env.RUN_SCENARIO;
  process.env.RUN_SCENARIO = 'fail';
  try {
    await assert.rejects(
      async () => {
        for await (const _ of adapter.spawn({ prompt: 'p', appId: 'app' }, cwd)) {
          /* drain */
        }
      },
      (e: unknown) => e instanceof AdapterFailedError && /simulated failure/.test((e as AdapterFailedError).stderr),
    );
  } finally {
    if (prev === undefined) delete process.env.RUN_SCENARIO;
    else process.env.RUN_SCENARIO = prev;
  }
});

test('runOpenCode ignores malformed/unknown lines and handles partial large stream chunks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
  const prev = process.env.RUN_SCENARIO;
  process.env.RUN_SCENARIO = 'malformed-stream';
  try {
    const msgs: AgentMessage[] = [];
    for await (const ev of runOpenCode({ binPath: FAKE_OPENCODE, args: ['run', '--format', 'json', 'p'], cwd })) {
      msgs.push(ev);
    }
    assert.deepEqual(
      msgs.map((m) => m.type),
      ['superconnector', 'assistant', 'assistant', 'result'],
    );
    assert.equal((msgs[1]!.content as { text?: string }).text, 'partial');
    assert.equal((msgs[2]!.content as { text?: string }).text?.length, 8192);
  } finally {
    if (prev === undefined) delete process.env.RUN_SCENARIO;
    else process.env.RUN_SCENARIO = prev;
  }
});

test('runOpenCode stops cleanly when aborted', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
  const prev = process.env.RUN_SCENARIO;
  process.env.RUN_SCENARIO = 'slow';
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  try {
    const msgs: AgentMessage[] = [];
    for await (const ev of runOpenCode({
      binPath: FAKE_OPENCODE,
      args: ['run', '--format', 'json', 'p'],
      cwd,
      signal: ctrl.signal,
    })) {
      msgs.push(ev);
    }
    assert.ok(ctrl.signal.aborted);
    assert.equal(msgs[0]!.type, 'superconnector');
  } finally {
    if (prev === undefined) delete process.env.RUN_SCENARIO;
    else process.env.RUN_SCENARIO = prev;
  }
});

test('spawn with onApprovalRequest emits advisory approval_unsupported event', async () => {
  const adapter = new OpenCodeAdapter({ binPath: FAKE_OPENCODE });
  const cwd = mkdtempSync(join(tmpdir(), 'oc-cwd-'));
  const advisory: unknown[] = [];
  for await (const ev of adapter.spawn(
    { prompt: 'p', appId: 'app', onApprovalRequest: async () => ({ decision: 'allow' }) },
    cwd,
  )) {
    if (ev.type === 'superconnector') {
      const c = ev.content as { subtype?: string } | null;
      if (c?.subtype === 'approval_unsupported') advisory.push(c);
    }
  }
  assert.equal(advisory.length, 1);
});
