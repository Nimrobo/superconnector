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

if (sub === 'models') {
  const out = process.env.FAKE_MODELS_OUTPUT;
  if (out !== undefined) {
    process.stdout.write(out);
  } else {
    process.stdout.write('opencode/big-pickle\nanthropic/claude-sonnet-4-5\ngoogle/gemini-2.5-pro\n');
  }
  process.exit(0);
}

if (sub === 'run') {
  if (process.env.RUN_SCENARIO === 'fail') {
    process.stderr.write('opencode: simulated failure\n');
    process.exit(1);
  }
  const sid = process.env.FAKE_SESSION_ID || 'ses_fake-1';
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  emit({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } });
  emit({ type: 'text', sessionID: sid, part: { type: 'text', text: 'hi from fake' } });
  emit({ type: 'step_finish', sessionID: sid, part: { type: 'step-finish', reason: 'stop' } });
  process.exit(0);
}

process.exit(0);
