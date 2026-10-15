import { lstat } from 'node:fs/promises';
import type { SessionCandidate, SessionData, TimelineItem } from './model';
import { loadSession, sessionKey } from './sessions';
import { t } from './i18n';

export interface SessionPickerEntry {
  key: string;
  title: string;
  shortId: string;
  providerLabel: string;
  updatedAt: number;
  /** This is the log file's update time, never an inferred conversation/activity time. */
  updatedLabel: string;
  latestText?: string;
  latestRole?: 'user' | 'assistant';
  metadataStatus: 'ready' | 'deferred' | 'unavailable';
  reason?: string;
}
export interface SessionPickerOptions {
  maxEagerSessions?: number;
  maxEagerBytes?: number;
  concurrency?: number;
}
export interface SessionPickerMetadata {
  base(candidate: SessionCandidate): SessionPickerEntry;
  /** Lazy reads retain loadSession's identity/project/snapshot safety checks. */
  read(candidate: SessionCandidate): Promise<SessionPickerEntry>;
  /** All candidates remain present, even when eager metadata exceeds the budget. */
  list(candidates: readonly SessionCandidate[]): Promise<SessionPickerEntry[]>;
}

/** Quick Pick interprets $(...) as icons. Log prose must remain plain text. */
function plainLabel(value: string, limit: number): string {
  const compact = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').replace(/\$\(/g, '＄(').trim();
  const points = [...compact.slice(0, limit * 2)];
  const result = points.slice(0, limit).join('');
  return result.length < compact.length ? `${result}…` : result;
}
const providerLabel = (candidate: SessionCandidate): string => candidate.provider === 'codex' ? 'Codex' : 'Claude Code';
function updatedLabel(value: number): string {
  return Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
    ? t(`updated ${new Date(value).toLocaleString('en-GB', { hour12: false })}`, `日志更新 ${new Date(value).toLocaleString('zh-CN', { hour12: false })}`) : t('update time unknown', '日志更新时间未知');
}
const bound = (value: number | undefined, fallback: number, maximum: number): number =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : fallback;

const publicBodyLabels = new Set([
  '正文', '用户请求', '用户请求或公开正文', '公开正文',
  '先前公开文本块', '后续公开文本块', '同一正文块的后续版本',
]);

/** Use only normalized public conversation, not a second parser over raw logs. */
function latestConversation(data: SessionData): Pick<SessionPickerEntry, 'latestText' | 'latestRole'> {
  const messages = data.items.filter(item => item.sessionId === data.id && ['request', 'message', 'answer'].includes(item.kind));
  // A later revision of an existing message keeps its array position. Its source
  // position, not the original insertion position, identifies the latest record.
  const lastSource = (item: TimelineItem): number => item.sources.reduce((last, source) => Math.max(last, source.line), 0);
  messages.sort((a, b) => lastSource(b) - lastSource(a));
  for (const item of messages) {
    const body = item.detail?.blocks.filter(block => block.kind === 'text' && publicBodyLabels.has(block.label) && block.text?.trim()).at(-1)?.text;
    const snippet = plainLabel(body || item.summary, 150);
    if (!snippet) continue;
    const latestRole = item.kind === 'request' ? 'user' : 'assistant';
    return { latestRole, latestText: `${latestRole === 'user' ? t('You', '用户') : 'Agent'}${t(': ', '：')}${snippet}` };
  }
  return {};
}

/** Create once per picker opening. Cache only bounded display metadata, never
 * parsed sessions or raw bodies; a fresh opening rechecks titles and sources.
 */
export function createSessionPickerMetadata(options: SessionPickerOptions = {}): SessionPickerMetadata {
  const maxSessions = bound(options.maxEagerSessions, 12, 100);
  const maxBytes = bound(options.maxEagerBytes, 32 * 1024 * 1024, 128 * 1024 * 1024);
  const concurrency = Math.max(1, bound(options.concurrency, 2, 4));
  const cache = new Map<string, Promise<SessionPickerEntry>>();
  const cacheKey = (candidate: SessionCandidate): string => JSON.stringify([
    candidate.provider, candidate.id, candidate.projectPath, candidate.file, candidate.updatedAt,
  ]);
  const base = (candidate: SessionCandidate): SessionPickerEntry => ({
    key: sessionKey(candidate), title: `${providerLabel(candidate)} · ${plainLabel(candidate.id, 8)}`,
    shortId: plainLabel(candidate.id.slice(0, 8), 8),
    providerLabel: providerLabel(candidate), updatedAt: candidate.updatedAt, updatedLabel: updatedLabel(candidate.updatedAt),
    metadataStatus: 'deferred', reason: t('the name and latest message are read once chosen', '选中后读取名称与最近对话'),
  });
  const read = (candidate: SessionCandidate): Promise<SessionPickerEntry> => {
    const key = cacheKey(candidate);
    const previous = cache.get(key);
    if (previous) return previous;
    const selected = { ...candidate };
    const pending = (async (): Promise<SessionPickerEntry> => {
      const fallback = base(selected);
      try {
        const before = await lstat(selected.file);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('Unsupported source');
        const data = await loadSession(selected);
        if (data.id !== selected.id || data.provider !== selected.provider) throw new Error('Mismatched identity');
        const after = await lstat(selected.file);
        if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Changed source');
        const latest = latestConversation(data);
        return { ...fallback, title: plainLabel(data.title, 120) || fallback.title,
          updatedAt: after.mtimeMs, updatedLabel: updatedLabel(after.mtimeMs), ...latest,
          metadataStatus: 'ready', reason: latest.latestText ? undefined : t('no readable message found', '未取得可读的公开对话正文') };
      } catch {
        // No path, record body, raw exception or inferred session identity enters
        // this fallback. Selecting later still revalidates through loadSession.
        return { ...fallback, metadataStatus: 'unavailable', reason: t('the session cannot be checked for now', '暂时无法核对会话内容') };
      }
    })();
    cache.set(key, pending);
    return pending;
  };
  const list = async (candidates: readonly SessionCandidate[]): Promise<SessionPickerEntry[]> => {
    const result = candidates.map(base);
    const jobs: Array<{ index: number; candidate: SessionCandidate }> = [];
    let reservedBytes = 0;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (cache.has(cacheKey(candidate))) { result[index] = await read(candidate); continue; }
      if (jobs.length >= maxSessions || reservedBytes >= maxBytes) continue;
      try {
        const info = await lstat(candidate.file);
        if (!info.isFile() || info.isSymbolicLink()) {
          result[index] = { ...result[index], metadataStatus: 'unavailable', reason: t('the session cannot be checked for now', '暂时无法核对会话内容') }; continue;
        }
        if (info.size > 64 * 1024 * 1024 || info.size > maxBytes - reservedBytes) continue;
        reservedBytes += info.size;
        jobs.push({ index, candidate });
      } catch { result[index] = { ...result[index], metadataStatus: 'unavailable', reason: t('the session cannot be checked for now', '暂时无法核对会话内容') }; }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        result[job.index] = await read(job.candidate);
      }
    }));
    return result;
  };
  return { base, read, list };
}
