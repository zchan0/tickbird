import type { Provider, SessionData, TimelineItem } from '../../../core/src/model';
import type { TurnGroup } from '../../../core/src/timeline';
import type { ChapterRow, TurnSegment } from '../../../core/src/chapters';
import type { LiveExtras } from '../../../core/src/live-extras';
import { plainPasted } from '../../../core/src/pasted';
import { clock, publicBody, rowView, runStarts, turnView, type TurnView } from '../../../core/src/turn-view';
import { symbol, type Capabilities } from '../caps';
import { cutLine, row, type Line, type Span, type Style } from '../screen';
import { textWidth } from '../width';
import { prose } from './prose';

/**
 * One turn per screen: the request, the files it changed, the chapters in the
 * order they happened, and the turn's status at the end. Plain data in, styled
 * lines out; the app decides which turn and which part of it is on screen.
 */

export type SessionStatus =
  | { kind: 'running'; since?: string; verb: string }
  | { kind: 'waiting'; approval: { tool: string; summary: string } }
  | { kind: 'quiet'; lastAt?: string }
  | { kind: 'idle' }
  | { kind: 'ended' };

/** An open turn with no record for this long and no word from the agent is not shown as running. */
export const QUIET_MS = 10 * 60_000;

/**
 * What the session is doing now. The newest turn's records say whether it is
 * open; the agent's own state, where reported, says whether it still works.
 */
export function sessionStatus(latest: TurnView | undefined, extras: LiveExtras, now: number, agent?: { busy?: boolean; ended?: boolean }): SessionStatus {
  if (extras.approval) return { kind: 'waiting', approval: extras.approval };
  if (agent?.ended) return { kind: 'ended' };
  if (latest?.live) {
    const lastAt = latest.turn.lastAt ? Date.parse(latest.turn.lastAt) : NaN;
    if (agent?.busy || now - lastAt < QUIET_MS) return { kind: 'running', since: latest.turn.start ?? latest.turn.lastAt, verb: latest.verb };
    return { kind: 'quiet', lastAt: latest.turn.lastAt };
  }
  return { kind: 'idle' };
}

/** The agents' clock: 8s, 1m 05s, 1h 02m. */
export function runningClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}h ${two(m % 60)}m` : m ? `${m}m ${two(s % 60)}s` : `${s}s`;
}

export const providerName = (provider: Provider): string => provider === 'codex' ? 'Codex' : 'Claude Code';

const DIM: Style = { dim: true };
const YELLOW: Style = { fg: 'yellow' };

export interface PageContext {
  session: SessionData;
  groups: TurnGroup[];
  /** Index into `groups` of the turn on screen. */
  index: number;
  status: SessionStatus;
  extras: LiveExtras;
  caps: Pick<Capabilities, 'symbols'>;
  width: number;
  now: number;
}

/** The status on the right of the first line. */
function statusSpans(status: SessionStatus, ctx: PageContext): Span[] {
  const s = (ch: string) => symbol(ctx.caps, ch);
  if (status.kind === 'waiting') return [{ text: `${s('⏸')} 等你批准`, style: { ...YELLOW, bold: true } }];
  if (status.kind === 'running') {
    const since = status.since ? Date.parse(status.since) : NaN;
    return [{ text: s('●'), style: YELLOW }, { text: ' 运行中' }, ...(Number.isFinite(since) ? [{ text: ' ' + runningClock(ctx.now - since), style: DIM }] : [])];
  }
  if (status.kind === 'quiet') return [{ text: '无新记录', style: DIM }];
  if (status.kind === 'ended') return [{ text: '已退出', style: DIM }];
  return [{ text: '空闲', style: DIM }];
}

/** Two lines: who and which session, then which turn. */
export function headerLines(ctx: PageContext): Line[] {
  const { session, groups, index, width } = ctx;
  const group = groups[index];
  const narrow = width < 50;
  const status = statusSpans(ctx.status, ctx);
  const title = session.title && !narrow ? [{ text: ` · ${session.title}`, style: DIM }] : [];
  const first = row([{ text: ' ' }, { text: providerName(session.provider), style: { bold: true } }, ...title], [...status, { text: ' ' }], width);
  if (!group) return [first, row([{ text: ' 还没有记录', style: DIM }], '', width)];
  const view = turnView(group, index === groups.length - 1, session.provider);
  const ordinal = group.ordinal ?? index + 1;
  const total = groups.at(-1)?.ordinal ?? groups.length;
  const started = clock(view.turn.start);
  const finished = !view.live && view.turn.durationMs ? ` · ${runningClock(view.turn.durationMs)}` : '';
  const right = started ? `${started}${narrow ? '' : ' 开始'}${finished} ` : '';
  const left = group.turnId ? ` 第 ${ordinal} 轮 / 共 ${total}` : ' 未归属回合的记录';
  return [first, row([{ text: left, style: DIM }], [{ text: right, style: DIM }], width)];
}

const requestText = (item: TimelineItem | undefined, group: TurnGroup): string =>
  plainPasted(item ? publicBody(item) : group.request).trim() || '（未取得本轮请求）';

/** The request: a blue bar and bold text, every wrapped line under the bar. */
function requestLines(text: string, ctx: PageContext, bold = true): Line[] {
  const bar: Span = { text: ` ${symbol(ctx.caps, '┃')} `, style: { fg: 'blue' } };
  return prose(text, ctx.width - 1, { glyph: ch => symbol(ctx.caps, ch), indent: 3, style: bold ? { bold: true } : {} }).map(line => line.length ? [bar, ...line.slice(1)] : [bar]);
}

function changedLine(view: TurnView, ctx: PageContext): Line[] {
  const files = view.turn.files;
  if (!files.length) return [];
  const base = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) || path;
  const spans: Span[] = [{ text: '   ' }, { text: 'Changed', style: DIM }];
  let used = 10, shown = 0;
  for (const file of files) {
    const piece = `  ${file.mark} ${base(file.path)}`;
    const rest = files.length - shown - 1;
    // Keep room for the "+N" of the files that do not fit.
    if (used + textWidth(piece) + (rest ? 4 : 0) > ctx.width - 1) break;
    spans.push({ text: '  ' }, { text: file.mark, style: file.mark === 'A' ? { fg: 'green' } : file.mark === 'D' ? { fg: 'red' } : DIM }, { text: ' ' + base(file.path) });
    used += textWidth(piece); shown++;
  }
  if (shown < files.length) spans.push({ text: `  +${files.length - shown}`, style: DIM });
  return [cutLine(spans, ctx.width)];
}

/** One call row: indented under its chapter, the tool name once per run, the outcome on the right. */
function callLines(rows: ChapterRow[], view: TurnView, ctx: PageContext, waitingOn: boolean): Line[] {
  const toolWidth = ctx.width < 50 ? Math.min(5, view.toolWidth) : view.toolWidth;
  const leads = runStarts(rows);
  const lines: Line[] = [];
  rows.forEach((chapterRow, index) => {
    const call = rowView(chapterRow, view.live || waitingOn);
    const tool = leads[index] ? (call.tool.length > toolWidth ? call.tool.slice(0, toolWidth) : call.tool.padEnd(toolWidth)) : ' '.repeat(toolWidth);
    const label = call.label.replace(/\s+/g, ' ') + (call.count > 1 ? ` · ${call.count} 次` : '');
    const isLast = index === rows.length - 1;
    const right: Span[] = call.word ? [{ text: call.word, style: { fg: 'red' } }]
      : call.empty ? [{ text: 'no match', style: DIM }]
      : call.note ? [{ text: call.note, style: DIM }]
      : call.out ? [{ text: waitingOn && isLast ? '?' : symbol(ctx.caps, '…'), style: YELLOW }]
      : [];
    lines.push(row([{ text: '     ' }, { text: tool, style: DIM }, { text: '  ' }, { text: label }], right.length ? [...right, { text: ' ' }] : '', ctx.width));
    for (const choice of call.choices ?? []) {
      const chosen = choice.chosen.length ? choice.chosen.map(value => `${symbol(ctx.caps, '✓')} ${value}`).join('  ') : choice.waiting ? '等待你的选择' : '';
      if (chosen) lines.push(cutLine([{ text: ' '.repeat(7 + toolWidth) }, ...(choice.header ? [{ text: choice.header + '  ', style: DIM }] : []), { text: chosen, style: choice.chosen.length ? { bold: true } : DIM }], ctx.width));
    }
  });
  return lines;
}

function segmentLines(segment: TurnSegment, view: TurnView, ctx: PageContext, waitingOn: boolean): Line[] {
  if (segment.kind === 'answer') return prose(publicBody(segment.item), ctx.width - 1, { glyph: ch => symbol(ctx.caps, ch), indent: 3 });
  if (segment.kind === 'interjection') return [[{ text: '   你的消息', style: DIM }], ...requestLines(publicBody(segment.item), ctx, false)];
  const { chapter } = segment;
  const lines: Line[] = [];
  chapter.headings.forEach((heading, index) => {
    const failed = heading.status === 'failed';
    const dot: Span = { text: ` ${symbol(ctx.caps, '●')} `, style: failed ? { fg: 'red' } : DIM };
    if (index) lines.push([]);
    lines.push(...prose(publicBody(heading), ctx.width - 1, { glyph: ch => symbol(ctx.caps, ch), indent: 3, lead: [dot] }));
  });
  lines.push(...callLines(chapter.rows, view, ctx, waitingOn));
  return lines;
}

/** The end of the turn: what it is doing now, or the line the agents print when done. */
function tailLines(view: TurnView, latest: boolean, ctx: PageContext): Line[] {
  const s = (ch: string) => symbol(ctx.caps, ch);
  const status = ctx.status;
  if (latest && status.kind === 'waiting') {
    const what = [status.approval.tool, /^\/.+\/[^/]+$/.test(status.approval.summary) ? status.approval.summary.split('/').at(-1)! : status.approval.summary].filter(Boolean);
    const bar: Span = { text: ` ${s('▌')} `, style: YELLOW };
    return [
      cutLine([bar, { text: '等你批准', style: { ...YELLOW, bold: true } }, ...(what.length ? [{ text: '  ' + what[0], style: DIM }, ...(what[1] ? [{ text: ' · ' + what[1].replace(/\s+/g, ' ') }] : [])] : [])], ctx.width),
      cutLine([bar, { text: `在 ${providerName(ctx.session.provider)} 里选择批准或拒绝。`, style: DIM }], ctx.width),
    ];
  }
  if (latest && status.kind === 'running') {
    const since = status.since ? Date.parse(status.since) : NaN;
    return [[{ text: ` ${s('●')} ${status.verb}`, style: YELLOW }, ...(Number.isFinite(since) ? [{ text: ' ' + runningClock(ctx.now - since), style: DIM }] : [])]];
  }
  if (view.live && latest) return [[{ text: ` 无新记录${status.kind === 'quiet' && status.lastAt ? ` · 最后一条 ${clock(status.lastAt)}` : ''}`, style: DIM }]];
  const calls = view.calls ? ` · ${view.calls} ${view.calls === 1 ? 'call' : 'calls'}` : '';
  if (view.turn.aborted) return [[{ text: ` 中断${calls}`, style: DIM }]];
  if (!view.turn.segments.length) return [];
  return [[{ text: ` ${s('✻')} ${view.done}${calls}`, style: DIM }]];
}

/** The whole turn, top to bottom. Blocks are one blank line apart; a chapter's calls stay together. */
export function turnBody(ctx: PageContext): Line[] {
  const group = ctx.groups[ctx.index];
  if (!group) return [[{ text: '   这个会话还没有可显示的记录。', style: DIM }]];
  const latest = ctx.index === ctx.groups.length - 1;
  const view = turnView(group, latest, ctx.session.provider);
  const waitingOn = latest && ctx.status.kind === 'waiting';
  const blocks: Line[][] = [requestLines(requestText(view.turn.request, group), ctx)];
  const changed = changedLine(view, ctx);
  if (changed.length) blocks.push(changed);
  for (const segment of view.turn.segments) blocks.push(segmentLines(segment, view, ctx, waitingOn));
  // On screen in the agent, not yet in the transcript: faint until the record arrives.
  if (latest && ctx.extras.draft && (ctx.status.kind === 'running' || ctx.status.kind === 'waiting')) {
    blocks.push(prose(ctx.extras.draft, ctx.width - 1, { glyph: ch => symbol(ctx.caps, ch), indent: 3, style: { dim: true, italic: true } }));
  }
  const tail = tailLines(view, latest, ctx);
  if (tail.length) blocks.push(tail);
  return blocks.filter(block => block.length).flatMap((block, index) => index ? [[], ...block] : block);
}
