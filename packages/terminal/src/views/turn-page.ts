import type { Provider, SessionData, TimelineItem } from '../../../core/src/model';
import type { TurnGroup } from '../../../core/src/timeline';
import type { ChapterRow, TurnSegment } from '../../../core/src/chapters';
import type { LiveExtras } from '../../../core/src/live-extras';
import { plainPasted } from '../../../core/src/pasted';
import { backgroundLine, clock, publicBody, rowView, turnView, type TurnView } from '../../../core/src/turn-view';
import { partnerOf, partnerRun } from '../../../core/src/agent-line';
import { symbol, type Capabilities } from '../caps';
import { cutLine, plainText, row, spans, type Color, type Line, type Span, type Style } from '../screen';
import { textWidth } from '../width';
import { inlineSpans, prose, wrapSpans } from './prose';
import { shortFileLabels } from '../../../core/src/presentation';
import { commandText } from '../../../core/src/command-line';
import { announcedRow, callEnd as endOf, callSteps, callText as wordsOf, callTool } from '../../../core/src/call-line';
import { breathAt, FADE_MS, type Motion } from '../motion';

export { commandText };

/**
 * One turn per screen, to read beside the agent (design v11 B): what you asked
 * raised on a band, the one thing on the page that is; the agent's words in
 * the body colour with the calls they explain under them, as a tree under each
 * tool's name, on the page itself; and, under a rule, how the turn ended.
 * Labels are grey; colour says only what is going on. Nothing here is drawn
 * the way the agents draw their own transcript. Plain data in, styled lines
 * out; the app decides which turn and which part of it is on screen.
 */

export type SessionStatus =
  | { kind: 'running'; since?: string; verb: string }
  | { kind: 'waiting'; approval: { tool: string; summary: string } }
  | { kind: 'quiet'; lastAt?: string }
  /** `alive`: the agent reports its state, so it is still there to hear back from tasks it left running. */
  | { kind: 'idle'; alive?: boolean }
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
  return { kind: 'idle', ...(agent?.state ? { alive: true } : {}) };
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
type Rgb = readonly [number, number, number];
const mix = (a: Rgb, b: Rgb, share: number): Rgb => [0, 1, 2].map(i => Math.round(a[i] * share + b[i] * (1 - share))) as unknown as Rgb;
const rgb = (colour: { r: number; g: number; b: number }): Rgb => [colour.r, colour.g, colour.b];

/**
 * The greys, mixed from the terminal's own text and background colours, as
 * the VS Code panel mixes them from its theme (design v12): labels, notes and
 * what a call worked on at QUIET, the tree's lines at HAIR. `fade`, from 0 to
 * 1, is how far a line just come in has faded in. Colours unknown: the
 * palette's grey, and nothing fades.
 */
const QUIET = 0.6, HAIR = 0.3;
function ink(ctx: Pick<PageContext, 'caps'>, share: number, fade = 1): Style {
  const { background, foreground } = ctx.caps;
  return background && foreground ? { fgRgb: mix(rgb(foreground), rgb(background), share * fade) } : DIM;
}
const quiet = (ctx: Pick<PageContext, 'caps'>, fade = 1): Style => ink(ctx, QUIET, fade);
const hair = (ctx: Pick<PageContext, 'caps'>, fade = 1): Style => ink(ctx, HAIR, fade);
/** The body colour, fading in: plain where nothing fades. */
const body = (ctx: Pick<PageContext, 'caps'>, fade = 1): Style => fade < 1 && ctx.caps.background && ctx.caps.foreground ? ink(ctx, 1, fade) : {};
/** How far a call `age` ms on the page has faded in: three steps over FADE_MS. */
const faded = (age: number | undefined): number => age === undefined || age >= FADE_MS ? 1 : (Math.floor(age / (FADE_MS / 3)) + 1) / 3;

/**
 * Gold for a call waiting on you and the waiting dot, a fifth of the way to
 * the text colour so it sits with the greys; the palette's yellow where exact
 * colour is unknown.
 */
const GOLD: Rgb = [201, 164, 92];
const goldRgb = (ctx: Pick<PageContext, 'caps'>): Rgb => ctx.caps.foreground ? mix(GOLD, rgb(ctx.caps.foreground), 0.8) : GOLD;
const gold = (ctx: PageContext): Style => ({ fg: 'yellow', ...(ctx.caps.background ? { fgRgb: goldRgb(ctx) } : {}) });

export interface PageContext {
  session: SessionData;
  groups: TurnGroup[];
  /** Index into `groups` of the turn on screen. */
  index: number;
  status: SessionStatus;
  extras: LiveExtras;
  caps: Pick<Capabilities, 'symbols' | 'background' | 'foreground'>;
  width: number;
  now: number;
  /** The closing answer is opened in full. */
  answerOpen?: boolean;
  /** At most this many lines of the prompt, then …: a subagent's task can run long. */
  promptMax?: number;
  /** A subagent's own turn: what it was given is its Task, what it gave back its Result. */
  subagentPage?: boolean;
  /** Subagents' own sessions, by the id of the call that started each: what a running one has done so far. */
  subagents?: ReadonlyMap<string, SessionData>;
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
 * A label's word: Prompt, Final Answer and Changes in grey; Needs approval,
 * Interrupted and New turn bold in the colour of what is going on. Nothing
 * behind it: a block of colour presses on the line below it.
 */
export function label(text: string, tone: Color | Style): Span {
  const style: Style = typeof tone === 'string' ? { fg: tone, bold: true } : { ...tone };
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
    ? [{ text: ' '.repeat(MARGIN) }, { text: `第 ${ordinal} 轮`, style: { bold: true } }, { text: ` / 共 ${total} 轮${started ? ` · ${started}${narrow ? '' : ' 开始'}` : ''}`, style: quiet(ctx) }]
    : [{ text: ' 未归属回合的记录', style: quiet(ctx) }];
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
 * The label over a block of words, Prompt or Final Answer: a word on a line of
 * its own, the words right under it. No wash behind it: a block of colour
 * presses on the line below, and a blank line between is too much.
 */
function heading(text: string, tone: Color | Style): Span[] {
  return [{ text: ' '.repeat(MARGIN) }, label(text, tone)];
}

/**
 * What you asked, whole, in bold under a grey Prompt label, on a band: the one
 * thing on the page raised, as a sheet is in the VS Code panel. Where the
 * terminal's background is unknown there is no band, and a bar runs down its
 * side instead. Your words sent during the turn are set the same way.
 */
function promptLines(text: string, ctx: PageContext): Line[] {
  const tint = bandColor(ctx.caps.background);
  // The words in the page's column; without a band, the bar in the first column.
  const lead: Span[] = tint ? [{ text: ' '.repeat(MARGIN) }] : [{ text: symbol(ctx.caps, '┃'), style: quiet(ctx) }, { text: ' '.repeat(MARGIN - 1) }];
  // Typed, not written as a document: each line as it was typed, wrapped beside the bar, no list indents.
  const room = Math.max(8, ctx.width - MARGIN - 1 - (tint ? MARGIN - 1 : 0));
  const bold = (line: Span[]): Span[] => line.map(span => ({ ...span, style: { ...span.style, bold: true } }));
  const words = text.replace(/\r/g, '').split('\n').flatMap(source => source.trim() ? wrapSpans(inlineSpans(source.trimEnd()), room).map(line => [...lead, ...bold(spans(line))]) : [lead.slice(0, 1)]);
  const max = ctx.promptMax;
  const lines: Line[] = [heading(ctx.subagentPage ? 'Task' : 'Prompt', quiet(ctx)), ...(max && words.length > max ? [...words.slice(0, max), [...lead, { text: '… ', style: quiet(ctx) }, { text: symbol(ctx.caps, '▾'), style: { ...quiet(ctx), bold: true } }]] : words)];
  // A line of the band's own above and below: room around the words.
  return tint ? band([[], ...lines, []], ctx.width, tint) : lines;
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
  const head = heading('Changes', quiet(ctx));
  CHANGES.add(head);
  const sizes = (added?: number, removed?: number): Span[] => [
    ...(added ? [{ text: `+${added}`, style: { fg: 'green' } as Style }] : []), ...(added && removed ? [{ text: ' ' }] : []),
    ...(removed ? [{ text: `-${removed}`, style: { fg: 'red' } as Style }] : []),
  ];
  const open: Span = { text: ' ' + symbol(ctx.caps, '▾'), style: { ...quiet(ctx), bold: true } };
  if (!ctx.changesOpen) {
    const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0), removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
    const partial = files.some(file => file.added === undefined) && files.some(file => file.added !== undefined);
    const line = cutLine([lead, { text: `${files.length} 个文件` }, ...(added || removed ? [{ text: '  ' }, ...sizes(added, removed)] : []), ...(partial ? [{ text: ' 等', style: quiet(ctx) }] : []), open], ctx.width);
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
    const line: Span[] = [lead, { text: file.mark, style: file.mark === 'A' ? { fg: 'green' } : file.mark === 'D' ? { fg: 'red' } : quiet(ctx) }, { text: ' ' },
      { ...name, ...(row ? { style: owned({}, row.id) } : {}) }, { text: ' '.repeat(gap) }, ...size];
    if (row?.openable) TARGETS.set(line as object, [{ row, height: 1 }]);
    lines.push(line);
  });
  return lines;
}

/**
 * The band behind what you asked: the terminal's own background moved a
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
function callEnd(chapterRow: ChapterRow, ctx: PageContext, live: boolean, fade = 1): Span[] {
  const end = endOf(chapterRow, ctx.session, live);
  if (!end) return [];
  if (end.kind === 'failed') return [{ text: end.word, style: { fg: 'red' } }];
  if (end.kind === 'empty') return [{ text: 'no match', style: quiet(ctx, fade) }];
  if (end.kind === 'note') return [{ text: end.text, style: quiet(ctx, fade) }];
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
 * A step's calls under the words that explain them, on the page itself, as a
 * tree: the tool's name on a line of its own, once for a run of one tool, and
 * each call of the run hung from it on ├, the last on └. A call's second line
 * goes on under │, so it never reads as the next call. Every call is shown:
 * the reader is here for the process. The tool's name is bold in the body
 * colour, to see at a glance what the agent used; what each call worked on
 * reads in grey, all alike, the tree's lines fainter still. A command keeps to
 * one line, what it runs after counted. Colour marks what needs it: a
 * failure, a call still out, a change's size.
 */
function callLines(all: ChapterRow[], view: TurnView, ctx: PageContext, waitingOn: boolean): Line[] {
  // Calls that arrive together come in one after another. The key is what the line says, the same for the
  // hook's early copy and the transcript's record; a repeat of the same line is told apart by its count.
  const said = new Map<string, number>();
  const fades = new Map<ChapterRow, number>();
  const rows = callSteps(all).filter(chapterRow => {
    if (!ctx.motion) return true;
    const key = `c:${callTool(chapterRow, ctx.session)}\u0000${wordsOf(chapterRow, ctx.session).text}`;
    const count = said.get(key) ?? 0;
    said.set(key, count + 1);
    const age = ctx.motion.age(`${key}\u0000${count}`);
    if (age === undefined) return false;
    fades.set(chapterRow, faded(age));
    return true;
  });
  // Runs of calls, and runs of one partner tool's calls (Agent, SendMessage, Skill, Workflow): set off from them (agentLines).
  const runs: ChapterRow[][] = [];
  const partner = (chapterRow: ChapterRow) => partnerOf(chapterRow, ctx.session);
  for (const chapterRow of rows) {
    const last = runs.at(-1);
    if (last && partner(last[0]) === partner(chapterRow) && (!partner(chapterRow) || callTool(last[0], ctx.session) === callTool(chapterRow, ctx.session))) last.push(chapterRow); else runs.push([chapterRow]);
  }
  return runs.flatMap((run, index) => [...(index ? [[]] : []), ...(partner(run[0]) ? agentLines(run, view, ctx, waitingOn) : treeLines(run, view, ctx, waitingOn, fades, rows.at(-1)))]);
}

/**
 * Agent calls are other agents set to work, not tools the agent used: set off
 * from them, under their tool's name and the lead their descriptions share, each a
 * dot whose colour is its state (gold running, green done, red failed, grey
 * stopped) and its own words in the body colour; under it, in grey, what the
 * run came to: background or not, how long, its tokens and its calls. Calls
 * that deal with another agent or take on a way of working are set the same
 * way (design v14): a message → the agent it went to, the message under it; a
 * skill ◆ by name, its arguments under it; a workflow's dot and what it does,
 * its phases hung under it.
 */
function agentLines(rows: ChapterRow[], view: TurnView, ctx: PageContext, waitingOn: boolean): Line[] {
  const lead = ' '.repeat(MARGIN);
  const run = partnerRun(rows, ctx.session, ctx.now, chapterRow => { const callId = chapterRow.items[0]?.callId; return callId ? ctx.subagents?.get(callId) : undefined; });
  const room = Math.max(8, ctx.width - MARGIN - 2 - MARGIN);
  const lines: Line[] = [[{ text: lead }, { text: run.tool, style: TOOL }, ...(run.lead ? [{ text: ' · ' + run.lead }] : [])]];
  rows.forEach((chapterRow, index) => {
    const line = run.lines[index];
    const state = line.state;
    const mark: Span = line.mark === 'dot'
      ? { text: symbol(ctx.caps, '●'), style: state === 'running' ? gold(ctx) : state === 'done' ? { fg: 'green' } : state === 'failed' ? { fg: 'red' } : quiet(ctx) }
      : { text: symbol(ctx.caps, line.mark), style: quiet(ctx) };
    const style = owned({}, chapterRow.id);
    const parts = wrapSpans([{ text: line.name, style }], room);
    if (parts.length > CALL_LINES) parts.splice(CALL_LINES - 1, Infinity, [...cutLine([{ text: parts.slice(CALL_LINES - 1).map(plainText).join(' ') + '  ', style }], room)]);
    const own: Line[] = parts.map((part, piece) => [{ text: lead }, piece ? { text: '  ' } : mark, ...(piece ? [] : [{ text: ' ' }]), ...part]);
    line.phases.forEach((phase, at) => own.push(cutLine([{ text: lead + '  ' + symbol(ctx.caps, at === line.phases.length - 1 ? '└' : '├') + ' ', style: hair(ctx) }, { text: phase, style: owned(quiet(ctx), chapterRow.id) }], ctx.width)));
    if (line.facts) own.push(cutLine([{ text: lead + '  ' }, { text: line.facts, style: owned(quiet(ctx), chapterRow.id) }], ctx.width));
    if (chapterRow.openable) TARGETS.set(own[0] as object, [{ row: chapterRow, height: own.length }]);
    lines.push(...own);
  });
  return lines;
}

/** Calls on their tree: see callLines. `fades` says how far each call just come in has faded in. */
function treeLines(rows: ChapterRow[], view: TurnView, ctx: PageContext, waitingOn: boolean, fades: ReadonlyMap<ChapterRow, number>, lastRow = rows.at(-1)): Line[] {
  const live = view.live || waitingOn;
  const names = rows.map(chapterRow => callTool(chapterRow, ctx.session));
  const lead = ' '.repeat(MARGIN);
  // As much room on the right as on the left.
  const room = Math.max(8, ctx.width - MARGIN - 2 - MARGIN);
  const lines: Line[] = [];
  const push = (line: Span[], targets: LineTarget[]) => {
    if (targets.length) TARGETS.set(line as object, targets);
    lines.push(line);
  };
  for (let at = 0; at < rows.length;) {
    let last = at;
    while (last + 1 < rows.length && names[last + 1] === names[at]) last++;
    const run = rows.slice(at, last + 1);
    // The tool's name comes in with its first call.
    push([{ text: lead }, { text: names[at], style: { ...TOOL, ...body(ctx, fades.get(run[0]) ?? 1) } }], []);
    run.forEach((chapterRow, index) => {
      const end = index === run.length - 1;
      const fade = fades.get(chapterRow) ?? 1;
      // A call waiting on you shows ? in its tree cell. One still running is drawn as any other: the waiting dot is the turn's, at its end.
      const asking = waitingOn && chapterRow === lastRow && rowView(chapterRow, live).out;
      const branch: Span[] = asking
        ? [{ text: lead }, { text: '?', style: gold(ctx) }, { text: ' ' }]
        : [{ text: lead + symbol(ctx.caps, end ? '└' : '├') + ' ', style: hair(ctx, fade) }];
      const through: Span = { text: lead + (end ? ' ' : symbol(ctx.caps, '│')) + ' ', style: hair(ctx, fade) };
      const shown = wordsOf(chapterRow, ctx.session);
      // The tool's name stands out; what the call worked on reads a step back, in grey.
      const style = owned(quiet(ctx, fade), chapterRow.id);
      const label = shown.text + (chapterRow.count > 1 ? ` · ${chapterRow.count} 次` : '');
      const outcome = callEnd(chapterRow, ctx, live, fade);
      const tail: Span[] = [...(shown.more ? [{ text: ` +${shown.more}`, style: owned({ ...quiet(ctx, fade), bold: true }, chapterRow.id) }] : []), ...(outcome.length ? [{ text: ' ' }, ...outcome] : [])];
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
        if (chosen) push(cutLine([through, ...(choice.header ? [{ text: choice.header + '  ', style: quiet(ctx) }] : []), { text: chosen, style: choice.chosen.length ? { bold: true } : quiet(ctx) }], ctx.width), []);
      }
    });
    at = last + 1;
  }
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

/** A segment as blocks, one blank line apart: the agent's words, then the tree of its calls. */
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
  const head = heading(ctx.subagentPage ? 'Result' : 'Final Answer', quiet(ctx));
  if (ctx.answerOpen) {
    ANSWER.set(head, 1);
    return [head, ...wordLines(text, ctx)];
  }
  // Its opening lines run together, marks of headings and lists dropped, so the line is full.
  const flat = text.split(/\n/).map(line => line.trim().replace(/^#+\s*|^[-*]\s+|^\d+\.\s+|^>\s*/, '')).filter(Boolean).join(' ');
  const open: Span = { text: ' ' + symbol(ctx.caps, '▾'), style: { ...quiet(ctx), bold: true } };
  ANSWER.set(head, 2);
  return [head, [...cutLine([...lead, ...inlineSpans(flat)], ctx.width - 2 - MARGIN), open]];
}

/**
 * The end of the turn: waiting on you, no word for a while, or the answer it
 * closed with. While it runs, a call out or the agent working out its next
 * step, a gold dot breathes here, where the answer will come: once what came
 * in last is all in, so it never sits above what is still appearing.
 */
/** The waiting dot: gold breathing toward the background; without exact colours, the palette's yellow, faint every other breath. */
function breathing(ctx: PageContext): Style {
  const background = ctx.caps.background;
  if (!background) return { fg: 'yellow', dim: Math.floor(ctx.now / 800) % 2 === 1 };
  return { fg: 'yellow', fgRgb: mix(goldRgb(ctx), rgb(background), breathAt(ctx.now)) };
}

function tailLines(view: TurnView, latest: boolean, ctx: PageContext): Line[] {
  const status = ctx.status;
  const lead: Span = { text: ' '.repeat(MARGIN) };
  if (latest && status.kind === 'waiting') {
    const what = [status.approval.tool, /^\/.+\/[^/]+$/.test(status.approval.summary) ? status.approval.summary.split('/').at(-1)! : status.approval.summary].filter(Boolean);
    // As Final Answer is: the label on its own line, what it asks about under it.
    return [
      heading('Needs approval', 'yellow'),
      ...(what.length ? [cutLine([lead, { text: what[0], style: { bold: true } }, ...(what[1] ? [{ text: ' · ' + what[1].replace(/\s+/g, ' ') }] : [])], ctx.width)] : []),
      cutLine([lead, { text: `在 ${providerName(ctx.session.provider)} 里选择批准或拒绝。`, style: quiet(ctx) }], ctx.width),
    ];
  }
  if (latest && status.kind === 'running') {
    ctx.motion?.turning();
    if (ctx.motion && !ctx.motion.resting()) return [];
    return [[lead, { text: symbol(ctx.caps, '●'), style: breathing(ctx) }]];
  }
  if (view.live && latest) return [[lead, { text: `无新记录${status.kind === 'quiet' && status.lastAt ? ` · 最后一条 ${clock(status.lastAt)}` : ''}`, style: quiet(ctx) }]];
  if (!view.turn.segments.length) return [];
  return answerLines(view, ctx);
}

/**
 * Marks the call or the answer under the cursor or the pointer, every line of
 * it at once (design v13, 2b): what was grey comes up in the body colour; what
 * was in the body colour already is underlined. No colour of its own: colour
 * says what the agent is doing, not where the reader is. `owner` is the call's
 * id; without one the line is the answer's, and all its words are.
 */
export function markSelected(line: Line, owner?: string): Line {
  return spans(line).map(span => {
    const style = span.style;
    const mine = owner !== undefined ? Boolean(style && OWNER.get(style) === owner) : Boolean(span.text.trim()) && !(style && CHIP.has(style));
    return mine ? { ...span, style: lit(style) } : span;
  });
}

/** A span under the pointer: grey to the body colour, the body colour underlined. */
export const lit = (style: Style = {}): Style => style.dim || style.fgRgb ? { ...style, dim: false, fgRgb: undefined } : { ...style, underline: true };

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
 * The whole turn, top to bottom: what was asked, then the agent's words with
 * the calls each explains under them, then, under a rule, how the turn ended
 * and what it changed. Blocks are one blank line apart.
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
  const tail = tailLines(view, latest, ctx);
  // What the turn changed, once it is over.
  const changes = closed ? changesLines(view, ctx) : [];
  // Over: a faint rule across the page sets how it ended apart from the process.
  const closing = closed ? [tail, changes].find(block => block.length) : undefined;
  if (closing) closing.unshift([{ text: ' '.repeat(MARGIN) + symbol(ctx.caps, '─').repeat(Math.max(1, ctx.width - 2 * MARGIN)), style: hair(ctx) }]);
  blocks.push(tail, changes);
  // Over, but tasks it left running have not reported back: the agent will answer them here.
  const background = closed && latest && ctx.status.kind === 'idle' && ctx.status.alive ? backgroundLine(ctx.session) : undefined;
  if (background) blocks.push([[{ text: ' '.repeat(MARGIN) }, { text: background, style: quiet(ctx) }]]);
  return blocks.filter(block => block.length).flatMap((block, index) => index ? [[], ...block] : block);
}
