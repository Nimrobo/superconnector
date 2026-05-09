import { NotImplementedError } from '../../errors.js';
import type {
  Adapter,
  AdapterKind,
  AgentMessage,
  ResumeOptions,
  SpawnOptions,
} from '../../types.js';

export class CodexAdapter implements Adapter {
  readonly kind: AdapterKind = 'codex';

  spawn(_opts: SpawnOptions, _cwd: string): AsyncIterable<AgentMessage> {
    throw new NotImplementedError('codex');
  }

  resume(_opts: ResumeOptions, _cwd: string): AsyncIterable<AgentMessage> {
    throw new NotImplementedError('codex');
  }
}
