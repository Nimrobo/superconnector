import { ClaudeCodeAdapter } from './claude-code/index.js';
import { CodexAdapter } from './codex/index.js';
import { OpenCodeAdapter } from './opencode/index.js';
import type { Adapter, AdapterKind } from '../types.js';

export const ADAPTER_KINDS = ['claude-code', 'opencode', 'codex'] as const satisfies readonly AdapterKind[];

export interface BuiltinAdapterOptions {
  models?: Partial<Record<AdapterKind, string>>;
}

export function isAdapterKind(value: string): value is AdapterKind {
  return (ADAPTER_KINDS as readonly string[]).includes(value);
}

export function createBuiltinAdapter(kind: AdapterKind, opts: BuiltinAdapterOptions = {}): Adapter {
  const model = opts.models?.[kind];
  switch (kind) {
    case 'claude-code':
      return new ClaudeCodeAdapter(model !== undefined ? { model } : {});
    case 'opencode':
      return new OpenCodeAdapter(model !== undefined ? { model } : {});
    case 'codex':
      return new CodexAdapter(model !== undefined ? { model } : {});
  }
}

export function createBuiltinAdapters(opts: BuiltinAdapterOptions = {}): Adapter[] {
  return ADAPTER_KINDS.map((kind) => createBuiltinAdapter(kind, opts));
}
