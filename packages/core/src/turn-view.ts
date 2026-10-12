import type { Provider, SessionData, TimelineItem } from './model';
import type { TurnGroup } from './timeline';
import { chapterTurn, type ChapterRow, type ChapterTurn, type RowOutcome, type TurnSegment } from './chapters';
import { presentEvidence } from './presentation';
import { doneVerb, statusVerb } from './verbs';

/**
 * What each view says about a turn and its calls, before any markup. The VS
 * Code panel and the terminal pane both draw from here, so a word, a duration
 * or a fold boundary cannot drift between them.
 */

/** Text blocks an item shows as its own words. */
export const publicBodyLabels: ReadonlySet<string> = new Set(['正文', '公开正文', '用户请求', '用户请求或公开正文', '先前公开文本块', '后续公开文本块']);

export function publicBody(item: TimelineItem): string {
  return item.detail?.blocks.filter(block => block.kind === 'text' && publicBodyLabels.has(block.label)).map(block => block.text ?? '').join('\n\n') || item.summary || item.title;
}

/** Local wall-clock time of a source timestamp: 14:02. */
export const clock = (iso?: string): string => iso ? new Date(iso).toTimeString().slice(0, 5) : '';

/** A turn's length in one short unit: 12s, 3m, 1.5h. Under a second says nothing. */
export const duration = (ms?: number): string => ms === undefined || ms < 1000 ? '' : ms < 60000 ? Math.round(ms / 1000) + 's'
  : ms < 3600000 ? Math.round(ms / 60000) + 'm' : (ms / 3600000).toFixed(1) + 'h';

/** The agents' own long format: 12s, 1m 33s, 1h 2m 5s. */
export const elapsed = (ms: number): string => {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h}h ${m}m ${s % 60}s` : m ? `${m}m ${s % 60}s` : `${s}s`;
};

/** In the harness's own terms, as the call rows' machine voice: an exit code, a refusal, a stop. */
export function outcomeWord(outcome: RowOutcome): string {
  if (outcome.kind === 'denied') return outcome.denial === 'user-rejected' ? 'rejected' : 'denied';
  if (outcome.kind === 'interrupted') return 'interrupted';
  if (outcome.kind === 'failed') return outcome.exitCode !== undefined ? `exit ${outcome.exitCode}` : 'failed';
  return '';
}

export interface ChoiceView { header?: string; chosen: string[]; waiting: boolean }
export interface RowView {
  /** `OUT` for a wrapper's shared output, which is not a call of its own. */
  tool: string;
  label: string;
  /** The outcome word, empty when nothing went wrong. */
  word: string;
  /** Why the exit code means failure, for a tooltip. */
  reason: string;
  /** A search that matched nothing: not a failure. */
  empty: boolean;
  note?: string;
  count: number;
  /** Live and still out: no return yet, or running. */
  out: boolean;
  /** A question's answers; the header only when the call asked more than one. */
  choices?: ChoiceView[];
}

export function rowView(row: ChapterRow, live: boolean): RowView {
  // A shared output is a wrapper's transport record; its first line is rarely readable.
  const output = row.output ? presentEvidence(row.items[0]).outputs.map(block => block.text ?? '').join('\n') : '';
  return {
    tool: row.output ? 'OUT' : row.tool,
    label: row.output ? `返回内容 · ${output.split(/\r?\n/).length} 行` : row.label || '无记录参数',
    word: row.outcome ? outcomeWord(row.outcome) : '',
    reason: row.outcome?.reason ?? '',
    empty: row.outcome?.kind === 'empty',
    ...(row.note ? { note: row.note } : {}),
    count: row.count,
    out: live && (row.pending || row.running),
    ...(row.choices ? { choices: row.choices.map(choice => ({
      ...(row.choices!.length > 1 && choice.header ? { header: choice.header } : {}),
      chosen: choice.chosen,
      waiting: live && row.pending && !choice.chosen.length,
    })) } : {}),
  };
}

/** A tool name is written once per run of the same tool; this marks where each run starts. */
export const runStarts = (rows: ChapterRow[]): boolean[] =>
  rows.map((row, index) => index === 0 || rows[index - 1].tool !== row.tool || rows[index - 1].output !== row.output);

export interface TurnView {
  turn: ChapterTurn;
  /** 第 N 轮, or the group of records no turn claims. */
  label: string;
  /** The newest turn, not yet closed by the source, with records to time it by. */
  live: boolean;
  /** The process up to the agent's last step, and the closing answers after it. */
  process: TurnSegment[];
  answers: TurnSegment[];
  chapters: number;
  rows: ChapterRow[];
  calls: number;
  /** The line the agents print once a turn is done: "Crunched for 3m 12s", or "Process" with no duration. */
  done: string;
  /** The word the agent shows while it works this turn. */
  verb: string;
  /** Tool-name column width in characters, capped so one long name does not widen every row. */
  toolWidth: number;
}

/** `latest` marks the newest turn: only it can still be running. */
export function turnView(group: TurnGroup, latest: boolean, provider?: Provider): TurnView {
  const turn = chapterTurn(group);
  const live = latest && !turn.ended && Boolean(turn.lastAt);
  const rows = turn.segments.flatMap(segment => segment.kind === 'chapter' ? segment.chapter.rows : []);
  // Everything after the last non-answer segment is the turn's closing answer.
  const closing = turn.segments.length - [...turn.segments].reverse().findIndex(segment => segment.kind !== 'answer');
  const process = turn.segments.slice(0, closing > turn.segments.length ? 0 : closing);
  return {
    turn,
    label: group.turnId ? `第 ${group.ordinal} 轮` : '未归属回合的记录',
    live,
    process,
    answers: turn.segments.slice(process.length),
    chapters: turn.segments.filter(segment => segment.kind === 'chapter').length,
    rows,
    calls: rows.filter(row => !row.output).reduce((sum, row) => sum + row.count, 0),
    done: turn.durationMs ? `${doneVerb(provider, group.key)} for ${elapsed(turn.durationMs)}` : 'Process',
    verb: statusVerb(provider, group.key),
    toolWidth: Math.min(7, Math.max(3, ...rows.map(row => (row.output ? 'OUT' : row.tool).length))),
  };
}

/** Tasks the agent left running in the background that have not reported back, in a line; nothing when there are none. */
export function backgroundLine(session: SessionData): string | undefined {
  const count = session.items.filter(item => item.backgroundTask?.state === 'running').length;
  return count ? `${count} background task${count > 1 ? 's' : ''} running` : undefined;
}
