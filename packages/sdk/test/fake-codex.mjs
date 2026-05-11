#!/usr/bin/env node
/**
 * Fake codex CLI for tests. It supports the small command surface the adapter
 * uses: `exec --json`, `exec --json resume`, and `debug models`.
 */
const scenario = process.env.SCENARIO || 'ok';
const sid = process.env.FAKE_SESSION_ID || 'fake-codex-sess-1';
const args = process.argv.slice(2);

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitModels() {
  if (scenario === 'models-fail-live' && !args.includes('--bundled')) {
    process.stderr.write('live catalog unavailable\n');
    process.exit(1);
  }
  if (scenario === 'models-fail-all') {
    process.stderr.write('catalog unavailable\n');
    process.exit(1);
  }
  emit({
    models: [
      {
        slug: args.includes('--bundled') ? 'bundled-codex' : 'live-codex',
        display_name: args.includes('--bundled') ? 'Bundled Codex' : 'Live Codex',
        description: args.includes('--bundled') ? 'Bundled catalog model' : 'Live catalog model',
      },
    ],
  });
  process.exit(0);
}

if (args[0] === 'debug' && args[1] === 'models') {
  emitModels();
}

if (args[0] !== 'exec') {
  process.stderr.write(`unexpected command: ${args.join(' ')}\n`);
  process.exit(2);
}

if (scenario === 'failure') {
  emit({ type: 'thread.started', thread_id: sid });
  process.stderr.write('codex failed\n');
  process.exit(1);
}

if (scenario === 'no-session') {
  emit({ type: 'agent_message', message: 'hello without a session' });
  process.exit(0);
}

const resumeIndex = args.indexOf('resume');
const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] || sid : sid;

emit({ type: 'thread.started', thread_id: threadId });
emit({ type: 'agent_message', thread_id: threadId, message: { content: 'hi' } });
emit({ type: 'item.started', thread_id: threadId, item: { name: 'shell' } });
emit({ type: 'item.completed', thread_id: threadId, item: { name: 'shell', output: 'ok' } });
emit({ type: 'turn.completed', thread_id: threadId, result: 'done' });
process.exit(0);
