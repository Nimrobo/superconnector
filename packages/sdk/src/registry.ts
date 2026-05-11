import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AdapterKind, SessionRecord } from './types.js';

interface RegistryApp {
  cwd: string;
  appId: string;
  sessions: SessionRecord[];
}

interface RegistryFile {
  version: 2;
  apps: RegistryApp[];
}

export interface RegistryPaths {
  root: string;
  file: string;
}

export function defaultRegistryPaths(): RegistryPaths {
  const root = process.env.SUPERCONNECTOR_HOME ?? join(homedir(), '.superconnector');
  return { root, file: join(root, 'registry.json') };
}

export interface ApprovalLogEntry {
  at: string;
  toolName: string;
  decision: 'allow' | 'deny';
  reason: string;
}

export interface SessionLog {
  sessionId: string;
  adapter: AdapterKind;
  appId: string;
  sessionSelector?: string;
  cwd: string;
  binPath: string;
  args: string[];
  promptPreview: string;
  pid: number | null;
  ppid: number | null;
  hostname: string;
  user: string;
  platform: string;
  nodeVersion: string;
  permissionMode: 'read' | 'acceptEdits';
  approvalServerEnabled: boolean;
  createdAt: string;
  lastUsedAt: string;
  closedAt: string | null;
  exitCode: number | null;
  stderrTail: string;
  permissionFailure: boolean;
  resumeCommand: string;
  approvals: ApprovalLogEntry[];
}

export function sessionLogPath(sessionId: string, paths: RegistryPaths = defaultRegistryPaths()): string {
  return join(paths.root, 'sessions', `${sessionId}.json`);
}

function atomicWriteJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function writeSessionLog(log: SessionLog, paths: RegistryPaths = defaultRegistryPaths()): void {
  atomicWriteJson(sessionLogPath(log.sessionId, paths), log);
}

export function readSessionLog(sessionId: string, paths: RegistryPaths = defaultRegistryPaths()): SessionLog | null {
  const file = sessionLogPath(sessionId, paths);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SessionLog;
  } catch {
    return null;
  }
}

export function updateSessionLog(
  sessionId: string,
  patch: Partial<SessionLog> | ((current: SessionLog) => SessionLog),
  paths: RegistryPaths = defaultRegistryPaths(),
): SessionLog | null {
  const current = readSessionLog(sessionId, paths);
  if (!current) return null;
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
  atomicWriteJson(sessionLogPath(sessionId, paths), next);
  return next;
}

export function appendApproval(
  sessionId: string,
  entry: ApprovalLogEntry,
  paths: RegistryPaths = defaultRegistryPaths(),
): void {
  updateSessionLog(
    sessionId,
    (cur) => ({ ...cur, approvals: [...cur.approvals, entry], lastUsedAt: new Date().toISOString() }),
    paths,
  );
}

function readRegistry(paths: RegistryPaths): RegistryFile {
  if (!existsSync(paths.file)) {
    return { version: 2, apps: [] };
  }
  try {
    const raw = readFileSync(paths.file, 'utf8');
    const parsed = JSON.parse(raw) as RegistryFile;
    if (parsed.version !== 2 || !Array.isArray(parsed.apps)) {
      return { version: 2, apps: [] };
    }
    return parsed;
  } catch {
    return { version: 2, apps: [] };
  }
}

function writeRegistry(paths: RegistryPaths, data: RegistryFile): void {
  mkdirSync(dirname(paths.file), { recursive: true });
  const tmp = `${paths.file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, paths.file);
}

export function recordSpawn(
  args: { cwd: string; appId: string; adapter: AdapterKind; sessionId: string; sessionSelector?: string },
  paths: RegistryPaths = defaultRegistryPaths(),
): SessionRecord {
  const data = readRegistry(paths);
  const now = new Date().toISOString();
  const record: SessionRecord = {
    sessionId: args.sessionId,
    adapter: args.adapter,
    appId: args.appId,
    ...(args.sessionSelector !== undefined ? { sessionSelector: args.sessionSelector } : {}),
    cwd: args.cwd,
    createdAt: now,
    lastUsedAt: now,
  };
  const existing = data.apps.find((app) => app.cwd === args.cwd && app.appId === args.appId);
  if (existing) {
    existing.sessions.push(record);
  } else {
    data.apps.push({
      cwd: args.cwd,
      appId: args.appId,
      sessions: [record],
    });
  }
  writeRegistry(paths, data);
  return record;
}

export function recordResume(
  args: { cwd: string; appId: string; sessionId: string; sessionSelector?: string },
  paths: RegistryPaths = defaultRegistryPaths(),
): SessionRecord | null {
  const data = readRegistry(paths);
  const entry = data.apps.find((app) => app.cwd === args.cwd && app.appId === args.appId);
  if (!entry) return null;
  const session = entry.sessions.find(
    (s) =>
      s.sessionId === args.sessionId &&
      (args.sessionSelector === undefined || s.sessionSelector === args.sessionSelector),
  );
  if (!session) return null;
  session.lastUsedAt = new Date().toISOString();
  writeRegistry(paths, data);
  return session;
}

export function listSessions(
  args: { cwd: string; appId?: string; sessionSelector?: string },
  paths: RegistryPaths = defaultRegistryPaths(),
): SessionRecord[] {
  const data = readRegistry(paths);
  const out: SessionRecord[] = [];
  for (const entry of data.apps) {
    if (entry.cwd !== args.cwd) continue;
    if (args.appId !== undefined && entry.appId !== args.appId) continue;
    for (const session of entry.sessions) {
      if (args.sessionSelector !== undefined && session.sessionSelector !== args.sessionSelector) continue;
      out.push(session);
    }
  }
  out.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return out;
}

export function findLatestSession(
  args: { cwd: string; appId: string; sessionSelector?: string },
  paths: RegistryPaths = defaultRegistryPaths(),
): SessionRecord | null {
  const sessions = listSessions({ cwd: args.cwd, appId: args.appId }, paths).filter((s) =>
    args.sessionSelector === undefined
      ? s.sessionSelector === undefined
      : s.sessionSelector === args.sessionSelector,
  );
  return sessions[0] ?? null;
}
