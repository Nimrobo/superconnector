import { hostname, platform, userInfo } from 'node:os';
import { ClaudeCodeAdapter } from './adapters/claude-code/index.js';
import { CodexAdapter } from './adapters/codex/index.js';
import { OpenCodeAdapter } from './adapters/opencode/index.js';
import { resolveConfig, type SuperconnectorConfig } from './config.js';
import { detectAdapter } from './detect.js';
import { AdapterNotSetError, PermissionRequiredError, UnknownSessionError } from './errors.js';
import {
  appendApproval,
  defaultRegistryPaths,
  findLatestSession,
  listSessions as listSessionsImpl,
  readSessionLog,
  recordResume,
  recordSpawn,
  sessionLogPath,
  updateSessionLog,
  writeSessionLog,
  type SessionLog,
} from './registry.js';
import type {
  Adapter,
  AdapterKind,
  AgentMessage,
  PermissionMode,
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

function buildAdapter(kind: AdapterKind, config: SuperconnectorConfig): Adapter {
  const model = config.models?.[kind];
  switch (kind) {
    case 'claude-code':
      return new ClaudeCodeAdapter(model !== undefined ? { model } : {});
    case 'opencode':
      return new OpenCodeAdapter(model !== undefined ? { model } : {});
    case 'codex':
      return new CodexAdapter(model !== undefined ? { model } : {});
  }
}

export function createSuperconnector(opts: CreateOptions = {}): Superconnector {
  const cwd = opts.cwd ?? process.cwd();
  const config = resolveConfig(cwd).merged;
  let adapter: Adapter | null = null;

  if (opts.adapter) {
    adapter = typeof opts.adapter === 'string' ? buildAdapter(opts.adapter, config) : opts.adapter;
  } else if (config.preferredAdapter) {
    adapter = buildAdapter(config.preferredAdapter, config);
  } else {
    const detected = detectAdapter(cwd);
    if (detected) adapter = buildAdapter(detected, config);
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
      adapter = typeof next === 'string' ? buildAdapter(next, config) : next;
    },
    listSessions(filter?: { appLabel?: string }): SessionRecord[] {
      return listSessionsImpl({
        cwd,
        ...(filter?.appLabel !== undefined ? { appLabel: filter.appLabel } : {}),
      });
    },
    spawn(spawnOpts: SpawnOptions): AsyncIterable<AgentMessage> {
      const a = requireAdapter();
      if (spawnOpts.permissionMode === undefined && config.permissionMode !== undefined) {
        spawnOpts = { ...spawnOpts, permissionMode: config.permissionMode };
      }
      if (spawnOpts.resumeLastCreatedSession) {
        const latest = findLatestSession({ cwd, appLabel: spawnOpts.appLabel });
        if (latest) {
          return runResume(
            a,
            {
              prompt: spawnOpts.prompt,
              appLabel: spawnOpts.appLabel,
              sessionId: latest.sessionId,
              ...(spawnOpts.signal !== undefined ? { signal: spawnOpts.signal } : {}),
              ...(spawnOpts.permissionMode !== undefined
                ? { permissionMode: spawnOpts.permissionMode }
                : {}),
              ...(spawnOpts.onApprovalRequest !== undefined
                ? { onApprovalRequest: spawnOpts.onApprovalRequest }
                : {}),
              ...(spawnOpts.approvalTimeoutMs !== undefined
                ? { approvalTimeoutMs: spawnOpts.approvalTimeoutMs }
                : {}),
            },
            cwd,
          );
        }
      }
      return runSpawn(a, spawnOpts, cwd);
    },
    resume(resumeOpts: ResumeOptions): AsyncIterable<AgentMessage> {
      const a = requireAdapter();
      if (resumeOpts.permissionMode === undefined && config.permissionMode !== undefined) {
        resumeOpts = { ...resumeOpts, permissionMode: config.permissionMode };
      }
      const found = listSessionsImpl({ cwd, appLabel: resumeOpts.appLabel })
        .some((s) => s.sessionId === resumeOpts.sessionId);
      if (!found) {
        throw new UnknownSessionError(resumeOpts.sessionId, resumeOpts.appLabel, cwd);
      }
      return runResume(a, resumeOpts, cwd);
    },
  };
}

interface SpawnMeta {
  pid: number | null;
  binPath: string;
  args: string[];
  cwd: string;
}

function readSpawnMeta(msg: AgentMessage): SpawnMeta | null {
  if (msg.type !== 'superconnector') return null;
  const c = msg.content as Record<string, unknown> | null | undefined;
  if (!c || c['subtype'] !== 'spawn_meta') return null;
  return {
    pid: typeof c['pid'] === 'number' ? (c['pid'] as number) : null,
    binPath: String(c['binPath'] ?? ''),
    args: Array.isArray(c['args']) ? (c['args'] as string[]) : [],
    cwd: String(c['cwd'] ?? ''),
  };
}

function readApprovalDecision(msg: AgentMessage): {
  toolName: string;
  decision: 'allow' | 'deny';
  reason: string;
} | null {
  if (msg.type !== 'superconnector') return null;
  const c = msg.content as Record<string, unknown> | null | undefined;
  if (!c || c['subtype'] !== 'approval_decision') return null;
  return {
    toolName: String(c['toolName'] ?? ''),
    decision: c['decision'] === 'allow' ? 'allow' : 'deny',
    reason: String(c['reason'] ?? ''),
  };
}

function buildSessionLog(args: {
  sessionId: string;
  adapter: AdapterKind;
  appLabel: string;
  cwd: string;
  meta: SpawnMeta | null;
  prompt: string;
  permissionMode: PermissionMode;
  approvalServerEnabled: boolean;
  resumeCommand: string;
}): SessionLog {
  const now = new Date().toISOString();
  const ui = (() => {
    try {
      return userInfo().username;
    } catch {
      return '';
    }
  })();
  return {
    sessionId: args.sessionId,
    adapter: args.adapter,
    appLabel: args.appLabel,
    cwd: args.cwd,
    binPath: args.meta?.binPath ?? '',
    args: args.meta?.args ?? [],
    promptPreview: args.prompt.slice(0, 500),
    pid: args.meta?.pid ?? null,
    ppid: process.pid,
    hostname: hostname(),
    user: ui,
    platform: platform(),
    nodeVersion: process.version,
    permissionMode: args.permissionMode,
    approvalServerEnabled: args.approvalServerEnabled,
    createdAt: now,
    lastUsedAt: now,
    closedAt: null,
    exitCode: null,
    stderrTail: '',
    permissionFailure: false,
    resumeCommand: args.resumeCommand,
    approvals: [],
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildResumeCommand(cwd: string, sessionId: string): string {
  return `(cd ${shellQuote(cwd)} && claude --resume ${shellQuote(sessionId)})`;
}

async function* runSpawn(
  adapter: Adapter,
  opts: SpawnOptions,
  cwd: string,
): AsyncIterable<AgentMessage> {
  const permissionMode: PermissionMode = opts.permissionMode ?? 'acceptEdits';
  const approvalServerEnabled = !!opts.onApprovalRequest;
  let pendingMeta: SpawnMeta | null = null;
  let logged = false;
  let observedSessionId = '';
  const pendingApprovals: Array<{ at: string; toolName: string; decision: 'allow' | 'deny'; reason: string }> = [];

  try {
    for await (const msg of adapter.spawn(opts, cwd)) {
      const meta = readSpawnMeta(msg);
      if (meta) {
        pendingMeta = meta;
        continue; // do not yield internal meta to the consumer
      }

      if (!observedSessionId && msg.sessionId) {
        observedSessionId = msg.sessionId;
        recordSpawn({ cwd, appLabel: opts.appLabel, adapter: adapter.kind, sessionId: observedSessionId });
        if (!logged) {
          const log = buildSessionLog({
            sessionId: observedSessionId,
            adapter: adapter.kind,
            appLabel: opts.appLabel,
            cwd,
            meta: pendingMeta,
            prompt: opts.prompt,
            permissionMode,
            approvalServerEnabled,
            resumeCommand: buildResumeCommand(cwd, observedSessionId),
          });
          // Replay any approvals that arrived before sessionId was known.
          log.approvals = pendingApprovals.slice();
          writeSessionLog(log);
          logged = true;
        }
      }

      const approval = readApprovalDecision(msg);
      if (approval) {
        const entry = { at: new Date().toISOString(), ...approval };
        if (logged && observedSessionId) {
          appendApproval(observedSessionId, entry);
        } else {
          pendingApprovals.push(entry);
        }
      }

      yield msg;
    }
    if (logged && observedSessionId) {
      updateSessionLog(observedSessionId, {
        closedAt: new Date().toISOString(),
        exitCode: 0,
      });
    }
  } catch (e) {
    if (logged && observedSessionId) {
      const patch: Partial<SessionLog> = {
        closedAt: new Date().toISOString(),
        exitCode: e instanceof Error && 'exitCode' in e ? ((e as { exitCode: number | null }).exitCode) : null,
      };
      if (e instanceof PermissionRequiredError) {
        patch.permissionFailure = true;
        patch.resumeCommand = e.resumeCommand;
        patch.stderrTail = e.stderr;
      } else if (e instanceof Error && 'stderr' in e) {
        patch.stderrTail = (e as { stderr: string }).stderr;
      }
      updateSessionLog(observedSessionId, patch);
    }
    throw e;
  }
}

async function* runResume(
  adapter: Adapter,
  opts: ResumeOptions,
  cwd: string,
): AsyncIterable<AgentMessage> {
  recordResume({ cwd, appLabel: opts.appLabel, sessionId: opts.sessionId });
  updateSessionLog(opts.sessionId, { lastUsedAt: new Date().toISOString() });
  try {
    for await (const msg of adapter.resume(opts, cwd)) {
      // Strip internal spawn_meta from the consumer-facing stream.
      if (readSpawnMeta(msg)) continue;
      const approval = readApprovalDecision(msg);
      if (approval) {
        appendApproval(opts.sessionId, { at: new Date().toISOString(), ...approval });
      }
      yield msg;
    }
    updateSessionLog(opts.sessionId, { closedAt: new Date().toISOString(), exitCode: 0 });
  } catch (e) {
    const patch: Partial<SessionLog> = { closedAt: new Date().toISOString() };
    if (e instanceof PermissionRequiredError) {
      patch.permissionFailure = true;
      patch.resumeCommand = e.resumeCommand;
      patch.stderrTail = e.stderr;
      patch.exitCode = e.exitCode;
    } else if (e instanceof Error && 'stderr' in e) {
      const ae = e as unknown as { stderr: string; exitCode?: number | null };
      patch.stderrTail = ae.stderr;
      patch.exitCode = ae.exitCode ?? null;
    }
    updateSessionLog(opts.sessionId, patch);
    throw e;
  }
}

// re-export registry helpers for power users
export {
  defaultRegistryPaths,
  listSessionsImpl as listSessions,
  readSessionLog,
  sessionLogPath,
};
