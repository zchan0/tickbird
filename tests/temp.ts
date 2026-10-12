import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node --test runs each file in a process of its own: what a file made goes when it ends.
const made: string[] = [];
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A new directory under the system temp folder, removed when this test file's process exits. */
export function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tickbird-${name}-`));
  made.push(dir);
  return dir;
}
