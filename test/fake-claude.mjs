#!/usr/bin/env node
/**
 * Fake claude CLI for tests. Reads a SCENARIO env var and emits the
 * corresponding stream-json output, then exits.
 *
 * Scenarios:
 *   ok                  — session/init + assistant + result(success), exit 0
 *   permission-result   — session/init + result with permission subtype, exit 1
 *   permission-stderr   — session/init then stderr "permission denied", exit 1
 */
const sid = process.env.FAKE_SESSION_ID || 'fake-sess-1';
const scenario = process.env.SCENARIO || 'ok';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
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
} else {
  process.exit(0);
}
