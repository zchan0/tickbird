import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** Codex moves old rollouts into archived_sessions; a fixed sample is found in either place. */
export function sampleFile(file: string): string {
  if (existsSync(file) || !file.includes('/.codex/sessions/')) return file;
  const archived = join(homedir(), '.codex', 'archived_sessions', basename(file));
  return existsSync(archived) ? archived : file;
}

/** Real sessions on one machine, named for the checks (CX1, CL2…): their paths stay out of the repository. */
export interface LocalSamples { projectPath: string; claudeProjectDir: string; files: Record<string, string> }

/** local/samples.json (or $TICKBIRD_SAMPLES); without it the check says what to write and stops. */
export function localSamples(): LocalSamples {
  const file = process.env.TICKBIRD_SAMPLES || join(__dirname, '..', '..', 'local', 'samples.json');
  try { return JSON.parse(readFileSync(file, 'utf8')) as LocalSamples; } catch {
    console.error(`这个检查读本机的真实会话。在 ${file} 写上 {"projectPath": "…", "claudeProjectDir": "…", "files": {"CX1": "…rollout….jsonl", "CL1": "….jsonl"}}`);
    process.exit(2);
  }
}
