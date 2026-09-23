import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The harness's own statement of whether it is working, not a guess from file times. */
export type AgentRunState = 'busy' | 'idle';

/** `<claude home>/projects/<project>/<session>.jsonl` → `<claude home>/sessions`. */
export const claudeSessionsDirectory = (transcript: string): string => join(dirname(dirname(dirname(transcript))), 'sessions');

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Claude Code keeps `sessions/<pid>.json` for each running process, with the
 * session it is attached to and `busy` or `idle`. An interrupt before any output
 * leaves no record in the transcript; this file still turns idle. A file whose
 * process has exited says nothing. The last matching file is remembered so a
 * poll reads one small file, and the directory is scanned again only on a miss.
 */
export function claudeRunState(transcript: string, sessionId: string): () => Promise<AgentRunState | undefined> {
  const directory = claudeSessionsDirectory(transcript);
  let known: string | undefined;
  const read = async (name: string): Promise<AgentRunState | undefined> => {
    let entry: { sessionId?: unknown; pid?: unknown; status?: unknown };
    try { entry = JSON.parse(await readFile(join(directory, name), 'utf8')); } catch { return undefined; }
    const pid = Number(entry?.pid);
    if (entry?.sessionId !== sessionId || !Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return undefined;
    return entry.status === 'busy' || entry.status === 'idle' ? entry.status : undefined;
  };
  return async () => {
    if (known) { const state = await read(known); if (state) return state; }
    let names: string[];
    try { names = (await readdir(directory)).filter(name => /^\d+\.json$/.test(name)); } catch { return undefined; }
    for (const name of names) {
      const state = await read(name);
      if (state) { known = name; return state; }
    }
    known = undefined;
    return undefined;
  };
}
