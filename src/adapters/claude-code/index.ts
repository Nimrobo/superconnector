import type {
  Adapter,
  AdapterKind,
  AgentMessage,
  ResumeOptions,
  SpawnOptions,
} from '../../types.js';
import { runClaude } from './process.js';

export interface ClaudeCodeAdapterOptions {
  binPath?: string;
  extraArgs?: string[];
}

export class ClaudeCodeAdapter implements Adapter {
  readonly kind: AdapterKind = 'claude-code';
  private readonly binPath: string;
  private readonly extraArgs: string[];

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.binPath = opts.binPath ?? process.env.CLAUDE_BIN ?? 'claude';
    this.extraArgs = opts.extraArgs ?? [];
  }

  spawn(opts: SpawnOptions, cwd: string): AsyncIterable<AgentMessage> {
    const args = [
      '-p',
      opts.prompt,
      '--output-format',
      'stream-json',
      '--print',
      '--verbose',
      ...this.extraArgs,
    ];
    return runClaude({
      binPath: this.binPath,
      args,
      cwd,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  resume(opts: ResumeOptions, cwd: string): AsyncIterable<AgentMessage> {
    const args = [
      '-p',
      opts.prompt,
      '--resume',
      opts.sessionId,
      '--output-format',
      'stream-json',
      '--print',
      '--verbose',
      ...this.extraArgs,
    ];
    return runClaude({
      binPath: this.binPath,
      args,
      cwd,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }
}
