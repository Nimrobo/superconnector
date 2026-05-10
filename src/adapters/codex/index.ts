import { NotImplementedError } from '../../errors.js';
import type {
  Adapter,
  AdapterKind,
  AgentMessage,
  ResumeOptions,
  SpawnOptions,
} from '../../types.js';

export interface CodexAdapterOptions {
  // Forwarded as `codex --model <model>` once spawn/resume are implemented.
  model?: string;
}

export class CodexAdapter implements Adapter {
  readonly kind: AdapterKind = 'codex';
  readonly model: string | undefined;

  constructor(opts: CodexAdapterOptions = {}) {
    this.model = opts.model;
  }

  spawn(_opts: SpawnOptions, _cwd: string): AsyncIterable<AgentMessage> {
    throw new NotImplementedError('codex');
  }

  resume(_opts: ResumeOptions, _cwd: string): AsyncIterable<AgentMessage> {
    throw new NotImplementedError('codex');
  }
}
