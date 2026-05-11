---
name: superconnector-consumer
description: Use when integrating the @nimrobo/superconnector npm package into a consumer app, adding coding-agent session spawn/resume, streaming AgentMessage events, permission approval flows, cancellation, config, or tests for an app that consumes Superconnector.
---

# Superconnector Consumer Integration

Use this skill when an app needs to call `@nimrobo/superconnector` from a trusted Node runtime and expose coding-agent sessions to users.

## First Pass

1. Keep Superconnector on the trusted side of the app: backend, CLI, Electron main process, server action, local daemon, or job worker. Do not run it in a browser-only client.
2. Omit `cwd` by default so Superconnector uses the trusted runtime's `process.cwd()`. Pass `cwd` only to intentionally narrow execution to `process.cwd()` itself or a child directory.
3. Choose one stable `appId` for the app or feature. Use the same id for spawn, resume, and session listing.
4. Add `sessionSelector` only when the app needs separate scopes inside one `appId`, such as workspace, thread, tab, or conversation id.
5. Select the adapter deliberately:
   - Pass an explicit adapter when the app knows the target runtime.
   - Let config/detection choose when users should control the runtime.
   - Prefer `claude-code` when the app needs Superconnector approval callbacks.
6. Wire an `AbortSignal` from the request, job, or UI stop path.
7. Map SDK errors into app-level errors before exposing them to the UI.
8. Read `references/integration-patterns.md` for implementation-ready examples.

## Implementation Defaults

- Create one `Superconnector` instance near the app's agent-service boundary with `createSuperconnector({ adapter })`, or `createSuperconnector()` when config/detection should select the adapter.
- Pass `cwd` only for narrower child paths, such as `createSuperconnector({ cwd: "packages/app" })`. Parent, sibling, and other outside paths are rejected.
- Stream with `for await...of` and translate each `AgentMessage` into the app's websocket, SSE, job, queue, or store model.
- Use `permissionMode: "read"` for planning, analysis, preview, and review flows.
- Use `permissionMode: "acceptEdits"` only when the user started an edit-capable workflow.
- Use `resumeLastCreatedSession: true` for simple "continue this app's latest run" flows. Include `sessionSelector` when continuing within a specific thread or workspace scope.
- Use explicit `sessionId` plus `listSessions({ appId })` for multi-session UIs.
- Treat `AgentMessage.content` as adapter-shaped data. Normalize it at the app boundary before storing or rendering.

## Adapter Guidance

- `claude-code`: best default when the app needs approval callbacks. Supports `onApprovalRequest` through a Superconnector approval host.
- `opencode`: can spawn, resume, and stream JSON output. Programmatic approval callbacks are not supported; Superconnector emits an advisory event if one is provided.
- `codex`: can spawn and resume through `codex exec --json`. Superconnector approval callbacks are rejected in exec mode.

Adapter detection requires both the agent binary and a project marker in or above `cwd`:

- Claude Code: `claude` plus `CLAUDE.md` or `.claude`
- OpenCode: `opencode` plus `opencode.json` or `.opencode`
- Codex: `codex` plus `AGENTS.md` or `.codex`

## Config And State

- Global config defaults to `~/.superconnector/config.json`.
- Local config lives at `<cwd>/.superconnector/config.json` and overrides global config. By default, `<cwd>` is `process.cwd()`.
- Session registry and logs default to `~/.superconnector`.
- Set `SUPERCONNECTOR_HOME` in tests to isolate registry and config state.
- The `superconnector config` CLI opens a local UI for adapter, permission, and model settings.

## Testing

- Prefer a stub `Adapter` for consumer-app unit tests.
- Use temporary `SUPERCONNECTOR_HOME` paths for session tests. If a test needs a temporary `cwd`, first `chdir` into the allowed base or pass a child path under the current process directory.
- Cover spawn, explicit resume, `resumeLastCreatedSession`, selector scoping, cancellation, approval allow/deny when using Claude Code, and app-level error mapping.
