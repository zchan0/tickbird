import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** Codex moves old rollouts into archived_sessions; a fixed sample is found in either place. */
export function sampleFile(file: string): string {
  if (existsSync(file) || !file.includes('/.codex/sessions/')) return file;
  const archived = join(homedir(), '.codex', 'archived_sessions', basename(file));
  return existsSync(archived) ? archived : file;
}
