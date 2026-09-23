import { createReadStream, constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { Provider, SessionCandidate, SessionData } from './model';
import { createCodexParser } from './codex';
import { createClaudeParser } from './claude';
import { applyCodexSessionTitle } from './session-title';

export interface DiscoveryOptions { projectPath: string; codexRoot?: string; claudeRoot?: string }
export interface DiscoveryResult { candidates: SessionCandidate[]; warnings: string[] }
export const sessionKey = (session: Pick<SessionCandidate, 'provider' | 'id'>): string => `${session.provider}:${session.id}`;
export const claudeProjectDirectory = (path: string): string => resolve(path).replace(/[^a-zA-Z0-9_-]/g, '-');
const within = (root: string, child: string): boolean => {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(child).startsWith(`${root}${sep}..${sep}`) && !rel.startsWith(sep));
};
async function canonical(path: string): Promise<string> { return realpath(path).catch(() => resolve(path)); }
const isCodexSubagent = (meta: any): boolean => meta?.source !== null && typeof meta?.source === 'object' && Object.hasOwn(meta.source, 'subagent');

/** Read only a bounded identity prefix before a candidate is placed in project scope. */
async function identity(file: string, provider: Provider): Promise<{ id: string; cwd: string } | undefined> {
  const stream = createReadStream(file, { encoding: 'utf8', start: 0, end: 131071 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let count = 0;
    for await (const line of lines) {
      if (++count > 50) break;
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      if (provider === 'codex') {
        if (record.type === 'session_meta' && typeof record.payload?.id === 'string' && typeof record.payload.cwd === 'string') {
          // Only main Agent sessions belong in the user-facing session picker.
          // Child returns remain observable from their parent's public records.
          if (isCodexSubagent(record.payload)) return undefined;
          return { id: record.payload.id, cwd: record.payload.cwd };
        }
        break;
      }
      if (typeof record.sessionId === 'string' && typeof record.cwd === 'string' && !record.isSidechain) {
        return { id: record.sessionId, cwd: record.cwd };
      }
    }
  } finally { lines.close(); stream.destroy(); }
}

async function* logFiles(directory: string, depth: number): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) yield join(directory, entry.name);
    else if (depth > 0 && entry.isDirectory()) yield* logFiles(join(directory, entry.name), depth - 1);
  }
}

export async function discoverSessions(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const project = await canonical(options.projectPath);
  const candidates: SessionCandidate[] = [];
  const warnings: string[] = [];
  const sources: Array<{ provider: Provider; root: string; depth: number }> = [
    { provider: 'codex', root: options.codexRoot ?? join(homedir(), '.codex', 'sessions'), depth: 4 },
    { provider: 'claude', root: join(options.claudeRoot ?? join(homedir(), '.claude', 'projects'), claudeProjectDirectory(options.projectPath)), depth: 0 }
  ];
  for (const source of sources) {
    try {
      for await (const file of logFiles(source.root, source.depth)) {
        try {
          const meta = await identity(file, source.provider);
          if (!meta) continue;
          const cwd = await canonical(meta.cwd);
          // Codex session_meta is the launch project. Claude may record a working subdirectory.
          if (source.provider === 'codex' ? cwd !== project : !within(project, cwd)) continue;
          const info = await stat(file);
          candidates.push({ ...meta, provider: source.provider, file, projectPath: project,
            updatedAt: info.mtimeMs, activity: 'unverified' });
        } catch { warnings.push(`${source.provider}: 无法核验一个会话的身份元数据（未读取正文）。`); }
      }
    } catch { warnings.push(`${source.provider}: 会话目录无法读取。`); }
  }
  return { candidates: candidates.sort((a, b) => b.updatedAt - a.updatedAt), warnings };
}

export async function loadSession(candidate: SessionCandidate): Promise<SessionData> {
  const handle = await open(candidate.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('会话来源不是普通日志文件。');
    // Revalidate a bounded identity prefix from this same handle BEFORE loading the body.
    const buffer = Buffer.alloc(Math.min(before.size, 131072));
    let offset = 0;
    const prefixSize = Math.min(buffer.length, 131072);
    while (offset < prefixSize) {
      const read = await handle.read(buffer, offset, prefixSize - offset, offset);
      if (!read.bytesRead) throw new Error('读取期间日志被截短；未提交此快照。');
      offset += read.bytesRead;
    }
    let meta: { id: string; cwd: string } | undefined;
    for (const line of buffer.subarray(0, offset).toString('utf8').split('\n').slice(0, 50)) {
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      const value = candidate.provider === 'codex' && record.type === 'session_meta' ? record.payload : record;
      const id = candidate.provider === 'codex' ? value?.id : value?.sessionId;
      if (candidate.provider === 'codex' && record.type === 'session_meta' && isCodexSubagent(value)) throw new Error('来源是明确标记的子 Agent 日志，不作为可选主会话加载。');
      if (typeof id === 'string' && typeof value.cwd === 'string') { meta = { id, cwd: value.cwd }; break; }
      if (candidate.provider === 'codex') break;
    }
    if (!meta || meta.id !== candidate.id) throw new Error('会话身份已变化；保留原选择，不自动替换。');
    const project = await canonical(candidate.projectPath);
    const cwd = await canonical(meta.cwd);
    if (candidate.provider === 'codex' ? cwd !== project : !within(project, cwd)) throw new Error('会话不再属于当前项目。');
    // Same verified handle, fixed initial byte range. Discard raw records after
    // normalization instead of retaining file buffer + text + parsed JSON copies.
    const parser = (candidate.provider === 'codex' ? createCodexParser : createClaudeParser)({ file: candidate.file, projectPath: project, sessionId: meta.id });
    parser.next();
    const stream = handle.createReadStream({ start: 0, end: before.size - 1, autoClose: false, encoding: 'utf8', highWaterMark: 64 * 1024 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let consumed = false;
    try {
      for await (const line of lines) parser.next(line);
      consumed = true;
    } finally {
      lines.close();
      // destroy() also closes the FileHandle even with autoClose:false. Keep
      // the same handle alive for the final identity/stability checks at EOF.
      if (!consumed) stream.destroy();
    }
    if (stream.bytesRead !== before.size) throw new Error('读取期间日志被截短；未提交此快照。');
    const parsed = parser.next(null);
    if (!parsed.done) throw new Error('会话解析未完成。');
    const result = parsed.value;
    if (result.id !== candidate.id) throw new Error('解析后的会话身份与候选不符。');
    const after = await handle.stat();
    const current = await stat(candidate.file);
    if (before.dev !== current.dev || before.ino !== current.ino) throw new Error('读取期间日志来源被替换；未提交此快照。');
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('读取期间日志有变化；未提交可能混合的快照，请刷新重试。');
    return await applySourceSessionTitle(candidate, result);
  } finally { await handle.close(); }
}

export async function applySourceSessionTitle(candidate: SessionCandidate, result: SessionData): Promise<SessionData> {
  if (candidate.provider === 'codex') {
    const defaultRoot = join(homedir(), '.codex', 'sessions');
    // Both lexical and canonical containment are needed: custom fixtures or
    // symlinked external logs must not consult the user's real account index.
    if (within(resolve(defaultRoot), resolve(candidate.file))) {
      const root = await realpath(defaultRoot).catch(() => undefined);
      const file = await realpath(candidate.file).catch(() => undefined);
      if (root && file && within(root, file)) return applyCodexSessionTitle(result);
    }
  }
  return result;
}
