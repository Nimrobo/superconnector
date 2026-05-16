import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

function isPathLike(command: string): boolean {
  return isAbsolute(command) || command.includes('/') || command.includes('\\');
}

function canExecute(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform !== 'win32' || /\.[^\\/]+$/.test(command)) return [command];
  const exts = (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  return [command, ...exts.map((ext) => `${command}${ext}`)];
}

export function isExecutableAvailableForPlatform(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!command) return false;
  if (isPathLike(command)) return canExecute(command);

  const path = env['PATH'] ?? '';
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  for (const dir of path.split(pathDelimiter)) {
    if (!dir) continue;
    for (const name of candidateNames(command, platform, env)) {
      if (canExecute(join(dir, name))) return true;
    }
  }
  return false;
}

export function isExecutableAvailable(command: string): boolean {
  return isExecutableAvailableForPlatform(command, process.platform, process.env);
}
