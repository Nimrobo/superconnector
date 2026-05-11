import { NotImplementedError } from '../../errors.js';
import type {
  Adapter,
  AdapterKind,
  AgentMessage,
  ResumeOptions,
  SpawnOptions,
} from '../../types.js';

export interface OpenCodeAdapterOptions {
  // Forwarded as `opencode --model <model>` once spawn/resume are implemented.
  model?: string;
}

export class OpenCodeAdapter implements Adapter {
  readonly kind: AdapterKind = 'opencode';
  readonly model: string | undefined;

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this.model = opts.model;
  }

  spawn(_opts: SpawnOptions, _cwd: string): AsyncIterable<AgentMessage> {
    throw new NotImplementedError('opencode');
  }

  resume(_opts: ResumeOptions, _cwd: string): AsyncIterable<AgentMessage> {
    throw new NotImplementedError('opencode');
  }
}
