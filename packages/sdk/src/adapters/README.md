# Writing a Superconnector adapter

An adapter implements the `Adapter` interface from `@nimrobo/superconnector`:

```ts
interface Adapter {
  kind: AdapterKind;
  detect(cwd: string): boolean;
  spawn(opts: SpawnOptions, cwd: string): AsyncIterable<AgentMessage>;
  resume(opts: ResumeOptions, cwd: string): AsyncIterable<AgentMessage>;
}
```

Contract:

- `detect` returns whether this adapter is usable for `cwd`. Built-in adapters require both a matching project marker and a binary that was available when the adapter was constructed.
- `spawn` starts a brand-new agent session in `cwd` for the prompt in `opts.prompt`.
- `resume` continues an existing session identified by `opts.sessionId`.
- Both yield `AgentMessage`s as they arrive. The **first** message must carry a non-empty `sessionId` so the connector can persist it in the registry.
- Honor `opts.signal` for cancellation. SIGTERM the underlying process on abort.
- On hard failure, throw `AdapterFailedError` with captured stderr.

The default `ClaudeCodeAdapter` (in `claude-code/`) is a reference implementation that shells out to the `claude` CLI with `--output-format stream-json`. New adapters can either shell out to a binary or call an SDK directly — the connector core doesn't care.
