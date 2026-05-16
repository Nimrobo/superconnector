import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type {
  Adapter,
  AdapterKind,
  AdapterModel,
  AgentMessage,
  PermissionMode,
  ResumeOptions,
  SpawnOptions,
} from '../../types.js';
import { runOpenCode } from './process.js';
import { EventQueue } from '../../util/event-queue.js';
import { isExecutableAvailable } from '../../util/executable.js';
import { isDirectory, pathExists } from '../../util/filesystem.js';

export interface OpenCodeAdapterOptions {
  binPath?: string;
  extraArgs?: string[];
  model?: string;
}

const LIST_MODELS_TIMEOUT_MS = 5_000;

function permissionFlag(mode: PermissionMode | undefined): string[] {
  const m: PermissionMode = mode ?? 'acceptEdits';
  if (m === 'read') return [];
  return ['--dangerously-skip-permissions'];
}

export function hasModelFlag(args: readonly string[]): boolean {
  for (const a of args) {
    if (a === '--model' || a === '-m') return true;
    if (a.startsWith('--model=') || a.startsWith('-m=')) return true;
  }
  return false;
}

// `opencode models` currently prints one `provider/id` per line. To stay
// resilient to future cosmetic prefixes (markers, columns, ANSI), extract the
// first whitespace-separated token containing a `/` from each line.
const MODEL_TOKEN_RX = /\S*\/\S+/;

export function parseModelsOutput(stdout: string): AdapterModel[] {
  const seen = new Set<string>();
  const models: AdapterModel[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!line) continue;
    const m = line.match(MODEL_TOKEN_RX);
    if (!m) continue;
    const id = m[0];
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id.slice(slash + 1) });
  }
  return models;
}

export class OpenCodeAdapter implements Adapter {
  readonly kind: AdapterKind = 'opencode';
  private readonly binPath: string;
  private readonly extraArgs: string[];
  private readonly model: string | undefined;
  private readonly binaryAvailable: boolean;

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this.binPath = opts.binPath ?? process.env['OPENCODE_BIN'] ?? 'opencode';
    this.extraArgs = opts.extraArgs ?? [];
    this.model = opts.model;
    this.binaryAvailable = isExecutableAvailable(this.binPath);
  }

  detect(cwd: string): boolean {
    return (
      this.binaryAvailable &&
      (isDirectory(join(cwd, '.opencode')) || pathExists(join(cwd, 'opencode.json')))
    );
  }

  spawn(opts: SpawnOptions, cwd: string): AsyncIterable<AgentMessage> {
    return this.run(['run', '--format', 'json', opts.prompt], opts, cwd);
  }

  resume(opts: ResumeOptions, cwd: string): AsyncIterable<AgentMessage> {
    return this.run(
      ['run', '--format', 'json', '--session', opts.sessionId, opts.prompt],
      opts,
      cwd,
    );
  }

  async listModels(cwd: string): Promise<AdapterModel[]> {
    return new Promise<AdapterModel[]>((resolve) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), LIST_MODELS_TIMEOUT_MS);
      let stdout = '';
      let settled = false;
      const done = (models: AdapterModel[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(models);
      };

      let child;
      try {
        child = spawn(this.binPath, ['models'], {
          cwd,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: process.env,
          signal: ctrl.signal,
        });
      } catch {
        done([]);
        return;
      }
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (c: string) => {
        stdout += c;
      });
      child.once('error', () => done([]));
      child.once('close', (code) => {
        if (code !== 0) {
          done([]);
          return;
        }
        done(parseModelsOutput(stdout));
      });
    });
  }

  private async *run(
    baseArgs: string[],
    opts: SpawnOptions | ResumeOptions,
    cwd: string,
  ): AsyncIterable<AgentMessage> {
    const permissionArgs = permissionFlag(opts.permissionMode);
    const allArgs = [...baseArgs, ...permissionArgs, ...this.extraArgs];
    if (this.model && !hasModelFlag(allArgs)) {
      allArgs.push('--model', this.model);
    }

    // opencode has no programmatic approval-prompt hook; surface an advisory
    // event and continue without an approval host.
    let prelude: EventQueue<AgentMessage> | null = null;
    if (opts.onApprovalRequest) {
      prelude = new EventQueue<AgentMessage>();
      prelude.push({
        type: 'superconnector',
        sessionId: '',
        content: { subtype: 'approval_unsupported', adapter: 'opencode' },
        raw: { source: 'superconnector' },
      });
      prelude.close();
      while (true) {
        const r = await prelude.next();
        if (r.done) break;
        yield r.value;
      }
    }

    yield* runOpenCode({
      binPath: this.binPath,
      args: allArgs,
      cwd,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }
}
