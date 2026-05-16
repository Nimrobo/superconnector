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

export type AdapterRunAction = 'spawn' | 'resume';

export type AdapterSelectionSource =
  | 'explicit'
  | 'config'
  | 'detected'
  | 'recorded-session'
  | 'none';

export type WhichAdapterWillRunOptions =
  | (Omit<SpawnOptions, 'prompt'> & { prompt?: string; operation?: 'spawn'; sessionId?: never })
  | (Omit<ResumeOptions, 'prompt'> & { prompt?: string; operation?: 'resume' });

export interface WhichAdapterWillRunResult {
  cwd: string;
  action: AdapterRunAction;
  adapter: AdapterKind | null;
  source: AdapterSelectionSource;
  ready: boolean;
  reason:
    | 'explicit_adapter'
    | 'configured_preferred_adapter'
    | 'detected_project_adapter'
    | 'latest_session'
    | 'explicit_session'
    | 'no_adapter'
    | 'unknown_session';
  session: SessionRecord | null;
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

export interface AdapterModel {
  id: string;
  label?: string;
  description?: string;
}

export interface AdapterInfo {
  kind: AdapterKind;
  detected: boolean;
  selected: boolean;
}

export interface Adapter {
  kind: AdapterKind;
  detect(cwd: string): boolean;
  spawn(opts: SpawnOptions, cwd: string): AsyncIterable<AgentMessage>;
  resume(opts: ResumeOptions, cwd: string): AsyncIterable<AgentMessage>;
  listModels?(cwd: string): Promise<AdapterModel[]>;
}

export interface Superconnector {
  spawn(opts: SpawnOptions): AsyncIterable<AgentMessage>;
  resume(opts: ResumeOptions): AsyncIterable<AgentMessage>;
  listSessions(filter?: { appId?: string; sessionSelector?: string }): SessionRecord[];
  detectAdapter(): AdapterKind | null;
  whichAdapterWillRun(opts?: WhichAdapterWillRunOptions): WhichAdapterWillRunResult;
  getAdapter(): Adapter;
  setAdapter(adapter: Adapter | AdapterKind): void;
  listAdapters(): AdapterInfo[];
  listModels(adapter: AdapterKind): Promise<AdapterModel[]>;
}

export type { ApprovalRequest, ApprovalDecision, ApprovalCallback } from './approval/types.js';
