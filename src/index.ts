import { ClaudeCodeAdapter } from './adapters/claude-code/index.js';
import { CodexAdapter } from './adapters/codex/index.js';
import { OpenCodeAdapter } from './adapters/opencode/index.js';
import { detectAdapter } from './detect.js';
import { AdapterNotSetError, UnknownSessionError } from './errors.js';
import {
  defaultRegistryPaths,
  findLatestSession,
  listSessions as listSessionsImpl,
  recordResume,
  recordSpawn,
} from './registry.js';
import type {
  Adapter,
  AdapterKind,
  AgentMessage,
  ResumeOptions,
  SessionRecord,
  SpawnOptions,
  Superconnector,
} from './types.js';

export * from './types.js';
export * from './errors.js';
export { detectAdapter } from './detect.js';
export { ClaudeCodeAdapter } from './adapters/claude-code/index.js';
export { OpenCodeAdapter } from './adapters/opencode/index.js';
export { CodexAdapter } from './adapters/codex/index.js';

export interface CreateOptions {
  adapter?: Adapter | AdapterKind;
  cwd?: string;
}

function buildAdapter(kind: AdapterKind): Adapter {
  switch (kind) {
    case 'claude-code':
      return new ClaudeCodeAdapter();
    case 'opencode':
      return new OpenCodeAdapter();
    case 'codex':
      return new CodexAdapter();
  }
}

export function createSuperconnector(opts: CreateOptions = {}): Superconnector {
  const cwd = opts.cwd ?? process.cwd();
  let adapter: Adapter | null = null;

  if (opts.adapter) {
    adapter = typeof opts.adapter === 'string' ? buildAdapter(opts.adapter) : opts.adapter;
  } else {
    const detected = detectAdapter(cwd);
    if (detected) adapter = buildAdapter(detected);
  }

  const requireAdapter = (): Adapter => {
    if (!adapter) throw new AdapterNotSetError();
    return adapter;
  };

  return {
    detectAdapter(): AdapterKind | null {
      return detectAdapter(cwd);
    },
    getAdapter(): Adapter {
      return requireAdapter();
    },
    setAdapter(next: Adapter | AdapterKind): void {
      adapter = typeof next === 'string' ? buildAdapter(next) : next;
    },
    listSessions(filter?: { appLabel?: string }): SessionRecord[] {
      return listSessionsImpl({
        cwd,
        ...(filter?.appLabel !== undefined ? { appLabel: filter.appLabel } : {}),
      });
    },
    spawn(spawnOpts: SpawnOptions): AsyncIterable<AgentMessage> {
      const a = requireAdapter();
      if (spawnOpts.resumeLastCreatedSession) {
        const latest = findLatestSession({ cwd, appLabel: spawnOpts.appLabel });
        if (latest) {
          return runResume(a, {
            prompt: spawnOpts.prompt,
            appLabel: spawnOpts.appLabel,
            sessionId: latest.sessionId,
            ...(spawnOpts.signal !== undefined ? { signal: spawnOpts.signal } : {}),
          }, cwd);
        }
      }
      return runSpawn(a, spawnOpts, cwd);
    },
    resume(resumeOpts: ResumeOptions): AsyncIterable<AgentMessage> {
      const a = requireAdapter();
      const existing = findLatestSession({ cwd, appLabel: resumeOpts.appLabel });
      const found = existing && listSessionsImpl({ cwd, appLabel: resumeOpts.appLabel })
        .some((s) => s.sessionId === resumeOpts.sessionId);
      if (!found) {
        throw new UnknownSessionError(resumeOpts.sessionId, resumeOpts.appLabel, cwd);
      }
      return runResume(a, resumeOpts, cwd);
    },
  };
}

async function* runSpawn(
  adapter: Adapter,
  opts: SpawnOptions,
  cwd: string,
): AsyncIterable<AgentMessage> {
  let recorded = false;
  for await (const msg of adapter.spawn(opts, cwd)) {
    if (!recorded && msg.sessionId) {
      recordSpawn({ cwd, appLabel: opts.appLabel, adapter: adapter.kind, sessionId: msg.sessionId });
      recorded = true;
    }
    yield msg;
  }
}

async function* runResume(
  adapter: Adapter,
  opts: ResumeOptions,
  cwd: string,
): AsyncIterable<AgentMessage> {
  recordResume({ cwd, appLabel: opts.appLabel, sessionId: opts.sessionId });
  for await (const msg of adapter.resume(opts, cwd)) {
    yield msg;
  }
}

// re-export registry helpers for power users
export { defaultRegistryPaths, listSessionsImpl as listSessions };
