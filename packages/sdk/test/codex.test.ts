import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/adapters/codex/index.js';
import { buildCodexResumeCommand, runCodex } from '../src/adapters/codex/process.js';
import { AdapterFailedError } from '../src/errors.js';
import { createSuperconnector, readSessionLog } from '../src/index.js';
import type { AgentMessage } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(here, 'fake-codex.mjs');

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'sc-codex-cwd-'));
}

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sc-codex-home-'));
  process.env.SUPERCONNECTOR_HOME = home;
  return home;
}

async function drain(iterable: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const msg of iterable) out.push(msg);
  return out;
}

async function withScenario<T>(scenario: string, fn: () => Promise<T>): Promise<T> {
  const prevScenario = process.env.SCENARIO;
  const prevSession = process.env.FAKE_SESSION_ID;
  process.env.SCENARIO = scenario;
  process.env.FAKE_SESSION_ID = 'codex-sess-1';
  try {
    return await fn();
  } finally {
    if (prevScenario === undefined) delete process.env.SCENARIO;
    else process.env.SCENARIO = prevScenario;
    if (prevSession === undefined) delete process.env.FAKE_SESSION_ID;
    else process.env.FAKE_SESSION_ID = prevSession;
  }
}

test('runCodex emits spawn metadata and normalizes Codex JSONL messages', async () => {
  await withScenario('ok', async () => {
    const msgs = await drain(runCodex({ binPath: FAKE_CODEX, args: ['exec', '--json', 'go'], cwd: tmpCwd() }));
    assert.equal(msgs[0]!.type, 'superconnector');
    assert.deepEqual(
      msgs.map((m) => m.type),
      ['superconnector', 'system', 'assistant', 'tool_use', 'tool_result', 'result'],
    );
    assert.equal(msgs[1]!.sessionId, 'codex-sess-1');
    assert.deepEqual(msgs[2]!.content, { content: 'hi' });
    assert.equal((msgs[2]!.raw as { type?: string }).type, 'agent_message');
  });
});

test('runCodex throws AdapterFailedError on nonzero exit', async () => {
  await withScenario('failure', async () => {
    await assert.rejects(
      async () => {
        await drain(runCodex({ binPath: FAKE_CODEX, args: ['exec', '--json', 'go'], cwd: tmpCwd() }));
      },
      (err) =>
        err instanceof AdapterFailedError &&
        err.exitCode === 1 &&
        /codex failed/.test(err.stderr),
    );
  });
});

test('runCodex throws AdapterFailedError when no session id is emitted', async () => {
  await withScenario('no-session', async () => {
    await assert.rejects(
      async () => {
        await drain(runCodex({ binPath: FAKE_CODEX, args: ['exec', '--json', 'go'], cwd: tmpCwd() }));
      },
      (err) => err instanceof AdapterFailedError && /without emitting a session id/.test(err.message),
    );
  });
});

test('CodexAdapter spawn builds codex exec command with workspace-write by default', async () => {
  await withScenario('ok', async () => {
    isolatedHome();
    const cwd = tmpCwd();
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX });
    const sc = createSuperconnector({ adapter, cwd });
    await drain(sc.spawn({ prompt: 'hi', appId: 'app' }));

    const log = readSessionLog('codex-sess-1');
    assert.ok(log);
    assert.deepEqual(log!.args, ['exec', '--json', '--sandbox', 'workspace-write', 'hi']);
    assert.equal(log!.resumeCommand, buildCodexResumeCommand(cwd, 'codex-sess-1'));
  });
});

test('CodexAdapter spawn maps read permission mode to read-only sandbox', async () => {
  await withScenario('ok', async () => {
    isolatedHome();
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX });
    const sc = createSuperconnector({ adapter, cwd: tmpCwd() });
    await drain(sc.spawn({ prompt: 'read', appId: 'app', permissionMode: 'read' }));

    const log = readSessionLog('codex-sess-1');
    assert.ok(log);
    assert.deepEqual(log!.args, ['exec', '--json', '--sandbox', 'read-only', 'read']);
    assert.equal(log!.permissionMode, 'read');
  });
});

test('CodexAdapter appends configured model before the prompt', async () => {
  await withScenario('ok', async () => {
    isolatedHome();
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX, model: 'configured-codex' });
    const sc = createSuperconnector({ adapter, cwd: tmpCwd() });
    await drain(sc.spawn({ prompt: 'model prompt', appId: 'app' }));

    const log = readSessionLog('codex-sess-1');
    assert.ok(log);
    assert.deepEqual(log!.args, [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--model',
      'configured-codex',
      'model prompt',
    ]);
  });
});

test('CodexAdapter does not duplicate model when extraArgs already specify one', async () => {
  await withScenario('ok', async () => {
    isolatedHome();
    const adapter = new CodexAdapter({
      binPath: FAKE_CODEX,
      model: 'configured-codex',
      extraArgs: ['--model', 'extra-codex'],
    });
    const sc = createSuperconnector({ adapter, cwd: tmpCwd() });
    await drain(sc.spawn({ prompt: 'model prompt', appId: 'app' }));

    const log = readSessionLog('codex-sess-1');
    assert.ok(log);
    assert.equal(log!.args.filter((a) => a === '--model').length, 1);
    assert.ok(log!.args.includes('extra-codex'));
    assert.ok(!log!.args.includes('configured-codex'));
  });
});

test('CodexAdapter resume builds codex exec resume command', async () => {
  await withScenario('ok', async () => {
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX });
    const msgs = await drain(adapter.resume({
      prompt: 'continue',
      appId: 'app',
      sessionId: 'resume-sess-1',
      permissionMode: 'read',
    }, tmpCwd()));

    const meta = msgs[0]!;
    assert.equal(meta.type, 'superconnector');
    assert.deepEqual((meta.content as { args: string[] }).args, [
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      'resume',
      'resume-sess-1',
      'continue',
    ]);
    assert.equal(msgs[1]!.sessionId, 'resume-sess-1');
  });
});

test('CodexAdapter rejects approval callbacks', async () => {
  const adapter = new CodexAdapter({ binPath: FAKE_CODEX });
  await assert.rejects(
    async () => {
      await drain(adapter.spawn({
        prompt: 'approve',
        appId: 'app',
        onApprovalRequest: async () => ({ decision: 'allow' }),
      }, tmpCwd()));
    },
    (err) =>
      err instanceof AdapterFailedError &&
      /approval callbacks/.test(err.message),
  );
});

test('CodexAdapter listModels uses live catalog first', async () => {
  await withScenario('ok', async () => {
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX });
    assert.deepEqual(await adapter.listModels(tmpCwd()), [
      { id: 'live-codex', label: 'Live Codex', description: 'Live catalog model' },
    ]);
  });
});

test('CodexAdapter listModels falls back to bundled catalog', async () => {
  await withScenario('models-fail-live', async () => {
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX });
    assert.deepEqual(await adapter.listModels(tmpCwd()), [
      { id: 'bundled-codex', label: 'Bundled Codex', description: 'Bundled catalog model' },
    ]);
  });
});

test('CodexAdapter listModels returns static fallback when CLI catalogs fail', async () => {
  await withScenario('models-fail-all', async () => {
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX });
    const models = await adapter.listModels(tmpCwd());
    assert.equal(models[0]!.id, 'gpt-5.3-codex');
    assert.ok(models.some((m) => m.id === 'gpt-5-codex'));
  });
});
