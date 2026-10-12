import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseClaude } from './claude';
import type { SessionData } from './model';

/**
 * A subagent's own record, beside its session's: Claude Code keeps it at
 * <session>/subagents/agent-<id>.jsonl, and the .meta.json next to it names
 * the call that started it (toolUseId). Read only; nothing in it runs.
 */
export interface Subagent { callId: string; file: string; session: SessionData }

/** Records already read, by file: one that has not changed is not read again. */
export type SubagentCache = Map<string, { size: number; mtimeMs: number; subagent: Subagent }>;

export const claudeSubagentDirectory = (transcript: string, sessionId: string): string => join(dirname(transcript), sessionId, 'subagents');

/** The session's subagents by the id of the call that started each; `changed` when any record was read anew. */
export async function readClaudeSubagents(session: Pick<SessionData, 'id' | 'projectPath'>, transcript: string, cache: SubagentCache = new Map()): Promise<{ byCall: Map<string, Subagent>; changed: boolean }> {
  const directory = claudeSubagentDirectory(transcript, session.id);
  const byCall = new Map<string, Subagent>();
  let changed = false;
  let names: string[] = [];
  try { names = await readdir(directory); } catch { return { byCall, changed: false }; }
  for (const name of names.filter(name => name.endsWith('.meta.json'))) {
    const file = join(directory, name.replace(/\.meta\.json$/, '.jsonl'));
    try {
      const meta: unknown = JSON.parse(await readFile(join(directory, name), 'utf8'));
      const callId = meta && typeof meta === 'object' && typeof (meta as { toolUseId?: unknown }).toolUseId === 'string' ? (meta as { toolUseId: string }).toolUseId : undefined;
      if (!callId) continue;
      const info = await stat(file);
      const kept = cache.get(file);
      if (kept && kept.size === info.size && kept.mtimeMs === info.mtimeMs) { byCall.set(callId, kept.subagent); continue; }
      const subagent = { callId, file, session: parseClaude({ file, projectPath: session.projectPath, text: await readFile(file, 'utf8') }) };
      cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, subagent });
      byCall.set(callId, subagent);
      changed = true;
    } catch { /* A record being written or gone: the call shows as it does without one. */ }
  }
  return { byCall, changed };
}
