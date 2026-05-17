# Superconnector

[![npm version](https://img.shields.io/npm/v/@nimrobo/superconnector.svg?label=%40nimrobo%2Fsuperconnector)](https://www.npmjs.com/package/@nimrobo/superconnector)
[![npm version](https://img.shields.io/npm/v/@nimrobo/superconnector-cli.svg?label=%40nimrobo%2Fsuperconnector-cli)](https://www.npmjs.com/package/@nimrobo/superconnector-cli)
[![license](https://img.shields.io/npm/l/@nimrobo/superconnector.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@nimrobo/superconnector.svg)](https://nodejs.org)

Superconnector is a Node/TypeScript SDK for apps that need to start, resume, and stream coding-agent sessions from a trusted runtime. It gives product code one small interface for running agent CLIs such as Claude Code, OpenCode, and Codex while keeping session history, resume behavior, permissions, and configuration in one place.

This release is beta-ready. The core API is intended for real integration work, but the package is still `0.1.x`; adapter details can evolve as upstream agent CLIs change.

## Packages

```sh
npm install @nimrobo/superconnector
npm install -g @nimrobo/superconnector-cli
```

- `@nimrobo/superconnector` is the SDK used by your app.
- `@nimrobo/superconnector-cli` provides the `superconnector` command and currently focuses on configuration.

Requirements:

- Node.js `>=20`
- A trusted Node runtime such as a backend, CLI, Electron main process, local daemon, or server action that can safely spawn processes
- The target agent CLI already installed and authenticated on the host

## Quick Start

```ts
import { createSuperconnector } from '@nimrobo/superconnector';

const sc = createSuperconnector({
  adapter: 'claude-code',
});

for await (const message of sc.spawn({
  prompt: 'Inspect this project and summarize the main risks.',
  appId: 'my-app',
  permissionMode: 'read',
})) {
  console.log(message.type, message.sessionId, message.content);
}
```

Use `permissionMode: "read"` for planning, review, and analysis flows. Use `permissionMode: "acceptEdits"` only when the user has started a workflow that may edit files.

## Core Concepts

- **Adapter**: the agent runtime to use. Built-ins are `claude-code`, `opencode`, and `codex`.
- **`cwd`**: the project directory where the agent runs. By default this is `process.cwd()`. If passed explicitly, it must resolve to the current process cwd or one of its descendants. Start Superconnector from the trusted workspace root or use a relative child path such as `"packages/app"`.
- **`appId`**: a stable identifier for your app or feature. Superconnector records sessions by `cwd` and `appId`.
- **`sessionSelector`**: an optional narrower scope inside an app, such as a workspace id, tab id, thread id, or user-visible conversation id.
- **Session registry**: Superconnector records spawned sessions under `~/.superconnector` by default so the app can list and resume them later.
- **Streaming**: `spawn()` and `resume()` return `AsyncIterable<AgentMessage>`, so apps can forward messages to websockets, SSE, job logs, or stores.
- **Cancellation**: pass an `AbortSignal` to stop an active run.

## Resume

For explicit multi-session UIs, list sessions and resume the selected id:

```ts
const sessions = sc.listSessions({ appId: 'my-app', sessionSelector: 'workspace-a' });
const selected = sessions[0];

if (selected) {
  for await (const message of sc.resume({
    prompt: 'Continue from the last result.',
    appId: selected.appId,
    sessionSelector: selected.sessionSelector,
    sessionId: selected.sessionId,
    permissionMode: 'read',
  })) {
    console.log(message);
  }
}
```

For simple "continue this app's latest session" flows, use `resumeLastCreatedSession`:

```ts
for await (const message of sc.spawn({
  prompt: 'Continue working on this task.',
  appId: 'my-app',
  sessionSelector: 'workspace-a',
  resumeLastCreatedSession: true,
  permissionMode: 'read',
})) {
  console.log(message);
}
```

If no matching session exists, `resumeLastCreatedSession` starts a new one.

## Configuration

Run the config UI:

```sh
superconnector config
```

Options:

```sh
superconnector config --port 3917
superconnector config --no-open
```

Configuration can set:

- preferred adapter
- default permission mode
- per-adapter model ids

Config locations:

- Global config: `~/.superconnector/config.json`
- Local config: `<cwd>/.superconnector/config.json`
- Registry and session logs: `~/.superconnector`
- Tests and isolated environments can override the global root with `SUPERCONNECTOR_HOME`

Local config overrides global config. Passing an explicit `adapter` to `createSuperconnector()` overrides config and detection.

## Preview the Adapter

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

To build the adapter or model picker itself, enumerate the choices with `listAdapters()` and `listModels()`. Unlike `whichAdapterWillRun()`, which previews the single next run, these list every available option and never start an agent.

```ts
// One entry per built-in adapter, with detection and selection flags.
for (const a of sc.listAdapters()) {
  console.log(a.kind, a.detected, a.selected);
}

// Models for a given adapter kind, independent of the selected adapter.
const models = await sc.listModels('claude-code');
console.log(models.map((m) => m.id));
```

## Adapter Notes

| Adapter       | Detects                                                  | Notes                                                                                                                                       |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | `CLAUDE.md` or `.claude` plus `claude` on `PATH`         | Supports Superconnector approval callbacks through an approval host.                                                                        |
| `opencode`    | `opencode.json` or `.opencode` plus `opencode` on `PATH` | Runs and streams JSON output. Programmatic approval callbacks are not supported; Superconnector emits an advisory event if one is provided. |
| `codex`       | `AGENTS.md` or `.codex` plus `codex` on `PATH`           | Runs `codex exec --json`. Superconnector approval callbacks are rejected in exec mode.                                                      |

Each adapter shells out to the corresponding CLI. Install and authenticate those CLIs separately before using Superconnector.

## Permissions

Superconnector exposes two permission modes:

- `read`: analysis and planning mode. Adapters map this to their safest available read-only behavior.
- `acceptEdits`: edit-capable mode. Use this only when the user has opted into agent edits.

Approval callbacks are adapter-specific. Claude Code supports an `onApprovalRequest` callback; OpenCode and Codex currently do not provide equivalent programmatic approval support through Superconnector.

## Public Entry Points

```ts
import { createSuperconnector } from '@nimrobo/superconnector';
import { resolveConfig } from '@nimrobo/superconnector/config';
import { ClaudeCodeAdapter } from '@nimrobo/superconnector/adapters/claude-code';
import { OpenCodeAdapter } from '@nimrobo/superconnector/adapters/opencode';
import { CodexAdapter } from '@nimrobo/superconnector/adapters/codex';
```

See the package docs for more detailed SDK and CLI references:

- [`packages/sdk/README.md`](packages/sdk/README.md)
- [`packages/cli/README.md`](packages/cli/README.md)

## Development

```sh
npm install
npm run build
npm test
```

Package dry runs:

```sh
npm pack --dry-run --workspace @nimrobo/superconnector
npm pack --dry-run --workspace @nimrobo/superconnector-cli
```

## License

MIT
