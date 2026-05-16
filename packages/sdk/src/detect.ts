import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { ADAPTER_KINDS, createBuiltinAdapters } from './adapters/registry.js';
import type { AdapterKind } from './types.js';

function walkUp(start: string): string[] {
  const home = homedir();
  const visited: string[] = [];
  let cur = start;
  while (true) {
    visited.push(cur);
    if (cur === home || cur === '/' || cur === dirname(cur)) break;
    cur = dirname(cur);
  }
  return visited;
}

export function detectAdapter(cwd: string = process.cwd()): AdapterKind | null {
  const adapters = createBuiltinAdapters();
  for (const dir of walkUp(cwd)) {
    for (const adapter of adapters) {
      if (adapter.detect(dir)) return adapter.kind;
    }
  }
  return null;
}

export function detectAdapters(cwd: string = process.cwd()): AdapterKind[] {
  const adapters = createBuiltinAdapters();
  const found = new Set<AdapterKind>();
  for (const dir of walkUp(cwd)) {
    for (const adapter of adapters) {
      if (adapter.detect(dir)) found.add(adapter.kind);
    }
  }
  return ADAPTER_KINDS.filter((k) => found.has(k));
}
