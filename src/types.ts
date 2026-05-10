import type { ApprovalCallback } from './approval/types.js';

export type AdapterKind = 'claude-code' | 'opencode' | 'codex';

export type PermissionMode = 'read' | 'acceptEdits';

export interface PermissionOptions {
  permissionMode?: PermissionMode;
  onApprovalRequest?: ApprovalCallback;
  approvalTimeoutMs?: number;
}

export interface SpawnOptions extends PermissionOptions {
  prompt: string;
  appId: string;
  sessionSelector?: string;
  resumeLastCreatedSession?: boolean;
  signal?: AbortSignal;
}

export interface ResumeOptions extends PermissionOptions {
  prompt: string;
  appId: string;
  sessionSelector?: string;
  sessionId: string;
  signal?: AbortSignal;
}

export type AgentMessageType =
  | 'assistant'
  | 'user'
  | 'system'
  | 'result'
  | 'tool_use'
  | 'tool_result'
  | 'superconnector';

export interface AgentMessage {
  type: AgentMessageType;
  sessionId: string;
  content: unknown;
  raw?: unknown;
}

export interface SessionRecord {
  sessionId: string;
  adapter: AdapterKind;
  appId: string;
  sessionSelector?: string;
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
  listSessions(filter?: { appId?: string; sessionSelector?: string }): SessionRecord[];
  detectAdapter(): AdapterKind | null;
  getAdapter(): Adapter;
  setAdapter(adapter: Adapter | AdapterKind): void;
}

export type { ApprovalRequest, ApprovalDecision, ApprovalCallback } from './approval/types.js';
