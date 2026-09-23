import { setTimeout as yieldToHost } from 'node:timers/promises';
import { watch, type FSWatcher } from 'node:fs';
import { createCodexParser } from './codex';
import { createClaudeParser } from './claude';
import { SessionRecordCursor, SourceChangedError, type RecordBatch } from './record-stream';
import type { SessionParser } from './jsonl';
import type { SessionCandidate, SessionData } from './model';
import { applySourceSessionTitle } from './sessions';
import { claudeRunState, type AgentRunState } from './agent-status';

export interface ObservationHealth {
  state: 'observing' | 'paused';
  lastRecordAt?: string;
  pendingBytes: number;
  readBytes: number;
  reason?: 'source-changed' | 'read-failed';
  /** Whether the agent itself says it is working, where the harness publishes that (Claude Code). */
  agent?: AgentRunState;
}
export interface LiveUpdate { session: SessionData; health: ObservationHealth; contentChanged: boolean }
export interface LiveSession {
  readonly session: SessionData;
  readonly health: ObservationHealth;
  start(listener: (update: LiveUpdate) => void): void;
  poll(): Promise<void>;
  close(): Promise<void>;
}

/** A persistent adapter consumes each complete source row exactly once. Never fed EOF on idle. */
export async function openLiveSession(candidate: SessionCandidate, options: { pollMs?: number; signal?: AbortSignal } = {}): Promise<LiveSession> {
  const pollMs = options.pollMs ?? 500;
  if (!Number.isFinite(pollMs) || pollMs < 25) throw new Error('Invalid observation interval');
  const cursor = await SessionRecordCursor.open(candidate);
  const parser: SessionParser = (candidate.provider === 'codex' ? createCodexParser : createClaudeParser)({
    file: candidate.file, sessionId: candidate.id, projectPath: candidate.projectPath,
  });
  const session = parser.next().value;
  let health: ObservationHealth = { state: 'observing', readBytes: 0, pendingBytes: 0 };
  let closed = false;
  let listener: ((update: LiveUpdate) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let nudge: ReturnType<typeof setTimeout> | undefined;
  let serial: Promise<void> = Promise.resolve();
  const runState = candidate.provider === 'claude' ? claudeRunState(candidate.file, candidate.id) : undefined;
  let agent: AgentRunState | undefined;
  const apply = (batch: RecordBatch) => {
    for (const frame of batch.records) {
      const beforeCoverage = session.coverage.length;
      parser.next(frame.kind === 'json' ? { record: frame.value } : frame.kind === 'empty' ? '' : '{');
      if (frame.kind !== 'json' && frame.kind !== 'empty') {
        const reason = frame.kind === 'oversized' ? '此记录超过增量读取的单行预算，未展示正文。'
          : frame.kind === 'invalid-utf8' ? '此完整记录含无效 UTF-8，未展示正文。' : '此完整记录无法解析，未展示正文。';
        for (const entry of session.coverage.slice(beforeCoverage)) entry.reason = reason;
        session.warnings[session.warnings.length - 1] = `第 ${frame.line} 行：${reason}`;
      }
    }
    health = { state: 'observing', readBytes: batch.offset, pendingBytes: batch.pendingBytes,
      ...(batch.records.length ? { lastRecordAt: batch.observedAt } : health.lastRecordAt ? { lastRecordAt: health.lastRecordAt } : {}),
      ...(agent ? { agent } : {}) };
  };
  const close = async () => {
    if (closed) return;
    closed = true; clearTimeout(timer); clearTimeout(nudge); watcher?.close(); watcher = undefined; listener = undefined;
    options.signal?.removeEventListener('abort', onAbort);
    await serial;
    parser.return(session);
    await cursor.close();
  };
  const onAbort = () => { void close().catch(() => undefined); };
  try {
    // Keep UI responsive during initial history normalization. Stop at the
    // open-time boundary, not an endlessly moving tail of a busy transcript.
    let batch: RecordBatch;
    do {
      if (options.signal?.aborted) throw new Error('会话加载已取消。');
      batch = await cursor.read(); apply(batch);
      await yieldToHost(0);
    } while (batch.offset < cursor.initialSize);
    const named = await applySourceSessionTitle(candidate, session);
    session.title = named.title;
    agent = await runState?.().catch(() => undefined);
    if (agent) health = { ...health, agent };
    if (named.titleSource) session.titleSource = named.titleSource;
    if (options.signal?.aborted) throw new Error('会话加载已取消。');
  } catch (error) { await close(); throw error; }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const poll = () => {
    const work = serial.then(async () => {
      if (closed || health.state === 'paused') return;
      let changed = false;
      let notify = false;
      try {
        const beforePending = health.pendingBytes;
        // Bound a busy source's work per tick; do not block the extension loop.
        for (let i = 0; i < 4; i++) {
          const batch = await cursor.read();
          if (closed) return;
          apply(batch); changed ||= batch.records.length > 0;
          if (batch.caughtUp) break;
          await yieldToHost(0);
        }
        // An interrupt can end a turn without writing a record; the harness's own state still changes.
        const state = await runState?.().catch(() => undefined);
        if (closed) return;
        const agentChanged = state !== agent;
        agent = state;
        health = { ...health }; if (agent) health.agent = agent; else delete health.agent;
        notify = changed || beforePending !== health.pendingBytes || agentChanged;
      } catch (error) {
        if (closed) return;
        health = { ...health, state: 'paused', reason: error instanceof SourceChangedError ? 'source-changed' : 'read-failed' };
        clearTimeout(timer);
        await cursor.close().catch(() => undefined);
        notify = true;
      }
      // A consumer failure is not a source failure. Keep the cursor usable.
      if (!closed && notify) listener?.({ session, health: { ...health }, contentChanged: changed });
    });
    serial = work.catch(() => undefined);
    return work;
  };
  const schedule = () => {
    if (closed || health.state === 'paused' || !listener) return;
    timer = setTimeout(() => { void poll().catch(() => undefined).finally(schedule); }, pollMs);
    timer.unref();
  };
  // A write to the file reads it at once instead of waiting for the next tick.
  // Watching is best-effort (network or odd filesystems may never fire), so the
  // timed poll stays as the floor. Bursts of events collapse into one read.
  const watchSource = () => {
    try {
      watcher = watch(candidate.file, { persistent: false }, () => {
        if (closed || health.state === 'paused' || !listener || nudge) return;
        nudge = setTimeout(() => { nudge = undefined; void poll().catch(() => undefined); }, 30);
        nudge.unref();
      });
      watcher.on('error', () => { watcher?.close(); watcher = undefined; });
    } catch { watcher = undefined; }
  };
  return { session, get health() { return { ...health }; },
    start(next) { if (closed) return; listener = next; clearTimeout(timer); schedule(); if (!watcher) watchSource(); }, poll, close };
}
