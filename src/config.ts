import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultRegistryPaths } from './registry.js';
import type { AdapterKind, PermissionMode } from './types.js';

export interface SuperconnectorConfig {
  preferredAdapter?: AdapterKind;
  models?: Partial<Record<AdapterKind, string>>;
  permissionMode?: PermissionMode;
}

export interface ResolvedConfig {
  merged: SuperconnectorConfig;
  global: SuperconnectorConfig | null;
  local: SuperconnectorConfig | null;
  globalPath: string;
  localPath: string;
}

const VALID_ADAPTERS: ReadonlySet<AdapterKind> = new Set(['claude-code', 'opencode', 'codex']);
const VALID_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set(['read', 'acceptEdits']);

export function globalConfigPath(): string {
  return join(defaultRegistryPaths().root, 'config.json');
}

export function localConfigPath(cwd: string): string {
  return join(cwd, '.superconnector', 'config.json');
}

function sanitize(raw: unknown): SuperconnectorConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: SuperconnectorConfig = {};
  if (typeof r['preferredAdapter'] === 'string' && VALID_ADAPTERS.has(r['preferredAdapter'] as AdapterKind)) {
    out.preferredAdapter = r['preferredAdapter'] as AdapterKind;
  }
  if (typeof r['permissionMode'] === 'string' && VALID_PERMISSION_MODES.has(r['permissionMode'] as PermissionMode)) {
    out.permissionMode = r['permissionMode'] as PermissionMode;
  }
  if (r['models'] && typeof r['models'] === 'object') {
    const models: Partial<Record<AdapterKind, string>> = {};
    for (const [k, v] of Object.entries(r['models'] as Record<string, unknown>)) {
      if (VALID_ADAPTERS.has(k as AdapterKind) && typeof v === 'string' && v.length > 0) {
        models[k as AdapterKind] = v;
      }
    }
    if (Object.keys(models).length > 0) out.models = models;
  }
  return out;
}

export function readConfig(path: string): SuperconnectorConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return sanitize(raw);
  } catch {
    return null;
  }
}

export function writeConfig(path: string, cfg: SuperconnectorConfig): void {
  const clean = sanitize(cfg) ?? {};
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  renameSync(tmp, path);
}

function mergeConfigs(
  global: SuperconnectorConfig | null,
  local: SuperconnectorConfig | null,
): SuperconnectorConfig {
  const merged: SuperconnectorConfig = {};
  const g = global ?? {};
  const l = local ?? {};
  const preferredAdapter = l.preferredAdapter ?? g.preferredAdapter;
  if (preferredAdapter !== undefined) merged.preferredAdapter = preferredAdapter;
  const permissionMode = l.permissionMode ?? g.permissionMode;
  if (permissionMode !== undefined) merged.permissionMode = permissionMode;
  if (g.models || l.models) {
    merged.models = { ...(g.models ?? {}), ...(l.models ?? {}) };
  }
  return merged;
}

export function resolveConfig(cwd: string): ResolvedConfig {
  const globalPath = globalConfigPath();
  const localPath = localConfigPath(cwd);
  const global = readConfig(globalPath);
  const local = readConfig(localPath);
  return { merged: mergeConfigs(global, local), global, local, globalPath, localPath };
}
