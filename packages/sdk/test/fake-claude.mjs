#!/usr/bin/env node
/**
 * Fake claude CLI for tests. Reads a SCENARIO env var and emits the
 * corresponding stream-json output, then exits.
 *
 * Scenarios:
 *   ok                  — session/init + assistant + result(success), exit 0
 *   permission-result   — session/init + result with permission subtype, exit 1
 *   permission-stderr   — session/init then stderr "permission denied", exit 1
 *   malformed-stream    — invalid/unknown/partial/large stream output, exit 0
 *   slow                — keep process alive until killed
 */
import { writeFileSync } from 'node:fs';

const sid = process.env.FAKE_SESSION_ID || 'fake-sess-1';
const scenario = process.env.SCENARIO || 'ok';
const argsFile = process.env.FAKE_ARGS_FILE;

if (argsFile) {
  writeFileSync(argsFile, process.argv.slice(2).join('\n'));
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function writeOut(s) {
  return new Promise((resolve) => process.stdout.write(s, resolve));
}

emit({ type: 'system', subtype: 'init', session_id: sid });

if (scenario === 'ok') {
  emit({ type: 'assistant', session_id: sid, message: { content: 'hi' } });
  emit({ type: 'result', subtype: 'success', session_id: sid, result: 'done' });
  process.exit(0);
} else if (scenario === 'permission-result') {
  emit({
    type: 'result',
    subtype: 'error_during_execution',
    session_id: sid,
    is_error: true,
    result: 'permission denied for tool Bash',
  });
  process.exit(1);
} else if (scenario === 'permission-stderr') {
  process.stderr.write('claude: permission denied\n');
  process.exit(1);
} else if (scenario === 'malformed-stream') {
  await writeOut('{not json}\n');
  await writeOut(`${JSON.stringify({ type: 'future_event', session_id: sid, message: { ignored: true } })}\n`);
  await writeOut('{"type":"assistant","session_id":"');
  await writeOut(`${sid}","message":{"content":"partial"}}\n`);
  await writeOut(`${JSON.stringify({ type: 'assistant', session_id: sid, message: { content: 'x'.repeat(8192) } })}\n`);
  process.stderr.write(`${'warn '.repeat(600)}tail-warning\n`);
  await writeOut(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: sid, result: 'done' })}\n`);
  process.exit(0);
} else if (scenario === 'slow') {
  setInterval(() => {}, 1000); // keep alive until killed
} else {
  process.exit(0);
}
