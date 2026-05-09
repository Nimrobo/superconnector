import { NotImplementedError } from '../../errors.js';
import type {
  Adapter,
  AdapterKind,
  AgentMessage,
  ResumeOptions,
  SpawnOptions,
} from '../../types.js';

export class OpenCodeAdapter implements Adapter {
  readonly kind: AdapterKind = 'opencode';

  spawn(_opts: SpawnOptions, _cwd: string): AsyncIterable<AgentMessage> {
    throw new NotImplementedError('opencode');
  }

  resume(_opts: ResumeOptions, _cwd: string): AsyncIterable<AgentMessage> {
    throw new NotImplementedError('opencode');
  }
}
