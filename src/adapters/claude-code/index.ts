import type {
  Adapter,
  AdapterModel,
  AdapterKind,
  AgentMessage,
  PermissionMode,
  ResumeOptions,
  SpawnOptions,
} from '../../types.js';
import { runClaude } from './process.js';
import { startApprovalHost, type ApprovalHostHandle } from '../../approval/host.js';
import { EventQueue } from '../../util/event-queue.js';

export interface ClaudeCodeAdapterOptions {
  binPath?: string;
  extraArgs?: string[];
  model?: string;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

function permissionFlag(mode: PermissionMode | undefined): string[] {
  const m: PermissionMode = mode ?? 'acceptEdits';
  if (m === 'read') return ['--permission-mode', 'plan'];
  return ['--permission-mode', 'acceptEdits'];
}

export class ClaudeCodeAdapter implements Adapter {
  readonly kind: AdapterKind = 'claude-code';
  private readonly binPath: string;
  private readonly extraArgs: string[];
  private readonly model: string | undefined;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.binPath = opts.binPath ?? process.env['CLAUDE_BIN'] ?? 'claude';
    this.extraArgs = opts.extraArgs ?? [];
    this.model = opts.model;
  }

  spawn(opts: SpawnOptions, cwd: string): AsyncIterable<AgentMessage> {
    return this.run(
      ['-p', opts.prompt, '--output-format', 'stream-json', '--print', '--verbose'],
      opts,
      cwd,
    );
  }

  resume(opts: ResumeOptions, cwd: string): AsyncIterable<AgentMessage> {
    return this.run(
      [
        '-p',
        opts.prompt,
        '--resume',
        opts.sessionId,
        '--output-format',
        'stream-json',
        '--print',
        '--verbose',
      ],
      opts,
      cwd,
    );
  }

  async listModels(_cwd: string): Promise<AdapterModel[]> {
    return [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
    ];
  }

  private async *run(
    baseArgs: string[],
    opts: SpawnOptions | ResumeOptions,
    cwd: string,
  ): AsyncIterable<AgentMessage> {
    const permissionArgs = permissionFlag(opts.permissionMode);
    const sessionIdHint = 'sessionId' in opts ? opts.sessionId : '';

    let host: ApprovalHostHandle | null = null;
    let externalEvents: EventQueue<AgentMessage> | null = null;
    const extraArgs: string[] = [...permissionArgs];

    if (opts.onApprovalRequest) {
      externalEvents = new EventQueue<AgentMessage>();
      host = await startApprovalHost({
        callback: opts.onApprovalRequest,
        sessionId: sessionIdHint,
        cwd,
        timeoutMs: opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
        onDecision: (req, decision, reason) => {
          externalEvents!.push({
            type: 'superconnector',
            sessionId: req.sessionId || sessionIdHint,
            content: {
              subtype: 'approval_decision',
              toolName: req.toolName,
              decision: decision.decision,
              reason,
              message: decision.message,
            },
            raw: { source: 'superconnector' },
          });
        },
        onTimeout: (toolName) => {
          externalEvents!.push({
            type: 'superconnector',
            sessionId: sessionIdHint,
            content: { subtype: 'approval_timeout', toolName },
            raw: { source: 'superconnector' },
          });
        },
      });
      extraArgs.push('--mcp-config', host.mcpConfigPath);
      extraArgs.push('--permission-prompt-tool', host.permissionPromptToolName);
    }

    const allArgs = [...baseArgs, ...extraArgs, ...this.extraArgs];
    const hasModel = allArgs.includes('--model') || allArgs.includes('-m');
    if (this.model && !hasModel) {
      allArgs.push('--model', this.model);
    }
    const args = allArgs;

    const onClose = async () => {
      if (externalEvents) externalEvents.close();
      if (host) await host.dispose();
    };

    const runArgs = {
      binPath: this.binPath,
      args,
      cwd,
      onClose,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(externalEvents ? { externalEvents } : {}),
    };
    yield* runClaude(runArgs);
  }
}
