# Superconnector Consumer Integration Patterns

Load this reference when implementing concrete Superconnector integration code in a consumer app.

## Basic Service

```ts
import {
  createSuperconnector,
  PermissionRequiredError,
  type AgentMessage,
} from "@nimrobo/superconnector";

export interface AgentRunEvent {
  sessionId: string;
  type: AgentMessage["type"];
  content: unknown;
}

export function createAgentService(args: { cwd: string; appId: string; sessionSelector?: string }) {
  const sc = createSuperconnector({
    cwd: args.cwd,
    adapter: "claude-code",
  });

  return {
    listSessions() {
      return sc.listSessions({
        appId: args.appId,
        ...(args.sessionSelector !== undefined ? { sessionSelector: args.sessionSelector } : {}),
      });
    },

    async *spawn(prompt: string, signal?: AbortSignal): AsyncIterable<AgentRunEvent> {
      for await (const msg of sc.spawn({
        prompt,
        appId: args.appId,
        ...(args.sessionSelector !== undefined ? { sessionSelector: args.sessionSelector } : {}),
        permissionMode: "read",
        signal,
      })) {
        yield normalizeMessage(msg);
      }
    },

    async *resume(sessionId: string, prompt: string, signal?: AbortSignal): AsyncIterable<AgentRunEvent> {
      for await (const msg of sc.resume({
        sessionId,
        prompt,
        appId: args.appId,
        ...(args.sessionSelector !== undefined ? { sessionSelector: args.sessionSelector } : {}),
        permissionMode: "read",
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

## Continue Last Session

Use this for simple apps with one active thread per workspace, or one active thread per selector.

```ts
for await (const msg of sc.spawn({
  prompt,
  appId: "my-consumer-app",
  sessionSelector: workspaceId,
  resumeLastCreatedSession: true,
  permissionMode: "read",
  signal,
})) {
  publish(msg);
}
```

`resumeLastCreatedSession` resumes the most recent recorded session for the same `cwd`, `appId`, and `sessionSelector`. If `sessionSelector` is omitted, only sessions without a selector are considered. If no matching session exists, it starts a new one.

## Multi-Session Resume

```ts
const sessions = workspaceId === undefined
  ? sc.listSessions({ appId: "my-consumer-app" })
  : sc.listSessions({ appId: "my-consumer-app", sessionSelector: workspaceId });
const selected = sessions.find((s) => s.sessionId === requestedSessionId);

if (!selected) {
  throw new Error("Unknown agent session");
}

for await (const msg of sc.resume({
  sessionId: selected.sessionId,
  prompt,
  appId: selected.appId,
  ...(selected.sessionSelector !== undefined ? { sessionSelector: selected.sessionSelector } : {}),
  permissionMode: "read",
  signal,
})) {
  publish(msg);
}
```

Keep session selection in app state. Do not ask users to paste raw resume commands when the app can call `resume`.

## Approval Requests

Use approvals when the app wants an edit-capable run while still letting the user decide on tool requests.

```ts
for await (const msg of sc.spawn({
  prompt,
  appId: "my-consumer-app",
  permissionMode: "acceptEdits",
  approvalTimeoutMs: 60_000,
  onApprovalRequest: async (request) => {
    if (request.cwd !== workspaceCwd) {
      return { decision: "deny", message: "Workspace mismatch" };
    }

    const decision = await askUserInUi({
      sessionId: request.sessionId,
      toolName: request.toolName,
      input: request.input,
    });

    return decision.approved
      ? { decision: "allow" }
      : { decision: "deny", message: decision.reason ?? "Denied by user" };
  },
})) {
  publish(msg);
}
```

Return `deny` when the app cannot confidently associate the request with the visible user/workspace/session.

## Error Mapping

```ts
try {
  for await (const msg of stream) {
    publish(msg);
  }
} catch (error) {
  if (error instanceof PermissionRequiredError) {
    publishError({
      code: "permission_required",
      message: error.message,
      sessionId: error.sessionId,
    });
    return;
  }

  publishError({
    code: "agent_failed",
    message: error instanceof Error ? error.message : String(error),
  });
}
```

Also handle `UnknownSessionError` when resuming explicit session IDs and `AdapterNotSetError` if app configuration can omit adapter selection.

## Cancellation

```ts
const controller = new AbortController();

const run = (async () => {
  for await (const msg of sc.spawn({
    prompt,
    appId: "my-consumer-app",
    sessionSelector: workspaceId,
    permissionMode: "read",
    signal: controller.signal,
  })) {
    publish(msg);
  }
})();

// Wire this to a UI stop button, job cancellation, or request close event.
controller.abort();

await run;
```

Use the consumer app's existing cancellation primitive when it can expose an `AbortSignal`.

## Test Adapter

```ts
import type {
  Adapter,
  AgentMessage,
  ResumeOptions,
  SpawnOptions,
} from "@nimrobo/superconnector";

export class StubAdapter implements Adapter {
  readonly kind = "claude-code" as const;
  spawnCalls: SpawnOptions[] = [];
  resumeCalls: ResumeOptions[] = [];
  nextSessionId = "stub-session-1";

  spawn(opts: SpawnOptions): AsyncIterable<AgentMessage> {
    this.spawnCalls.push(opts);
    const sessionId = this.nextSessionId;
    return (async function* () {
      yield { type: "system", sessionId, content: { started: true } };
      yield { type: "assistant", sessionId, content: { text: "Hello" } };
      yield { type: "result", sessionId, content: { ok: true } };
    })();
  }

  resume(opts: ResumeOptions): AsyncIterable<AgentMessage> {
    this.resumeCalls.push(opts);
    const sessionId = opts.sessionId;
    return (async function* () {
      yield { type: "assistant", sessionId, content: { text: "Resumed" } };
      yield { type: "result", sessionId, content: { ok: true } };
    })();
  }
}
```

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuperconnector } from "@nimrobo/superconnector";

const home = mkdtempSync(join(tmpdir(), "sc-test-home-"));
process.env.SUPERCONNECTOR_HOME = home;

const cwd = mkdtempSync(join(tmpdir(), "sc-test-cwd-"));
const adapter = new StubAdapter();
const sc = createSuperconnector({ cwd, adapter });

const seen: string[] = [];
for await (const msg of sc.spawn({
  prompt: "Plan",
  appId: "test-app",
  sessionSelector: "workspace-a",
})) {
  seen.push(msg.type);
}

const sessions = sc.listSessions({ appId: "test-app", sessionSelector: "workspace-a" });
assert.equal(sessions.length, 1);
```

Use a temporary `cwd` and `SUPERCONNECTOR_HOME` per test file or per test case to avoid leaking sessions between tests.

## Config Notes

Example local config at `<cwd>/.superconnector/config.json`:

```json
{
  "preferredAdapter": "claude-code",
  "permissionMode": "read",
  "models": {
    "claude-code": "configured-model"
  }
}
```

Run the config UI from the selected workspace:

```sh
npx @nimrobo/superconnector-cli config
```
