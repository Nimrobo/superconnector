#!/usr/bin/env node
import { startConfigServer } from './web/server.js';

function usage(): void {
  process.stderr.write(
    [
      'Usage: superconnector <command>',
      '',
      'Commands:',
      '  config              Open the config web UI',
      '',
      'Options for `config`:',
      '  --port <n>          Bind to a specific port (default: ephemeral)',
      '  --no-open           Do not auto-open the browser',
      '',
    ].join('\n'),
  );
}

interface ConfigCliFlags {
  port?: number;
  open: boolean;
}

function parseConfigFlags(args: string[]): ConfigCliFlags {
  const out: ConfigCliFlags = { open: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-open') out.open = false;
    else if (a === '--port') {
      const next = args[++i];
      if (!next) throw new Error('--port requires a value');
      const n = Number(next);
      if (!Number.isFinite(n) || n < 0 || n > 65535)
        throw new Error(`invalid --port value: ${next}`);
      out.port = n;
    } else if (a === '-h' || a === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

async function runConfig(args: string[]): Promise<void> {
  const flags = parseConfigFlags(args);
  const handle = await startConfigServer({
    cwd: process.cwd(),
    open: flags.open,
    ...(flags.port !== undefined ? { port: flags.port } : {}),
  });
  process.stdout.write(`superconnector config: ${handle.url}\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');

  const shutdown = async (): Promise<void> => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === 'config') {
    await runConfig(rest);
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  usage();
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
