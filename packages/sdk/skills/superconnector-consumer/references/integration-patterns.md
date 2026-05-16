# Superconnector Consumer Integration Patterns

Load this reference when implementing concrete Superconnector integration code in a consumer app.

## Basic Service

```ts
import {
  createSuperconnector,
  AdapterNotSetError,
  PermissionRequiredError,
  UnknownSessionError,
  type AdapterInfo,
  type AdapterKind,
  type AdapterModel,
  type AgentMessage,
  type WhichAdapterWillRunResult,
} from '@nimrobo/superconnector';

export interface AgentRunEvent {
  sessionId: string;
  type: AgentMessage['type'];
  content: unknown;
}

export interface AgentServiceOptions {
  appId: string;
  sessionSelector?: string;
  adapter?: AdapterKind;
}

export function createAgentService(args: AgentServiceOptions) {
  const sc = createSuperconnector({
    ...(args.adapter !== undefined ? { adapter: args.adapter } : {}),
  });

  return {
    listSessions() {
      return sc.listSessions({
        appId: args.appId,
        ...(args.sessionSelector !== undefined ? { sessionSelector: args.sessionSelector } : {}),
      });
    },

    previewSpawn(): WhichAdapterWillRunResult {
      return sc.whichAdapterWillRun({
        appId: args.appId,
        ...(args.sessionSelector !== undefined ? { sessionSelector: args.sessionSelector } : {}),
      });
    },

    previewContinue(): WhichAdapterWillRunResult {
      return sc.whichAdapterWillRun({
        appId: args.appId,
        ...(args.sessionSelector !== undefined ? { sessionSelector: args.sessionSelector } : {}),
        resumeLastCreatedSession: true,
      });
    },

    previewResume(sessionId: string): WhichAdapterWillRunResult {
      return sc.whichAdapterWillRun({
        operation: 'resume',
        sessionId,
        appId: args.appId,
        ...(args.sessionSelector !== undefined ? { sessionSelector: args.sessionSelector } : {}),
      });
    },

    async *spawn(prompt: string, signal?: AbortSignal): AsyncIterable<AgentRunEvent> {
      for await (const msg of sc.spawn({
        prompt,
        appId: args.appId,
        ...(args.sessionSelector !== undefined ? { sessionSelector: args.sessionSelector } : {}),
        permissionMode: 'read',
        signal,
      })) {
        yield normalizeMessage(msg);
      }
    },

    async *resume(
      sessionId: string,
      prompt: string,
      signal?: AbortSignal,
    ): AsyncIterable<AgentRunEvent> {
      for await (const msg of sc.resume({
        sessionId,
        prompt,
        appId: args.appId,
        ...(args.sessionSelector !== undefined ? { sessionSelector: args.sessionSelector } : {}),
        permissionMode: 'read',
        signal,
      })) {
        yield normalizeMessage(msg);
      }
    },
  };
}

function normalizeMessage(msg: AgentMessage): AgentRunEvent {
  return {
    sessionId: msg.sessionId,
    type: msg.type,
    content: msg.content,
  };
}
```

## Adapter Selection

Use an explicit adapter when the app owns the runtime choice:

```ts
const sc = createSuperconnector({
  adapter: 'claude-code',
});
```

Use config/detection when users or workspace setup should choose the runtime:

```ts
const sc = createSuperconnector();
```

Pass `cwd` only when intentionally narrowing the agent process to the current process directory or a child directory:

```ts
const sc = createSuperconnector({ cwd: 'packages/app' });
```

Detection requires both a binary and a project marker:

| Adapter       | Binary                       | Marker                         |
| ------------- | ---------------------------- | ------------------------------ |
| `claude-code` | `claude` or `CLAUDE_BIN`     | `CLAUDE.md` or `.claude`       |
| `opencode`    | `opencode` or `OPENCODE_BIN` | `opencode.json` or `.opencode` |
| `codex`       | `codex` or `CODEX_BIN`       | `AGENTS.md` or `.codex`        |

Choose `claude-code` when the app needs approval callbacks. OpenCode and Codex can run sessions, but they do not currently support Superconnector approval callbacks.

Use `whichAdapterWillRun()` when the consumer UI needs to show or confirm the runtime before starting work. Pass the same selectors the real run will use so preview behavior matches runtime behavior:

```ts
const run = {
  appId: 'my-consumer-app',
  sessionSelector: workspaceId,
  resumeLastCreatedSession: true,
};

const preview = sc.whichAdapterWillRun(run);

if (!preview.ready) {
  showAdapterPicker();
} else {
  renderAdapterChoice(preview.adapter, preview.action, preview.source);
}
```

For an explicit resume UI, preview with the selected session id:

```ts
const preview = sc.whichAdapterWillRun({
  operation: 'resume',
  appId: 'my-consumer-app',
  sessionSelector: workspaceId,
  sessionId: selected.sessionId,
});
```

`whichAdapterWillRun()` is non-mutating: it does not start an agent, record a resume, or update session logs. `source: "recorded-session"` means the run will use the adapter stored on the matching session rather than the connector's current default adapter.

## Adapter And Model Pickers

Use `whichAdapterWillRun()` to preview the single next run. Use `listAdapters()` and `listModels()` instead when the UI needs to enumerate choices for an adapter or model picker. Both are non-mutating and do not start an agent.

`listAdapters()` returns one `AdapterInfo` per built-in adapter kind. `detected` means the adapter's project markers and binary were found for the connector's `cwd` (or an ancestor); `selected` marks the adapter this connector will use.

```ts
// Adapter picker: one row per built-in adapter.
const adapters: AdapterInfo[] = sc.listAdapters();
// [{ kind: "claude-code", detected: true, selected: true }, ...]
renderAdapterPicker(adapters.filter((a) => a.detected));
```

`listModels(kind)` returns `AdapterModel[]` for the given adapter kind. It takes the kind explicitly, so it never depends on the currently selected adapter and never throws `AdapterNotSetError`.

```ts
// Model picker for the chosen adapter kind.
const models: AdapterModel[] = await sc.listModels(chosenKind);
renderModelPicker(models);
```

## Continue Last Session

Use this for simple apps with one active thread per workspace, or one active thread per selector.

```ts
for await (const msg of sc.spawn({
  prompt,
  appId: 'my-consumer-app',
  sessionSelector: workspaceId,
  resumeLastCreatedSession: true,
  permissionMode: 'read',
  signal,
})) {
  publish(msg);
}
```

`resumeLastCreatedSession` resumes the most recent recorded session for the same `cwd`, `appId`, and `sessionSelector`. If `sessionSelector` is omitted, only sessions without a selector are considered. If no matching session exists, it starts a new one.

## Multi-Session Resume

```ts
const sessions =
  workspaceId === undefined
    ? sc.listSessions({ appId: 'my-consumer-app' })
    : sc.listSessions({ appId: 'my-consumer-app', sessionSelector: workspaceId });
const selected = sessions.find((s) => s.sessionId === requestedSessionId);

if (!selected) {
  throw new Error('Unknown agent session');
}

for await (const msg of sc.resume({
  sessionId: selected.sessionId,
  prompt,
  appId: selected.appId,
  ...(selected.sessionSelector !== undefined ? { sessionSelector: selected.sessionSelector } : {}),
  permissionMode: 'read',
  signal,
})) {
  publish(msg);
}
```

Keep session selection in app state. Do not ask users to paste raw resume commands when the app can call `resume`.

## Approval Requests

Use approvals only with `claude-code` when the app wants an edit-capable run while still letting the user decide on tool requests.

```ts
for await (const msg of sc.spawn({
  prompt,
  appId: 'my-consumer-app',
  permissionMode: 'acceptEdits',
  approvalTimeoutMs: 60_000,
  onApprovalRequest: async (request) => {
    if (request.cwd !== process.cwd()) {
      return { decision: 'deny', message: 'Workspace mismatch' };
    }

    const decision = await askUserInUi({
      sessionId: request.sessionId,
      toolName: request.toolName,
      input: request.input,
    });

    return decision.approved
      ? { decision: 'allow' }
      : { decision: 'deny', message: decision.reason ?? 'Denied by user' };
  },
})) {
  publish(msg);
}
```

Return `deny` when the app cannot confidently associate the request with the visible user, workspace, or session.

Adapter limits:

- `opencode` emits an advisory `superconnector` event if `onApprovalRequest` is provided, but does not call the callback.
- `codex` throws `AdapterFailedError` if `onApprovalRequest` is provided.

## Error Mapping

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
    publishError({
      code: 'unknown_session',
      message: error.message,
    });
    return;
  }

  if (error instanceof AdapterNotSetError) {
    publishError({
      code: 'adapter_not_set',
      message: error.message,
    });
    return;
  }

  publishError({
    code: 'agent_failed',
    message: error instanceof Error ? error.message : String(error),
  });
}
```

Also handle app-level validation errors before calling Superconnector, such as unknown workspaces or user access denial.

## Cancellation

```ts
const controller = new AbortController();

const run = (async () => {
  for await (const msg of sc.spawn({
    prompt,
    appId: 'my-consumer-app',
    sessionSelector: workspaceId,
    permissionMode: 'read',
    signal: controller.signal,
  })) {
    publish(msg);
  }
})();

// Wire this to a UI stop button, job cancellation, request close, or shutdown path.
controller.abort();

await run;
```

Use the consumer app's existing cancellation primitive when it can expose an `AbortSignal`.

## Test Adapter

```ts
import type { Adapter, AgentMessage, ResumeOptions, SpawnOptions } from '@nimrobo/superconnector';

export class StubAdapter implements Adapter {
  readonly kind = 'claude-code' as const;
  spawnCalls: SpawnOptions[] = [];
  resumeCalls: ResumeOptions[] = [];
  nextSessionId = 'stub-session-1';

  detect(): boolean {
    return true;
  }

  spawn(opts: SpawnOptions): AsyncIterable<AgentMessage> {
    this.spawnCalls.push(opts);
    const sessionId = this.nextSessionId;
    return (async function* () {
      yield { type: 'system', sessionId, content: { started: true } };
      yield { type: 'assistant', sessionId, content: { text: 'Hello' } };
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

```ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSuperconnector } from '@nimrobo/superconnector';

const home = mkdtempSync(join(tmpdir(), 'sc-test-home-'));
process.env.SUPERCONNECTOR_HOME = home;

const base = mkdtempSync(join(tmpdir(), 'sc-test-cwd-'));
const cwd = join(base, 'workspace');
mkdirSync(cwd);
process.chdir(base);

const adapter = new StubAdapter();
const sc = createSuperconnector({ cwd: 'workspace', adapter });

const seen: string[] = [];
for await (const msg of sc.spawn({
  prompt: 'Plan',
  appId: 'test-app',
  sessionSelector: 'workspace-a',
})) {
  seen.push(msg.type);
}

const sessions = sc.listSessions({ appId: 'test-app', sessionSelector: 'workspace-a' });
assert.equal(sessions.length, 1);
```

Use a temporary `SUPERCONNECTOR_HOME` per test file or per test case to avoid leaking sessions. If a test uses a temporary `cwd`, first `chdir` into its base and pass only that base or a child path.

## Config Notes

Example local config at `<cwd>/.superconnector/config.json`:

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

Run the config UI from the selected workspace:

```sh
npx @nimrobo/superconnector-cli config
```
