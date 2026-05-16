#!/usr/bin/env node
/**
 * Fake opencode CLI for tests. Dispatches by first arg:
 *
 *   models                    — print FAKE_MODELS_OUTPUT (or a default list), exit 0
 *   run [...args] <prompt>    — emit NDJSON events shaped like opencode --format json:
 *                                 step_start, text, step_finish
 *                               sessionID = FAKE_SESSION_ID (default ses_fake-1)
 *                               If RUN_SCENARIO=fail → emit nothing on stdout,
 *                               write to stderr, exit 1.
 *                               If RUN_SCENARIO=malformed-stream → emit bad,
 *                               unknown, partial, and large stream output.
 *                               If RUN_SCENARIO=slow → keep process alive.
 *
 * Writes the literal argv received to FAKE_ARGS_FILE if set (newline-joined),
 * so tests can assert on flag composition.
 */
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argsFile = process.env.FAKE_ARGS_FILE;
if (argsFile) {
  writeFileSync(argsFile, argv.join('\n'));
}

const sub = argv[0];

function writeOut(s) {
  return new Promise((resolve) => process.stdout.write(s, resolve));
}

if (sub === 'models') {
  const out = process.env.FAKE_MODELS_OUTPUT;
  if (out !== undefined) {
    process.stdout.write(out);
  } else {
    process.stdout.write(
      'opencode/big-pickle\nanthropic/claude-sonnet-4-5\ngoogle/gemini-2.5-pro\n',
    );
  }
  process.exit(0);
}

if (sub === 'run') {
  const sid = process.env.FAKE_SESSION_ID || 'ses_fake-1';
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  if (process.env.RUN_SCENARIO === 'slow') {
    setInterval(() => {}, 1000); // keep alive until killed
  } else if (process.env.RUN_SCENARIO === 'fail') {
    process.stderr.write(`${'stderr '.repeat(600)}opencode: simulated failure tail\n`);
    process.exit(1);
  } else if (process.env.RUN_SCENARIO === 'malformed-stream') {
    await writeOut('not-json\n');
    await writeOut(
      `${JSON.stringify({ type: 'future_event', sessionID: sid, part: { ignored: true } })}\n`,
    );
    await writeOut('{"type":"text","sessionID":"');
    await writeOut(`${sid}","part":{"type":"text","text":"partial"}}\n`);
    await writeOut(
      `${JSON.stringify({ type: 'text', sessionID: sid, part: { type: 'text', text: 'x'.repeat(8192) } })}\n`,
    );
    await writeOut(
      `${JSON.stringify({ type: 'step_finish', sessionID: sid, part: { type: 'step-finish', reason: 'stop' } })}\n`,
    );
    process.exit(0);
  } else {
    emit({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } });
    emit({ type: 'text', sessionID: sid, part: { type: 'text', text: 'hi from fake' } });
    emit({ type: 'step_finish', sessionID: sid, part: { type: 'step-finish', reason: 'stop' } });
    process.exit(0);
  }
}

process.exit(0);
