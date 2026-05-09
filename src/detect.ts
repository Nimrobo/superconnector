import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AdapterKind } from './types.js';

interface MarkerRule {
  kind: AdapterKind;
  isMatch: (cwd: string) => boolean;
}

function exists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const RULES: MarkerRule[] = [
  {
    kind: 'claude-code',
    isMatch: (cwd) => isDir(join(cwd, '.claude')) || exists(join(cwd, 'CLAUDE.md')),
  },
  {
    kind: 'opencode',
    isMatch: (cwd) => isDir(join(cwd, '.opencode')) || exists(join(cwd, 'opencode.json')),
  },
  {
    kind: 'codex',
    isMatch: (cwd) => isDir(join(cwd, '.codex')) || exists(join(cwd, 'AGENTS.md')),
  },
];

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
  for (const dir of walkUp(cwd)) {
    for (const rule of RULES) {
      if (rule.isMatch(dir)) return rule.kind;
    }
  }
  return null;
}
