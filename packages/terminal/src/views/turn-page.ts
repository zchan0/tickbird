import type { Provider, SessionData, TimelineItem } from '../../../core/src/model';
import type { TurnGroup } from '../../../core/src/timeline';
import type { ChapterRow, TurnSegment } from '../../../core/src/chapters';
import type { LiveExtras } from '../../../core/src/live-extras';
import { plainPasted } from '../../../core/src/pasted';
import { clock, publicBody, rowView, turnView, type TurnView } from '../../../core/src/turn-view';
import { symbol, type Capabilities } from '../caps';
import { cutLine, plainText, row, spans, type Color, type Line, type Span, type Style } from '../screen';
import { textWidth } from '../width';
import { inlineSpans, prose, wrapSpans } from './prose';
import { shortFileLabels } from '../../../core/src/presentation';
import { commandText } from '../../../core/src/command-line';
import { announcedRow, callEnd as endOf, callSteps, callText as wordsOf, callTool } from '../../../core/src/call-line';
import { spinnerAt, type Motion } from '../motion';

export { commandText };

/**
 * One turn per screen, to read beside the agent: the request as the page's
 * title, the agent's words in the body colour with the calls they explain on
 * a band under them, as a tree under each tool's name, and how the turn ended
 * after a label in a block of colour. Nothing here is drawn the way the
 * agents draw their own transcript. Plain data in, styled lines out; the app
 * decides which turn and which part of it is on screen.
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
 * open; the agent's own state, where reported, says whether it still works,
 * and whether it still waits on you: an approved command that runs for a while
 * writes nothing until it ends, but the agent is no longer waiting.
 */
export function sessionStatus(latest: TurnView | undefined, extras: LiveExtras, now: number, agent?: { busy?: boolean; ended?: boolean; state?: 'busy' | 'idle' | 'waiting' }): SessionStatus {
  if (extras.approval && (!agent?.state || agent.state === 'waiting')) return { kind: 'waiting', approval: extras.approval };
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


/**
 * A turn's view, kept per group: the controller hands in the same groups until
 * the transcript changes, and the header, the page and 目录 all ask for it.
 */
const VIEWS = new WeakMap<TurnGroup, Map<string, TurnView>>();
export function viewOf(group: TurnGroup, latest: boolean, provider: Provider): TurnView {
  let kept = VIEWS.get(group);
  if (!kept) VIEWS.set(group, kept = new Map());
  const key = `${latest}:${provider}`;
  let view = kept.get(key);
  if (!view) kept.set(key, view = turnView(group, latest, provider));
  return view;
}

const DIM: Style = { dim: true };
/** The running mark's dark gold, apart from the yellow of a selected line; the palette's yellow where exact colour is unknown. */
const GOLD = [201, 164, 92] as const;
const gold = (ctx: PageContext): Style => ({ fg: 'yellow', ...(ctx.caps.background ? { fgRgb: GOLD } : {}) });
const YELLOW: Style = { fg: 'yellow' };

export interface PageContext {
  session: SessionData;
  groups: TurnGroup[];
  /** Index into `groups` of the turn on screen. */
  index: number;
  status: SessionStatus;
  extras: LiveExtras;
  caps: Pick<Capabilities, 'symbols' | 'background'>;
  width: number;
  now: number;
  /** The closing answer is opened in full. */
  answerOpen?: boolean;
  /** The turn's changes are listed a file a line. */
  changesOpen?: boolean;
  /** What is new on the page and how far it has come in; without it, everything is simply there. */
  motion?: Motion;
}

/**
 * Spans are known by their style object: cutting, wrapping and laying a line
 * on the band copy spans but keep their style, so what a span belongs to
 * survives every step from here to the screen.
 */
const OWNER = new WeakMap<Style, string>();
const CHIP = new WeakSet<Style>();
const owned = (style: Style, id: string): Style => { const own = { ...style }; OWNER.set(own, id); return own; };

/**
 * A label's word: Prompt, Final Answer, Needs approval, Interrupted, New
 * turn. Bold in its colour and nothing behind it, the same for every label: a
 * block of colour presses on the line below it.
 */
export function label(text: string, fg: Color): Span {
  const style: Style = { fg, bold: true };
  CHIP.add(style);
  return { text, style };
}

/** What the session is doing, on the right of the header; nothing while it runs or after it is done. */
function statusSpans(status: SessionStatus): Span[] {
  if (status.kind === 'waiting') return [label('Needs approval', 'yellow')];
  if (status.kind === 'quiet') return [{ text: '无新记录', style: DIM }];
  if (status.kind === 'ended') return [{ text: '已退出', style: DIM }];
  return [];
}

/**
 * One line: which turn and when it started, then the session's state, or
 * `aside` (what the app has to say: following paused, where the keys are).
 */
export function headerLines(ctx: PageContext, aside: Span[] = []): Line[] {
  const { session, groups, index, width } = ctx;
  const group = groups[index];
  const narrow = width < 50;
  const status = statusSpans(ctx.status);
  const right: Span[] = status.length ? [...status, { text: ' ' }] : aside.length ? [...aside, { text: ' ' }] : [];
  if (!group) return [row([{ text: ' '.repeat(MARGIN) + '还没有记录', style: DIM }], right, width)];
  const ordinal = group.ordinal ?? index + 1;
  const total = groups.at(-1)?.ordinal ?? groups.length;
  const started = clock(viewOf(group, index === groups.length - 1, session.provider).turn.start);
  const left: Span[] = group.turnId
    ? [{ text: ' '.repeat(MARGIN) }, { text: `第 ${ordinal} 轮`, style: { bold: true } }, { text: ` / 共 ${total} 轮${started ? ` · ${started}${narrow ? '' : ' 开始'}` : ''}`, style: DIM }]
    : [{ text: ' 未归属回合的记录', style: DIM }];
  return [row(left, right, width)];
}

const requestText = (item: TimelineItem | undefined, group: TurnGroup): string =>
  plainPasted(item ? publicBody(item) : group.request).trim() || '（未取得本轮请求）';

/**
 * Every word on the page starts in this column: the header, the labels' words,
 * the prompt, the agent's words, the tools, the answer. The prompt's bar and a
 * label's wash stand to its left; only a call's words are set further in,
 * hanging from the tree.
 */
export const MARGIN = 2;

/**
 * The label over a block of words, Prompt or Final Answer: a coloured word on
 * a line of its own, the words right under it. No wash behind it: a block of
 * colour presses on the line below, and a blank line between is too much.
 */
function heading(text: string, fg: Color): Span[] {
  return [{ text: ' '.repeat(MARGIN) }, label(text, fg)];
}

/**
 * What you asked, whole, under a Prompt label, a blue bar down its side: set
 * apart from the agent's words without a rule across the page. Your words
 * sent during the turn are set the same way.
 */
function promptLines(text: string, ctx: PageContext): Line[] {
  // The bar in the first column, the words in the page's column.
  const bar: Span[] = [{ text: symbol(ctx.caps, '┃'), style: { fg: 'blue' } }, { text: ' '.repeat(MARGIN - 1) }];
  // Typed, not written as a document: each line as it was typed, wrapped beside the bar, no list indents.
  const room = Math.max(8, ctx.width - MARGIN - 1);
  const words = text.replace(/\r/g, '').split('\n').flatMap(source => source.trim() ? wrapSpans(inlineSpans(source.trimEnd()), room).map(line => [...bar, ...spans(line)]) : [bar.slice(0, 1)]);
  return [heading('Prompt', 'blue'), ...words];
}


/**
 * The files the turn changed, after its answer, under a Changes label: folded,
 * how many and the lines changed in all ("等" when some files have no
 * counts, being known only from a script's fragment); opened, a line each,
 * its mark, its name and its lines, each opening the file's latest change.
 */
function changesLines(view: TurnView, ctx: PageContext): Line[] {
  const files = view.turn.files;
  if (!files.length) return [];
  const lead: Span = { text: ' '.repeat(MARGIN) };
  const head = heading('Changes', 'default');
  CHANGES.add(head);
  const sizes = (added?: number, removed?: number): Span[] => [
    ...(added ? [{ text: `+${added}`, style: { fg: 'green' } as Style }] : []), ...(added && removed ? [{ text: ' ' }] : []),
    ...(removed ? [{ text: `-${removed}`, style: { fg: 'red' } as Style }] : []),
  ];
  const open: Span = { text: ' ' + symbol(ctx.caps, '▾'), style: { dim: true, bold: true } };
  if (!ctx.changesOpen) {
    const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0), removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
    const partial = files.some(file => file.added === undefined) && files.some(file => file.added !== undefined);
    const line = cutLine([lead, { text: `${files.length} 个文件` }, ...(added || removed ? [{ text: '  ' }, ...sizes(added, removed)] : []), ...(partial ? [{ text: ' 等', style: DIM }] : []), open], ctx.width);
    CHANGES.add(line);
    return [head, line];
  }
  const names = shortFileLabels(files.map(file => file.path));
  const lines: Line[] = [head];
  files.forEach((file, index) => {
    const size = sizes(file.added, file.removed);
    const room = ctx.width - MARGIN - 2 - textWidth(plainText(size)) - 2;
    const name = textWidth(names[index]) > room ? cutLine([{ text: names[index] }], room)[0] : { text: names[index] };
    const gap = Math.max(1, ctx.width - 1 - MARGIN - 2 - textWidth(plainText([name])) - textWidth(plainText(size)));
    const row = view.rows.find(candidate => candidate.id === file.id);
    const line: Span[] = [lead, { text: file.mark, style: file.mark === 'A' ? { fg: 'green' } : file.mark === 'D' ? { fg: 'red' } : DIM }, { text: ' ' },
      { ...name, ...(row ? { style: owned({}, row.id) } : {}) }, { text: ' '.repeat(gap) }, ...size];
    if (row?.openable) TARGETS.set(line as object, [{ row, height: 1 }]);
    lines.push(line);
  });
  return lines;
}

/**
 * The band behind a run of calls: the terminal's own background moved a
 * little toward its text. Unknown background, no band.
 */
export function bandColor(background: Capabilities['background']): readonly [number, number, number] | undefined {
  if (!background) return undefined;
  const { r, g, b, dark } = background;
  const mix = (c: number) => Math.round(dark ? c + (255 - c) * 0.07 : c * 0.95);
  return [mix(r), mix(g), mix(b)];
}

/** Lines laid on the band, each filled to the full width. */
function band(lines: Line[], width: number, tint: readonly [number, number, number] | undefined): Line[] {
  if (!tint) return lines;
  return lines.map(line => {
    const laid = spans(line).map(span => {
      const style: Style = { ...span.style, bgRgb: tint };
      const owner = span.style && OWNER.get(span.style);
      if (owner !== undefined) OWNER.set(style, owner);
      return { ...span, style };
    });
    const used = textWidth(plainText(laid));
    return used < width ? [...laid, { text: ' '.repeat(width - used), style: { bgRgb: tint } }] : laid;
  });
}

/** A call's words wrap to at most this many lines: enough to read a step at a glance. */
export const CALL_LINES = 2;

interface LineTarget { row: ChapterRow; height: number; from?: number; to?: number }
/** The calls a line starts. */
const TARGETS = new WeakMap<object, LineTarget[]>();
/** The closing answer's first line, with how many lines a click on it takes. */
const ANSWER = new WeakMap<object, number>();
/** The Changes label and its folded line: a click on either opens or folds the list. */
const CHANGES = new WeakSet<object>();

/** What shows on the right of a call: a failure in red, a call still out, the size of a change. */
function callEnd(chapterRow: ChapterRow, ctx: PageContext, live: boolean): Span[] {
  const end = endOf(chapterRow, ctx.session, live);
  if (!end) return [];
  if (end.kind === 'failed') return [{ text: end.word, style: { fg: 'red' } }];
  if (end.kind === 'empty') return [{ text: 'no match', style: DIM }];
  if (end.kind === 'note') return [{ text: end.text, style: DIM }];
  return [...(end.added ? [{ text: `+${end.added}`, style: { fg: 'green' } as Style }] : []), ...(end.added && end.removed ? [{ text: ' ' }] : []), ...(end.removed ? [{ text: `-${end.removed}`, style: { fg: 'red' } as Style }] : [])];
}

/** A run's tool name, on a line of its own above its calls. */
const TOOL: Style = { bold: true };

/** `line` cut to `room` cells with `tail` after it; the text gives way, the tail stays whole. */
function withTail(line: Span[], tail: Span[], room: number): Span[] {
  const need = textWidth(plainText(tail));
  return [...cutLine(line, Math.max(1, room - need)), ...tail];
}

/**
 * A step's calls on a band, under the words that explain them, as a tree: the
 * tool's name on a line of its own, once for a run of one tool, and each call
 * of the run hung from it on ├, the last on └. A call's second line goes on
 * under │, so it never reads as the next call. Every call is shown: the reader
 * is here for the process. The tool's name is bold in the body colour, to see
 * at a glance what the agent used; what each call worked on reads in grey,
 * all alike. A command keeps to one line, what it runs after counted. Colour
 * marks what needs it: a failure, a call still out, a change's size.
 */
function callLines(all: ChapterRow[], view: TurnView, ctx: PageContext, waitingOn: boolean): Line[] {
  // Calls that arrive together come in one after another. The key is what the line says, the same for the
  // hook's early copy and the transcript's record; a repeat of the same line is told apart by its count.
  const said = new Map<string, number>();
  const rows = callSteps(all).filter(chapterRow => {
    if (!ctx.motion) return true;
    const key = `c:${callTool(chapterRow, ctx.session)}\u0000${wordsOf(chapterRow, ctx.session).text}`;
    const count = said.get(key) ?? 0;
    said.set(key, count + 1);
    return ctx.motion.shows(`${key}\u0000${count}`);
  });
  const tint = bandColor(ctx.caps.background);
  const live = view.live || waitingOn;
  const names = rows.map(chapterRow => callTool(chapterRow, ctx.session));
  const lead = ' '.repeat(MARGIN);
  // As much room on the right as on the left.
  const room = Math.max(8, ctx.width - MARGIN - 2 - MARGIN);
  const lines: Line[] = [];
  const push = (line: Span[], targets: LineTarget[]) => {
    const laid = band([line], ctx.width, tint)[0];
    if (targets.length) TARGETS.set(laid as object, targets);
    lines.push(laid);
  };
  // A line of the band's own above and below: room around the block, where there is a band to show it.
  if (rows.length && tint) push([], []);
  for (let at = 0; at < rows.length;) {
    let last = at;
    while (last + 1 < rows.length && names[last + 1] === names[at]) last++;
    const run = rows.slice(at, last + 1);
    push([{ text: lead }, { text: names[at], style: TOOL }], []);
    run.forEach((chapterRow, index) => {
      const end = index === run.length - 1;
      // A call waiting on you shows ? in its tree cell. One still running is drawn as any other: the spinner is the turn's, at its end.
      const asking = waitingOn && chapterRow === rows.at(-1) && rowView(chapterRow, live).out;
      const branch: Span[] = asking
        ? [{ text: lead }, { text: '?', style: gold(ctx) }, { text: ' ' }]
        : [{ text: lead + symbol(ctx.caps, end ? '└' : '├') + ' ', style: DIM }];
      const through: Span = { text: lead + (end ? ' ' : symbol(ctx.caps, '│')) + ' ', style: DIM };
      const shown = wordsOf(chapterRow, ctx.session);
      // The tool's name stands out; what the call worked on reads a step back, in grey.
      const style = owned(DIM, chapterRow.id);
      const label = shown.text + (chapterRow.count > 1 ? ` · ${chapterRow.count} 次` : '');
      const outcome = callEnd(chapterRow, ctx, live);
      const tail: Span[] = [...(shown.more ? [{ text: ` +${shown.more}`, style: owned({ dim: true, bold: true }, chapterRow.id) }] : []), ...(outcome.length ? [{ text: ' ' }, ...outcome] : [])];
      let wrapped: Span[][];
      if (shown.command) wrapped = [withTail([{ text: label, style }], tail, room)];
      else {
        const parts = wrapSpans([{ text: label, style }], room);
        if (parts.length > CALL_LINES) parts.splice(CALL_LINES - 1, Infinity, [...cutLine([{ text: parts.slice(CALL_LINES - 1).map(plainText).join(' ') + '  ', style }], room)]);
        const lastPart = parts.length - 1;
        parts[lastPart] = textWidth(plainText(parts[lastPart]) + plainText(tail)) <= room ? [...parts[lastPart], ...tail] : withTail(parts[lastPart], tail, room);
        wrapped = parts;
      }
      wrapped.forEach((part, piece) => push([...(piece ? [through] : branch), ...part], piece === 0 && chapterRow.openable ? [{ row: chapterRow, height: wrapped.length }] : []));
      for (const choice of rowView(chapterRow, live).choices ?? []) {
        const chosen = choice.chosen.length ? choice.chosen.map(value => `${symbol(ctx.caps, '✓')} ${value}`).join('  ') : choice.waiting ? '等待你的选择' : '';
        if (chosen) push(cutLine([through, ...(choice.header ? [{ text: choice.header + '  ', style: DIM }] : []), { text: chosen, style: choice.chosen.length ? { bold: true } : DIM }], ctx.width), []);
      }
    });
    at = last + 1;
  }
  if (rows.length && tint) push([], []);
  return lines;
}

/** Puts `lead` over the blank cells a line starts with. */
function withLead(line: Line, lead: Span[]): Span[] {
  let cut = textWidth(plainText(lead));
  const rest: Span[] = [];
  for (const span of spans(line)) {
    if (cut > 0 && !span.text.trim()) {
      const take = Math.min(cut, span.text.length);
      cut -= take;
      if (span.text.length > take) rest.push({ ...span, text: span.text.slice(take) });
      continue;
    }
    rest.push(span);
  }
  return [...lead, ...rest];
}

/** The agent's words, in the body colour: they say why the calls under them ran. */
const wordLines = (source: string, ctx: PageContext, style: Style = {}, indent = MARGIN): Span[][] => {
  const lines = prose(source, ctx.width - 1, { glyph: ch => symbol(ctx.caps, ch), indent, style });
  if (!ctx.motion) return lines;
  // New words type out: laid out whole first, so a word never jumps to the next line as it is typed.
  // The key is the words' own start, the same for the hook's early copy and the transcript's record.
  const total = lines.reduce((sum, line) => sum + [...plainText(line).trimStart()].length, 0);
  let left = ctx.motion.reveal('w:' + source.replace(/\s+/g, ' ').trim().slice(0, 80), total);
  if (left >= total) return lines;
  const shown: Span[][] = [];
  for (const line of lines) {
    if (left <= 0) break;
    const out: Span[] = [];
    let leading = true;
    for (const span of line) {
      // A line's indent is not typed: it is the column the words start in.
      if (leading && !span.text.trim()) { out.push(span); continue; }
      leading = false;
      const chars = [...span.text];
      if (chars.length <= left) { out.push(span); left -= chars.length; continue; }
      if (left > 0) out.push({ ...span, text: chars.slice(0, left).join('') });
      left = 0;
      break;
    }
    shown.push(out);
  }
  return shown;
};

/** A segment as blocks, one blank line apart: the agent's words, then the band of its calls. */
function segmentBlocks(segment: TurnSegment, view: TurnView, ctx: PageContext, waitingOn: boolean): Line[][] {
  if (segment.kind === 'answer') return [wordLines(publicBody(segment.item), ctx)];
  if (segment.kind === 'interjection') {
    // Your own words sent during the turn: a prompt too.
    return [promptLines(publicBody(segment.item), ctx)];
  }
  const { chapter } = segment;
  // The words, then the calls they explain, a blank line between: the calls are a block of their own.
  const words = chapter.headings.map(heading => wordLines(publicBody(heading), ctx)).filter(lines => lines.length);
  const calls = callLines(chapter.rows, view, ctx, waitingOn);
  return calls.length ? [...words, calls] : words;
}

/** The answer that closed the turn: its label and its first line, the whole of it when opened. */
function answerLines(view: TurnView, ctx: PageContext): Line[] {
  const text = view.answers.map(segment => segment.kind === 'answer' ? publicBody(segment.item) : '').filter(Boolean).join('\n\n');
  const lead: Span[] = [{ text: ' '.repeat(MARGIN) }];
  if (!text) return view.turn.aborted ? [heading('Interrupted', 'red')] : [];
  // As the prompt is: the label over the answer; folded, one full line of it and a ▾ to open it.
  const head = heading('Final Answer', 'green');
  if (ctx.answerOpen) {
    ANSWER.set(head, 1);
    return [head, ...wordLines(text, ctx)];
  }
  // Its opening lines run together, marks of headings and lists dropped, so the line is full.
  const flat = text.split(/\n/).map(line => line.trim().replace(/^#+\s*|^[-*]\s+|^\d+\.\s+|^>\s*/, '')).filter(Boolean).join(' ');
  const open: Span = { text: ' ' + symbol(ctx.caps, '▾'), style: { dim: true, bold: true } };
  ANSWER.set(head, 2);
  return [head, [...cutLine([...lead, ...inlineSpans(flat)], ctx.width - 2 - MARGIN), open]];
}

/** Set while a page is drawn: a call on it turns. */
/**
 * The end of the turn: waiting on you, no word for a while, or the answer it
 * closed with. While it runs, a call out or the agent working out its next
 * step, the one spinner turns here, where the answer will come.
 */
function tailLines(view: TurnView, latest: boolean, ctx: PageContext): Line[] {
  const status = ctx.status;
  const lead: Span = { text: ' '.repeat(MARGIN) };
  if (latest && status.kind === 'waiting') {
    const what = [status.approval.tool, /^\/.+\/[^/]+$/.test(status.approval.summary) ? status.approval.summary.split('/').at(-1)! : status.approval.summary].filter(Boolean);
    // As Final Answer is: the label on its own line, what it asks about under it.
    return [
      heading('Needs approval', 'yellow'),
      ...(what.length ? [cutLine([lead, { text: what[0], style: { bold: true } }, ...(what[1] ? [{ text: ' · ' + what[1].replace(/\s+/g, ' ') }] : [])], ctx.width)] : []),
      cutLine([lead, { text: `在 ${providerName(ctx.session.provider)} 里选择批准或拒绝。`, style: DIM }], ctx.width),
    ];
  }
  if (latest && status.kind === 'running') {
    ctx.motion?.turning();
    return [[lead, { text: symbol(ctx.caps, spinnerAt(ctx.now)), style: gold(ctx) }]];
  }
  if (view.live && latest) return [[lead, { text: `无新记录${status.kind === 'quiet' && status.lastAt ? ` · 最后一条 ${clock(status.lastAt)}` : ''}`, style: DIM }]];
  if (!view.turn.segments.length) return [];
  return answerLines(view, ctx);
}

/**
 * Marks the call or the answer under the cursor or the pointer as a link is
 * marked: golden yellow and underlined, every line of it at once. `owner` is
 * the call's id; without one the line is the answer's, and all its words are.
 */
export function markSelected(line: Line, owner?: string): Line {
  return spans(line).map(span => {
    const style = span.style;
    const mine = owner !== undefined ? Boolean(style && OWNER.get(style) === owner) : Boolean(span.text.trim()) && !(style && CHIP.has(style));
    return mine ? { ...span, style: { ...style, ...YELLOW, dim: false, underline: true } } : span;
  });
}

/** A call or the answer on the page: its first line, how many lines it takes, and its cells when it shares the line. */
export interface CallTarget { line: number; height: number; row?: ChapterRow; answer?: boolean; changes?: boolean; from?: number; to?: number }

/** The page and where each call row and the answer are on it, for selecting and opening them. */
export function turnLayout(ctx: PageContext): { lines: Line[]; targets: CallTarget[] } {
  const lines = turnBody(ctx);
  const targets: CallTarget[] = [];
  lines.forEach((line, index) => {
    if (typeof line !== 'object') return;
    for (const target of TARGETS.get(line) ?? []) targets.push({ line: index, ...target });
    const answer = ANSWER.get(line);
    if (answer) targets.push({ line: index, height: answer, answer: true });
    // The label and the folded line are one target: whichever is clicked opens the list.
    if (CHANGES.has(line) && !targets.at(-1)?.changes) targets.push({ line: index, height: ctx.changesOpen ? 1 : 2, changes: true });
  });
  return { lines, targets };
}

/**
 * The whole turn, top to bottom: the request as the title and what it
 * changed, then the agent's words with the calls each explains on a band
 * under them, then how the turn ended. Blocks are one blank line apart.
 */
export function turnBody(ctx: PageContext): Line[] {
  const group = ctx.groups[ctx.index];
  if (!group) return [[{ text: ' 这个会话还没有可显示的记录。', style: DIM }]];
  const latest = ctx.index === ctx.groups.length - 1;
  const view = viewOf(group, latest, ctx.session.provider);
  const waitingOn = latest && ctx.status.kind === 'waiting';
  const going = latest && (ctx.status.kind === 'running' || waitingOn);
  // Only the newest turn, while it runs, moves; anything else drawn is simply there, now and later.
  const motion = ctx.motion;
  if (motion) {
    motion.begin(ctx.now);
    // Drawn still, what is on it counts as seen: going back to it later moves nothing.
    if (!going && motion.live) { motion.live = false; try { return turnBody(ctx); } finally { motion.live = true; } }
  }
  // A finished turn's closing answer folds to one line; an open turn shows everything so far.
  const closed = !(latest && (view.live || waitingOn));
  const blocks: Line[][] = [promptLines(requestText(view.turn.request, group), ctx)];
  for (const segment of closed ? view.process : view.turn.segments) blocks.push(...segmentBlocks(segment, view, ctx, waitingOn));
  // On screen in the agent, not yet in the transcript: set as the words will be, so nothing changes when the record arrives.
  if (latest && ctx.extras.draft && going) blocks.push(wordLines(ctx.extras.draft, ctx));
  if (latest && ctx.extras.calls?.length && going) blocks.push(callLines(ctx.extras.calls.map(announcedRow), view, ctx, waitingOn));
  blocks.push(tailLines(view, latest, ctx));
  // What the turn changed, once it is over.
  if (closed) blocks.push(changesLines(view, ctx));
  return blocks.filter(block => block.length).flatMap((block, index) => index ? [[], ...block] : block);
}
