import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { AdapterFailedError } from '../../errors.js';
import type {
  Adapter,
  AdapterModel,
  AdapterKind,
  AgentMessage,
  PermissionMode,
  ResumeOptions,
  SpawnOptions,
} from '../../types.js';
import { runCodex } from './process.js';
import { isExecutableAvailable } from '../../util/executable.js';
import { isDirectory, pathExists } from '../../util/filesystem.js';

export interface CodexAdapterOptions {
  binPath?: string;
  extraArgs?: string[];
  model?: string;
}

const STATIC_MODEL_FALLBACK: AdapterModel[] = [
  { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2-Codex' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1-Codex-Max' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex mini' },
  { id: 'gpt-5-codex', label: 'GPT-5-Codex' },
];

function sandboxArgs(mode: PermissionMode | undefined): string[] {
  const m: PermissionMode = mode ?? 'acceptEdits';
  return ['--sandbox', m === 'read' ? 'read-only' : 'workspace-write'];
}

export class CodexAdapter implements Adapter {
  readonly kind: AdapterKind = 'codex';
  private readonly binPath: string;
  private readonly extraArgs: string[];
  readonly model: string | undefined;
  private readonly binaryAvailable: boolean;

  constructor(opts: CodexAdapterOptions = {}) {
    this.binPath = opts.binPath ?? process.env['CODEX_BIN'] ?? 'codex';
    this.extraArgs = opts.extraArgs ?? [];
    this.model = opts.model;
    this.binaryAvailable = isExecutableAvailable(this.binPath);
  }

  detect(cwd: string): boolean {
    return (
      this.binaryAvailable &&
      (isDirectory(join(cwd, '.codex')) || pathExists(join(cwd, 'AGENTS.md')))
    );
  }

  spawn(opts: SpawnOptions, cwd: string): AsyncIterable<AgentMessage> {
    return this.run(
      this.buildArgs(['exec', '--json', ...sandboxArgs(opts.permissionMode)], [opts.prompt]),
      opts,
      cwd,
    );
  }

  resume(opts: ResumeOptions, cwd: string): AsyncIterable<AgentMessage> {
    return this.run(
      this.buildArgs(
        ['exec', '--json', ...sandboxArgs(opts.permissionMode)],
        ['resume', opts.sessionId, opts.prompt],
      ),
      opts,
      cwd,
    );
  }

  async listModels(cwd: string): Promise<AdapterModel[]> {
    const live = await readModelCatalog(this.binPath, ['debug', 'models'], cwd);
    if (live) return live;
    const bundled = await readModelCatalog(this.binPath, ['debug', 'models', '--bundled'], cwd);
    return bundled ?? STATIC_MODEL_FALLBACK;
  }

  private buildArgs(prefix: string[], tail: string[]): string[] {
    const allArgs = [...prefix, ...this.extraArgs];
    const hasModel = allArgs.includes('--model') || allArgs.includes('-m');
    if (this.model && !hasModel) {
      allArgs.push('--model', this.model);
    }
    return [...allArgs, ...tail];
  }

  private async *run(
    args: string[],
    opts: SpawnOptions | ResumeOptions,
    cwd: string,
  ): AsyncIterable<AgentMessage> {
    if (opts.onApprovalRequest) {
      throw new AdapterFailedError(
        'Codex exec mode does not support Superconnector approval callbacks',
        null,
        '',
      );
    }

    const runArgs = {
      binPath: this.binPath,
      args,
      cwd,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };
    yield* runCodex(runArgs);
  }
}

function readModelCatalog(
  binPath: string,
  args: string[],
  cwd: string,
): Promise<AdapterModel[] | null> {
  return new Promise((resolve) => {
    const child = spawn(binPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', () => resolve(null));
    child.once('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(parseModelCatalog(stdout));
    });
  });
}

function parseModelCatalog(raw: string): AdapterModel[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['models'])) return null;

  const models: AdapterModel[] = [];
  for (const m of parsed['models']) {
    if (!isRecord(m) || typeof m['slug'] !== 'string') continue;
    models.push({
      id: m['slug'],
      ...(typeof m['display_name'] === 'string' ? { label: m['display_name'] } : {}),
      ...(typeof m['description'] === 'string' ? { description: m['description'] } : {}),
    });
  }
  return models.length ? models : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
