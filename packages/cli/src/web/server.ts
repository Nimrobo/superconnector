import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  localConfigPath,
  readConfig,
  resolveConfig,
  writeConfig,
  type SuperconnectorConfig,
} from '@nimrobo/superconnector/config';

export interface StartConfigServerOptions {
  cwd: string;
  port?: number;
  open?: boolean;
}

export interface ConfigServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function resolveIndexHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'index.html'),
    join(here, '..', '..', 'src', 'web', 'index.html'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(`config UI assets not found near ${here}`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain'): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
  res.end(body);
}

export async function startConfigServer(opts: StartConfigServerOptions): Promise<ConfigServerHandle> {
  const html = resolveIndexHtml();
  const token = randomBytes(16).toString('hex');
  const cwd = opts.cwd;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const tokenOk = url.searchParams.get('t') === token;

      if (req.method === 'GET' && path === '/') {
        sendText(res, 200, html, 'text/html');
        return;
      }
      if (!tokenOk) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      if (req.method === 'GET' && path === '/api/config') {
        const resolved = resolveConfig(cwd);
        sendJson(res, 200, {
          cwd,
          adapters: ['claude-code', 'opencode', 'codex'],
          globalPath: resolved.globalPath,
          localPath: resolved.localPath,
          global: resolved.global ?? {},
          local: resolved.local ?? {},
        });
        return;
      }
      if (req.method === 'PUT' && (path === '/api/config/global' || path === '/api/config/local')) {
        const body = await readBody(req);
        let parsed: SuperconnectorConfig;
        try {
          parsed = JSON.parse(body) as SuperconnectorConfig;
        } catch {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        const target = path === '/api/config/global' ? resolveConfig(cwd).globalPath : localConfigPath(cwd);
        writeConfig(target, parsed);
        sendJson(res, 200, { ok: true, written: target, value: readConfig(target) ?? {} });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('failed to bind config server');
  }
  const port = addr.port;
  const url = `http://127.0.0.1:${port}/?t=${token}`;

  if (opts.open !== false && process.platform === 'darwin') {
    try {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // ignore — user can copy URL from stdout
    }
  }

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
