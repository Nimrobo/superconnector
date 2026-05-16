# @nimrobo/superconnector

TypeScript SDK for apps that need to spawn, resume, and stream coding-agent sessions from a trusted Node runtime.

Superconnector is beta-ready for integration work. The package is currently `0.1.x`, so keep adapter-specific behavior and upstream CLI changes in mind when upgrading.

## Install

```sh
npm install @nimrobo/superconnector
```

Requirements:

- Node.js `>=20`
- A backend, CLI, Electron main process, server action, or other trusted Node runtime
- At least one supported agent CLI installed and authenticated: Claude Code, OpenCode, or Codex

## Quick Start

```ts
import { createSuperconnector } from '@nimrobo/superconnector';

const sc = createSuperconnector({
  adapter: 'claude-code',
});

for await (const msg of sc.spawn({
  prompt: 'Review this repository and summarize the highest-risk areas.',
  appId: 'my-app',
  permissionMode: 'read',
})) {
  console.log(msg.type, msg.sessionId, msg.content);
}
```

`spawn()` and `resume()` return `AsyncIterable<AgentMessage>`, which maps naturally to websockets, SSE, job logs, queues, and application stores.

## Public API

Main entry point:

```ts
import {
  createSuperconnector,
  detectAdapter,
  AdapterNotSetError,
  UnknownSessionError,
  PermissionRequiredError,
  type Adapter,
  type AdapterKind,
  type AgentMessage,
  type ApprovalCallback,
  type ApprovalDecision,
  type ApprovalRequest,
  type ResumeOptions,
  type SessionRecord,
  type SpawnOptions,
  type Superconnector,
} from '@nimrobo/superconnector';
```

Config entry point:

```ts
import {
  globalConfigPath,
  localConfigPath,
  readConfig,
  resolveConfig,
  writeConfig,
  type SuperconnectorConfig,
} from '@nimrobo/superconnector/config';
```

Adapter entry points:

```ts
import { ClaudeCodeAdapter } from '@nimrobo/superconnector/adapters/claude-code';
import { OpenCodeAdapter } from '@nimrobo/superconnector/adapters/opencode';
import { CodexAdapter } from '@nimrobo/superconnector/adapters/codex';
```

Core types:

```ts
type AdapterKind = 'claude-code' | 'opencode' | 'codex';
type PermissionMode = 'read' | 'acceptEdits';

interface SpawnOptions {
  prompt: string;
  appId: string;
  sessionSelector?: string;
  resumeLastCreatedSession?: boolean;
  permissionMode?: PermissionMode;
  onApprovalRequest?: ApprovalCallback;
  approvalTimeoutMs?: number;
  signal?: AbortSignal;
}

interface ResumeOptions {
  prompt: string;
  appId: string;
  sessionId: string;
  sessionSelector?: string;
  permissionMode?: PermissionMode;
  onApprovalRequest?: ApprovalCallback;
  approvalTimeoutMs?: number;
  signal?: AbortSignal;
}

interface AgentMessage {
  type: 'assistant' | 'user' | 'system' | 'result' | 'tool_use' | 'tool_result' | 'superconnector';
  sessionId: string;
  content: unknown;
  raw?: unknown;
}
```

## Creating a Connector

Use an explicit adapter when your app knows which agent runtime it is targeting:

```ts
const sc = createSuperconnector({
  adapter: 'codex',
});
```

Or let Superconnector use config and detection:

```ts
const sc = createSuperconnector();
```

By default the agent runs in `process.cwd()`. Pass `cwd` only to narrow execution to the current process directory or one of its descendants:

```ts
const sc = createSuperconnector({ cwd: 'packages/app' });
```

For absolute workspace paths, start the trusted Node process from that workspace root and omit `cwd`; explicit cwd values outside the process cwd tree are rejected.

Resolution order:

1. explicit `adapter` passed to `createSuperconnector()`
2. `preferredAdapter` from local or global config
3. detection from project markers and available binaries

If no adapter is set or detected, `getAdapter()`, `spawn()`, and `resume()` throw `AdapterNotSetError`.

### Preview the adapter

Consumer apps that need to show or confirm the runtime before starting work should call `whichAdapterWillRun()` with the same run-shaped options they will pass to `spawn()` or `resume()`. The preview does not start an agent and does not update session state.

```ts
import type { SpawnOptions } from '@nimrobo/superconnector';

const run = {
  prompt,
  appId: 'my-app',
  sessionSelector: workspaceId,
  resumeLastCreatedSession: true,
} satisfies SpawnOptions;

const preview = sc.whichAdapterWillRun(run);

if (!preview.ready) {
  // show adapter picker or config flow
}

console.log(preview.adapter, preview.action, preview.source);
```

## Sessions

Superconnector records sessions by `cwd` and `appId`. Use a stable `appId` for your app or feature:

```ts
const sessions = sc.listSessions({ appId: 'my-app' });
```

Use `sessionSelector` when one `appId` needs separate threads, workspaces, tabs, or user-visible conversations:

```ts
const sessions = sc.listSessions({
  appId: 'my-app',
  sessionSelector: workspaceId,
});
```

### Resume an explicit session

```ts
const [latest] = sc.listSessions({ appId: 'my-app', sessionSelector: workspaceId });

if (latest) {
  for await (const msg of sc.resume({
    prompt: 'Continue from the previous result.',
    appId: latest.appId,
    sessionSelector: latest.sessionSelector,
    sessionId: latest.sessionId,
    permissionMode: 'read',
  })) {
    publish(msg);
  }
}
```

`resume()` validates that the session was recorded for the same `cwd`, `appId`, and selector. If not, it throws `UnknownSessionError`.

### Continue the latest matching session

```ts
for await (const msg of sc.spawn({
  prompt,
  appId: 'my-app',
  sessionSelector: workspaceId,
  resumeLastCreatedSession: true,
  permissionMode: 'read',
})) {
  publish(msg);
}
```

`resumeLastCreatedSession` resumes the most recently recorded session for the same `cwd`, `appId`, and `sessionSelector`. If no matching session exists, it starts a new one. When `sessionSelector` is omitted, only unscoped sessions are considered.

## Permissions and Approvals

Use `permissionMode: "read"` for planning, review, and analysis flows. Use `permissionMode: "acceptEdits"` only for workflows where the user expects file edits.

Claude Code supports approval callbacks:

```ts
for await (const msg of sc.spawn({
  prompt,
  appId: 'my-app',
  permissionMode: 'acceptEdits',
  approvalTimeoutMs: 60_000,
  onApprovalRequest: async (request) => {
    if (request.cwd !== workspaceRoot) {
      return { decision: 'deny', message: 'Workspace mismatch' };
    }

    const approved = await askUser({
      sessionId: request.sessionId,
      toolName: request.toolName,
      input: request.input,
    });

    return approved ? { decision: 'allow' } : { decision: 'deny', message: 'Denied by user' };
  },
})) {
  publish(msg);
}
```

Adapter limits:

- `claude-code` supports Superconnector approval callbacks through an approval host.
- `opencode` does not support programmatic approval callbacks; Superconnector emits an advisory `superconnector` event if one is provided.
- `codex` exec mode rejects Superconnector approval callbacks with `AdapterFailedError`.

Return `deny` when the app cannot confidently associate an approval request with the visible user, workspace, or session.

## Cancellation

```ts
const controller = new AbortController();

const run = (async () => {
  for await (const msg of sc.spawn({
    prompt,
    appId: 'my-app',
    sessionSelector: workspaceId,
    permissionMode: 'read',
    signal: controller.signal,
  })) {
    publish(msg);
  }
})();

controller.abort();
await run;
```

Wire the `AbortSignal` to your request lifecycle, job cancellation path, stop button, or process shutdown handler.

## Configuration

Config can set a preferred adapter, default permission mode, and per-adapter model ids.

```json
{
  "preferredAdapter": "claude-code",
  "permissionMode": "read",
  "models": {
    "claude-code": "sonnet",
    "opencode": "anthropic/claude-sonnet-4-5",
    "codex": "gpt-5.3-codex"
  }
}
```

Locations:

- Global: `~/.superconnector/config.json`
- Local: `<cwd>/.superconnector/config.json`
- Registry and session logs: `~/.superconnector`
- Override root for tests or isolated environments: `SUPERCONNECTOR_HOME=/tmp/superconnector-home`

Local config overrides global config. Explicit constructor options override both.

Use the companion CLI to edit config:

```sh
npx @nimrobo/superconnector-cli config
```

## Adapter Behavior

| Adapter       | Project marker                 | Binary                       | Permission mapping                                                                     |
| ------------- | ------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------- |
| `claude-code` | `CLAUDE.md` or `.claude`       | `claude` or `CLAUDE_BIN`     | `read` maps to Claude plan mode; `acceptEdits` maps to Claude accept-edits mode.       |
| `opencode`    | `opencode.json` or `.opencode` | `opencode` or `OPENCODE_BIN` | `read` uses default run behavior; `acceptEdits` adds `--dangerously-skip-permissions`. |
| `codex`       | `AGENTS.md` or `.codex`        | `codex` or `CODEX_BIN`       | `read` maps to read-only sandbox; `acceptEdits` maps to workspace-write sandbox.       |

Each adapter streams normalized `AgentMessage` objects while keeping the raw adapter message on `raw` when available. Treat `content` as adapter-shaped data and normalize it at your app boundary before storing or rendering.

## Error Handling

```ts
try {
  for await (const msg of stream) {
    publish(msg);
  }
} catch (error) {
  if (error instanceof PermissionRequiredError) {
    publishError({
      code: 'permission_required',
      message: error.message,
      sessionId: error.sessionId,
      resumeCommand: error.resumeCommand,
    });
    return;
  }

  if (error instanceof UnknownSessionError) {
    publishError({ code: 'unknown_session', message: error.message });
    return;
  }

  publishError({
    code: 'agent_failed',
    message: error instanceof Error ? error.message : String(error),
  });
}
```

Common SDK errors:

- `AdapterNotSetError`: no explicit, configured, or detected adapter.
- `UnknownSessionError`: attempted to resume a session that is not recorded for the selected scope.
- `AdapterFailedError`: underlying adapter process failed.
- `PermissionRequiredError`: Claude Code halted on a permission request and provides a manual resume command.

## Testing a Consumer App

Prefer a stub adapter for app-level tests:

```ts
import type { Adapter, AgentMessage, ResumeOptions, SpawnOptions } from '@nimrobo/superconnector';

class StubAdapter implements Adapter {
  readonly kind = 'claude-code' as const;
  spawnCalls: SpawnOptions[] = [];
  resumeCalls: ResumeOptions[] = [];

  detect(): boolean {
    return true;
  }

  spawn(opts: SpawnOptions): AsyncIterable<AgentMessage> {
    this.spawnCalls.push(opts);
    const sessionId = 'stub-session-1';
    return (async function* () {
      yield { type: 'system', sessionId, content: { started: true } };
      yield { type: 'assistant', sessionId, content: { text: 'Ready' } };
      yield { type: 'result', sessionId, content: { ok: true } };
    })();
  }

  resume(opts: ResumeOptions): AsyncIterable<AgentMessage> {
    this.resumeCalls.push(opts);
    const sessionId = opts.sessionId;
    return (async function* () {
      yield { type: 'assistant', sessionId, content: { text: 'Resumed' } };
      yield { type: 'result', sessionId, content: { ok: true } };
    })();
  }
}
```

Use a temporary `cwd` and isolated `SUPERCONNECTOR_HOME` per test file or case:

```ts
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSuperconnector } from '@nimrobo/superconnector';

process.env.SUPERCONNECTOR_HOME = mkdtempSync(join(tmpdir(), 'sc-home-'));

const base = mkdtempSync(join(tmpdir(), 'sc-cwd-'));
const cwd = join(base, 'workspace');
mkdirSync(cwd);
process.chdir(base);

const sc = createSuperconnector({ cwd: 'workspace', adapter: new StubAdapter() });
```

## License

MIT
