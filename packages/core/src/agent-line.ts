import type { ChapterRow } from './chapters';
import type { SessionData, TimelineItem } from './model';
import { elapsed } from './turn-view';

/**
 * An Agent call, as both products set it (design v10): a dot whose colour is
 * the subagent's state, its description, and under it what the run came to.
 * A run of Agent calls whose descriptions share a lead ("Name brainstorm: …")
 * says the lead once, beside the tool's name.
 */
export type AgentState = 'running' | 'done' | 'failed' | 'stopped';

const agentOf = (row: ChapterRow): TimelineItem | undefined => row.items.find(item => item.kind === 'subagent');

export function agentState(row: ChapterRow): AgentState {
  const item = agentOf(row);
  if (!item) return 'done';
  if (item.backgroundTask?.state === 'stopped' || item.interrupted) return 'stopped';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'running' || (item.backgroundTask?.state === 'running')) return 'running';
  return 'done';
}

const tokens = (count: number): string => count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M tokens` : count >= 1000 ? `${(count / 1000).toFixed(1)}k tokens` : `${count} tokens`;

/**
 * What the run came to: in the background or not, how long, its tokens and its
 * calls. The notification's own figures when it has finished; while it runs,
 * the time since it started and the calls in its own record so far.
 */
export function agentFacts(row: ChapterRow, now: number, subagent?: SessionData): string {
  const item = agentOf(row);
  if (!item) return '';
  const usage = item.agentUsage;
  const started = item.timestamp ? Date.parse(item.timestamp) : NaN;
  const running = agentState(row) === 'running';
  const lastAt = subagent?.items.reduce((latest, entry) => Math.max(latest, entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0), 0) ?? 0;
  const duration = usage?.durationMs ?? (Number.isFinite(started) ? (running ? now : lastAt || NaN) - started : NaN);
  const calls = usage?.toolUses ?? (subagent ? subagent.items.filter(entry => ['tool', 'file-change', 'subagent', 'question'].includes(entry.kind)).length : undefined);
  return [
    item.backgroundTask ? '后台' : '',
    Number.isFinite(duration) && duration >= 0 ? elapsed(duration) : '',
    usage?.tokens !== undefined ? tokens(usage.tokens) : '',
    calls !== undefined ? `${calls} 次调用` : '',
  ].filter(Boolean).join(' · ');
}

/** A lead shared by every description, ended by one of these: said once. */
const SEPARATOR = /(.+?)(?::\s+|：\s*|\s+[-–—·]\s+)/;

export function agentGroup(labels: string[]): { lead?: string; names: string[] } {
  if (labels.length < 2) return { names: labels };
  const match = SEPARATOR.exec(labels[0]);
  if (!match) return { names: labels };
  const head = match[0];
  if (!labels.every(label => label.startsWith(head) && label.length > head.length)) return { names: labels };
  return { lead: match[1].trim(), names: labels.map(label => label.slice(head.length)) };
}
