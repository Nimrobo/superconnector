import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AdapterKind, SessionRecord } from './types.js';

interface RegistryEntry {
  cwd: string;
  appLabel: string;
  adapter: AdapterKind;
  sessions: SessionRecord[];
}

interface RegistryFile {
  version: 1;
  entries: Record<string, RegistryEntry>;
}

export interface RegistryPaths {
  root: string;
  file: string;
}

export function defaultRegistryPaths(): RegistryPaths {
  const root = process.env.SUPERCONNECTOR_HOME ?? join(homedir(), '.superconnector');
  return { root, file: join(root, 'registry.json') };
}

function entryKey(cwd: string, appLabel: string): string {
  return `${cwd}::${appLabel}`;
}

function readRegistry(paths: RegistryPaths): RegistryFile {
  if (!existsSync(paths.file)) {
    return { version: 1, entries: {} };
  }
  try {
    const raw = readFileSync(paths.file, 'utf8');
    const parsed = JSON.parse(raw) as RegistryFile;
    if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeRegistry(paths: RegistryPaths, data: RegistryFile): void {
  mkdirSync(dirname(paths.file), { recursive: true });
  const tmp = `${paths.file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, paths.file);
}

export function recordSpawn(
  args: { cwd: string; appLabel: string; adapter: AdapterKind; sessionId: string },
  paths: RegistryPaths = defaultRegistryPaths(),
): SessionRecord {
  const data = readRegistry(paths);
  const key = entryKey(args.cwd, args.appLabel);
  const now = new Date().toISOString();
  const record: SessionRecord = {
    sessionId: args.sessionId,
    adapter: args.adapter,
    appLabel: args.appLabel,
    cwd: args.cwd,
    createdAt: now,
    lastUsedAt: now,
  };
  const existing = data.entries[key];
  if (existing) {
    existing.adapter = args.adapter;
    existing.sessions.push(record);
  } else {
    data.entries[key] = {
      cwd: args.cwd,
      appLabel: args.appLabel,
      adapter: args.adapter,
      sessions: [record],
    };
  }
  writeRegistry(paths, data);
  return record;
}

export function recordResume(
  args: { cwd: string; appLabel: string; sessionId: string },
  paths: RegistryPaths = defaultRegistryPaths(),
): SessionRecord | null {
  const data = readRegistry(paths);
  const entry = data.entries[entryKey(args.cwd, args.appLabel)];
  if (!entry) return null;
  const session = entry.sessions.find((s) => s.sessionId === args.sessionId);
  if (!session) return null;
  session.lastUsedAt = new Date().toISOString();
  writeRegistry(paths, data);
  return session;
}

export function listSessions(
  args: { cwd: string; appLabel?: string },
  paths: RegistryPaths = defaultRegistryPaths(),
): SessionRecord[] {
  const data = readRegistry(paths);
  const out: SessionRecord[] = [];
  for (const entry of Object.values(data.entries)) {
    if (entry.cwd !== args.cwd) continue;
    if (args.appLabel !== undefined && entry.appLabel !== args.appLabel) continue;
    out.push(...entry.sessions);
  }
  out.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return out;
}

export function findLatestSession(
  args: { cwd: string; appLabel: string },
  paths: RegistryPaths = defaultRegistryPaths(),
): SessionRecord | null {
  const sessions = listSessions(args, paths);
  return sessions[0] ?? null;
}
