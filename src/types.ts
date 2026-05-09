export type AdapterKind = 'claude-code' | 'opencode' | 'codex';

export interface SpawnOptions {
  prompt: string;
  appLabel: string;
  resumeLastCreatedSession?: boolean;
  signal?: AbortSignal;
}

export interface ResumeOptions {
  prompt: string;
  appLabel: string;
  sessionId: string;
  signal?: AbortSignal;
}

export type AgentMessageType =
  | 'assistant'
  | 'user'
  | 'system'
  | 'result'
  | 'tool_use'
  | 'tool_result';

export interface AgentMessage {
  type: AgentMessageType;
  sessionId: string;
  content: unknown;
  raw?: unknown;
}

export interface SessionRecord {
  sessionId: string;
  adapter: AdapterKind;
  appLabel: string;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface Adapter {
  kind: AdapterKind;
  spawn(opts: SpawnOptions, cwd: string): AsyncIterable<AgentMessage>;
  resume(opts: ResumeOptions, cwd: string): AsyncIterable<AgentMessage>;
}

export interface Superconnector {
  spawn(opts: SpawnOptions): AsyncIterable<AgentMessage>;
  resume(opts: ResumeOptions): AsyncIterable<AgentMessage>;
  listSessions(filter?: { appLabel?: string }): SessionRecord[];
  detectAdapter(): AdapterKind | null;
  getAdapter(): Adapter;
  setAdapter(adapter: Adapter | AdapterKind): void;
}
