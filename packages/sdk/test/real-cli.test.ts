import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { CodexAdapter } from '../src/adapters/codex/index.js';
import { OpenCodeAdapter } from '../src/adapters/opencode/index.js';
import { isExecutableAvailable } from '../src/util/executable.js';
import type { Adapter, AdapterModel, AgentMessage } from '../src/types.js';

const enabled = process.env.SUPERCONNECTOR_REAL_CLI_TESTS === '1';
const liveSpawnEnabled = process.env.SUPERCONNECTOR_REAL_CLI_SPAWN === '1';

type RealCase = {
  name: string;
  command: string;
  envVar: 'CLAUDE_BIN' | 'OPENCODE_BIN' | 'CODEX_BIN';
  makeAdapter: (binPath: string) => Adapter;
  markers: Array<(cwd: string) => void>;
};

const cases: RealCase[] = [
  {
    name: 'Claude Code',
    command: 'claude',
    envVar: 'CLAUDE_BIN',
    makeAdapter: (binPath) => new ClaudeCodeAdapter({ binPath }),
    markers: [
      (cwd) => mkdirSync(join(cwd, '.claude')),
      (cwd) => writeFileSync(join(cwd, 'CLAUDE.md'), '# claude\n', 'utf8'),
    ],
  },
  {
    name: 'OpenCode',
    command: 'opencode',
    envVar: 'OPENCODE_BIN',
    makeAdapter: (binPath) => new OpenCodeAdapter({ binPath }),
    markers: [
      (cwd) => mkdirSync(join(cwd, '.opencode')),
      (cwd) => writeFileSync(join(cwd, 'opencode.json'), '{}\n', 'utf8'),
    ],
  },
  {
    name: 'Codex',
    command: 'codex',
    envVar: 'CODEX_BIN',
    makeAdapter: (binPath) => new CodexAdapter({ binPath }),
    markers: [
      (cwd) => mkdirSync(join(cwd, '.codex')),
      (cwd) => writeFileSync(join(cwd, 'AGENTS.md'), '# agents\n', 'utf8'),
    ],
  },
];

function configuredBin(c: RealCase): string {
  return process.env[c.envVar] || c.command;
}

function modelsHaveShape(models: AdapterModel[]): boolean {
  return models.every((m) => typeof m.id === 'string' && m.id.length > 0);
}

async function drainUntilResult(iter: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const msg of iter) {
    out.push(msg);
    if (msg.type === 'result') break;
  }
  return out;
}

test('real CLI contract tests are opt-in', { skip: enabled }, () => {
  assert.equal(enabled, false);
});

for (const c of cases) {
  test(
    `${c.name} real CLI contract`,
    { skip: !enabled || !isExecutableAvailable(configuredBin(c)) },
    async (t) => {
      const binPath = configuredBin(c);
      assert.equal(isExecutableAvailable(binPath), true);

      await t.test('detects each project marker with the real binary', () => {
        for (const writeMarker of c.markers) {
          const cwd = mkdtempSync(join(tmpdir(), 'sc-real-detect-'));
          writeMarker(cwd);
          assert.equal(c.makeAdapter(binPath).detect(cwd), true);
        }
      });

      await t.test('listModels returns valid model-shaped data when implemented', async () => {
        const adapter = c.makeAdapter(binPath);
        const models = await adapter.listModels?.(mkdtempSync(join(tmpdir(), 'sc-real-models-')));
        if (models !== undefined) {
          assert.equal(Array.isArray(models), true);
          assert.equal(modelsHaveShape(models), true);
        }
      });

      await t.test('unusable explicit binary fails cleanly', async () => {
        const missing = c.makeAdapter('/nonexistent/superconnector-real-cli');
        const cwd = mkdtempSync(join(tmpdir(), 'sc-real-missing-'));
        c.markers[0]!(cwd);
        assert.equal(missing.detect(cwd), false);
        await assert.doesNotReject(async () => {
          await missing.listModels?.(cwd);
        });
      });

      await t.test(
        'optional live spawn emits a session id and terminal event',
        {
          skip: !liveSpawnEnabled,
        },
        async () => {
          const cwd = mkdtempSync(join(tmpdir(), 'sc-real-spawn-'));
          c.markers[0]!(cwd);
          const adapter = c.makeAdapter(binPath);
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 60_000);
          try {
            const messages = await drainUntilResult(
              adapter.spawn(
                {
                  prompt: 'Reply with OK only.',
                  appId: 'real-cli-contract',
                  permissionMode: 'read',
                  signal: ctrl.signal,
                },
                cwd,
              ),
            );
            assert.ok(messages.some((m) => m.sessionId));
            assert.ok(messages.some((m) => m.type === 'result'));
          } finally {
            clearTimeout(timer);
          }
        },
      );
    },
  );
}
