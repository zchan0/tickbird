// Small process helpers shared by the adapters. Only Node's own modules.
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Runs a command and returns its result; it never throws. */
export function run(command, args, timeout = 3000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.error ? 127 : result.status ?? 1, stdout: result.stdout ?? '', stderr: result.error ? String(result.error.message) : (result.stderr ?? '').trim() };
}

const executable = file => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } };

/** The first of the given paths that is executable, then the name looked up on PATH. */
export function which(name, env = process.env, first = []) {
  for (const file of first) if (file && executable(file)) return file;
  for (const dir of (env.PATH ?? '').split(delimiter)) if (dir && executable(join(dir, name))) return join(dir, name);
  return undefined;
}
