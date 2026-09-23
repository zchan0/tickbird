import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionData } from './model';

const maximumIndexBytes = 4 * 1024 * 1024;

/** Known title fields are display metadata, not arbitrary text or rich content. */
export function explicitSessionTitle(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const title = value.trim();
  return title || undefined;
}

/** Optional read-only decoration after session identity/project validation.
 * The index never selects a session, changes activity, or replaces source records.
 * Callers with synthetic/nondefault logs must supply an explicit fixture index.
 */
export async function applyCodexSessionTitle(session: SessionData, indexFile = join(homedir(), '.codex', 'session_index.jsonl')): Promise<SessionData> {
  if (session.provider !== 'codex' || !session.id.trim()) return session;
  let handle: FileHandle | undefined;
  try {
    const pathBefore = await lstat(indexFile);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > maximumIndexBytes) return session;
    // NONBLOCK prevents a replacement FIFO/device from blocking before fstat.
    handle = await open(indexFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumIndexBytes || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino) return session;
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) return session;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(indexFile);
    if (!current.isFile() || current.isSymbolicLink() || before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.size !== current.size || before.mtimeMs !== current.mtimeMs) return session;
    let title: string | undefined;
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      // A partially written/malformed index is not treated as an authoritative
      // rename snapshot. No fragments or unrelated rows escape this function.
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const value = row as Record<string, unknown>;
      if (value.id !== session.id) continue;
      const candidate = explicitSessionTitle(value.thread_name);
      if (candidate) title = candidate;
    }
    return title ? { ...session, title, titleSource: 'codex-index' } : session;
  } catch { return session; }
  finally { await handle?.close().catch(() => undefined); }
}
