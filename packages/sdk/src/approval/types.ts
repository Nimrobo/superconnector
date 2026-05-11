export interface ApprovalRequest {
  sessionId: string;
  cwd: string;
  toolName: string;
  input: unknown;
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
}

export type ApprovalCallback = (req: ApprovalRequest) => Promise<ApprovalDecision>;
