# Superconnector CLI

[![npm version](https://img.shields.io/npm/v/@nimrobo/superconnector-cli.svg)](https://www.npmjs.com/package/@nimrobo/superconnector-cli)
[![npm downloads](https://img.shields.io/npm/dm/@nimrobo/superconnector-cli.svg)](https://www.npmjs.com/package/@nimrobo/superconnector-cli)
[![license](https://img.shields.io/npm/l/@nimrobo/superconnector-cli.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@nimrobo/superconnector-cli.svg)](https://nodejs.org)

`@nimrobo/superconnector-cli` — command-line companion for Superconnector. The CLI currently provides a local config UI for the `@nimrobo/superconnector` SDK.

## Install

```sh
npm install -g @nimrobo/superconnector-cli
```

Or run without a global install:

```sh
npx @nimrobo/superconnector-cli config
```

Requirements:

- Node.js `>=20`
- The SDK package is installed as a dependency of this CLI package
- Agent CLIs such as `claude`, `opencode`, or `codex` should be installed and authenticated before selecting them

## Usage

```sh
superconnector config
```

The command starts a local web UI bound to `127.0.0.1`, prints the URL, and opens the browser on macOS by default.

Options:

```sh
superconnector config --port 3917
superconnector config --no-open
```

- `--port <n>` binds the config server to a specific port. Without it, the CLI uses an ephemeral port.
- `--no-open` prints the URL without opening a browser.

Press `Ctrl+C` to stop the config server.

## What the UI Configures

The config UI can write global and local Superconnector config:

- preferred adapter: `claude-code`, `opencode`, or `codex`
- default permission mode: `read` or `acceptEdits`
- per-adapter model ids

Global config applies to every workspace. Local config applies only to the current workspace and overrides global config.

Config locations:

- Global: `~/.superconnector/config.json`
- Local: `<cwd>/.superconnector/config.json`
- Registry and session logs: `~/.superconnector`
- Override global root with `SUPERCONNECTOR_HOME`

Example config:

```json
{
  "preferredAdapter": "claude-code",
  "permissionMode": "read",
  "models": {
    "claude-code": "sonnet",
    "codex": "gpt-5.3-codex"
  }
}
```

## Relationship to the SDK

Use `@nimrobo/superconnector` in application code:

```ts
import { createSuperconnector } from '@nimrobo/superconnector';
```

Use `@nimrobo/superconnector-cli` for user or developer configuration:

```sh
superconnector config
```

The CLI is not required at runtime when your app passes explicit SDK options, but it is useful when users should choose adapters, permission defaults, or model ids outside the application.

## Security Notes

The config server binds to localhost and uses a random URL token for API calls. Treat the CLI as a local developer/user tool and run it from the workspace whose local config you want to edit.

## License

MIT
