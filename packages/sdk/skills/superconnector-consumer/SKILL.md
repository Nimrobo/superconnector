---
name: superconnector-consumer
description: Use when integrating the @nimrobo/superconnector npm package into a consumer app, adding agent session spawning/resume, streaming agent messages, permission approval flows, cancellation, or tests for an app that consumes Superconnector.
---

# Superconnector Consumer Integration

Use this skill to integrate `@nimrobo/superconnector` into an application that wants to spawn, resume, and stream coding-agent sessions.

## First Pass

1. Inspect the consumer app's runtime boundary. `@nimrobo/superconnector` is a Node package that starts agent processes, so keep it in a backend, CLI, Electron main process, server action, or other trusted Node runtime.
2. Identify the workspace directory that should become `cwd`. This should be the repo or project directory the agent will work in, not a temporary request directory.
3. Choose a stable `appId` for the consumer app or feature. Use the same id for spawn, resume, and session listing.
4. Choose a `sessionSelector` only when the app needs a per-workspace, thread, tab, or user-visible conversation scope inside the same `appId`.
5. Use `claude-code` for now when selecting an adapter.
6. Read `references/integration-patterns.md` when you need examples for streaming, resume, permissions, error handling, or tests.

## Implementation Defaults

- Create one `Superconnector` instance near the app's agent-service boundary with `createSuperconnector({ cwd, adapter: "claude-code" })` unless the app already has dependency injection for services.
- Stream with `for await...of` and translate `AgentMessage` events into the app's existing event, websocket, SSE, job, or store model.
- Use `resumeLastCreatedSession: true` for simple "continue this app's last agent run" flows. Include `sessionSelector` when continuing within a specific thread or workspace scope.
- Use explicit `sessionId` plus `listSessions({ appId })` for multi-session UIs; use `listSessions({ appId, sessionSelector })` when the UI should only show sessions for one selector.
- Pass an `AbortSignal` from the request, job, or UI cancellation path so the app can stop long-running agent sessions.
- Default to `permissionMode: "read"` for planning, analysis, preview, and review flows. Use `permissionMode: "acceptEdits"` only when the user clearly started an edit-capable workflow.
- Provide `onApprovalRequest` when the UI can ask the user about tool permissions. Return `deny` on timeout, stale sessions, mismatched workspace, or unclear user intent.
- Treat `AgentMessage.content` as adapter-shaped data. Normalize it at the app boundary before storing or rendering.

## Config And State

- `@nimrobo/superconnector` groups sessions by `cwd` and stable `appId`; `sessionSelector` narrows session lookup inside that app without creating a separate app entry.
- Local config lives under `.superconnector/config.json` in the selected `cwd`; global state defaults to `~/.superconnector`.
- Set `SUPERCONNECTOR_HOME` in tests to isolate registry and config state.
- The `superconnector config` CLI opens the package's config UI for adapter, permission, and model settings.

## Testing

- Prefer a stub `Adapter` for consumer-app unit tests. Yield deterministic `AgentMessage` objects from async generators and assert the app's translated output.
- Test session flows with a temporary `cwd`, isolated `SUPERCONNECTOR_HOME`, a fixed `appId`, and fixed `sessionSelector` values when validating scoped resume behavior.
- Cover cancellation, resume, approval allow/deny, and app-level error mapping.
