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
import { recordedFiles } from '../../../core/src/presentation';
import { resolveOutlineEvidence } from '../../../core/src/outline';

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
}

/**
 * Spans are known by their style object: cutting, wrapping and laying a line
 * on the band copy spans but keep their style, so what a span belongs to
 * survives every step from here to the screen.
 */
const OWNER = new WeakMap<Style, string>();
const CHIP = new WeakSet<Style>();
const owned = (style: Style, id: string): Style => { const own = { ...style }; OWNER.set(own, id); return own; };

/** Roughly the hues of the label colours, to tint the background toward. */
const HUES: Partial<Record<Color, readonly [number, number, number]>> = { blue: [108, 182, 255], green: [63, 185, 80], yellow: [227, 179, 65], red: [244, 112, 103] };

/**
 * A label: Prompt, Final Answer, New turn, an approval. Its words in its
 * colour on a faint wash of that colour, so it sits close to the line under it
 * without pressing on it. On a terminal whose background is unknown, a block
 * of colour (inverse keeps the words in the theme's own background colour).
 */
export function chip(text: string, fg: Color, background?: Capabilities['background']): Span {
  const hue = HUES[fg];
  const wash = background && hue ? [background.r, background.g, background.b].map((c, i) => Math.round(c + (hue[i] - c) * (background.dark ? 0.18 : 0.22))) as unknown as readonly [number, number, number] : undefined;
  const style: Style = wash ? { fg, bold: true, bgRgb: wash } : { fg, inverse: true, bold: true };
  CHIP.add(style);
  return { text: ` ${text} `, style };
}

/** What the session is doing, on the right of the header; nothing while it runs or after it is done. */
function statusSpans(status: SessionStatus, background?: Capabilities['background']): Span[] {
  if (status.kind === 'waiting') return [chip('Needs approval', 'yellow', background)];
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
  const status = statusSpans(ctx.status, ctx.caps.background);
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
/** A label starts a cell before the words, so the words in it line up with them. */
const labelLead = (): Span => ({ text: ' '.repeat(MARGIN - 1) });

/**
 * The label over a block of words, Prompt or Final Answer: a coloured word on
 * a line of its own, the words right under it. No wash behind it: a block of
 * colour presses on the line below, and a blank line between is too much.
 */
function heading(text: string, fg: Color): Span[] {
  const style: Style = { fg, bold: true };
  CHIP.add(style);
  return [{ text: ' '.repeat(MARGIN) }, { text, style }];
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

const base = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) || path;

/** The files the turn changed, under the request. */
function changedLine(view: TurnView, ctx: PageContext): Line[] {
  const files = view.turn.files;
  if (!files.length) return [];
  const spans: Span[] = [{ text: ' '.repeat(MARGIN) }, { text: '改动', style: DIM }];
  let used = MARGIN + 4, shown = 0;
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

/** Commands the summaries name as a read or a search in their first words, and the words to drop. */
const SHELL_READ = /^读取 /;
const SHELL_SEARCH = /^(搜索代码|查找文件|查看目录) · /;
const SHELL = /^(Bash|exec_command|shell|local_shell|BashOutput|KillShell|Terminal|Script)$/i;

/**
 * The tool, by the name the agent gives it: Bash, Read, Write. A write that
 * patched a file is an Edit; an MCP tool goes by its own last name.
 */
function toolName(chapterRow: ChapterRow, ctx: PageContext): string {
  if (chapterRow.output) return 'Output';
  const tool = chapterRow.tool;
  if (/^Write$/i.test(tool) && changeSize(chapterRow, ctx)?.edited) return 'Edit';
  if (/^mcp__/.test(tool)) return tool.split('__').at(-1) || tool;
  return tool;
}

/** Edits and writes are what the turn leaves behind: their names read in the body colour, their size on the right. */
const isChange = (chapterRow: ChapterRow): boolean => !chapterRow.output
  && (/^(Write|Edit|MultiEdit|apply_patch|NotebookEdit)$/i.test(chapterRow.tool) || (chapterRow.items.length > 0 && chapterRow.items.every(item => item.kind === 'file-change')));

/** Top-level pieces of a shell line and the separator after each: quotes, $( ), ( ) and { } are not split. */
function shellPieces(line: string): Array<{ text: string; at: number; sep: string }> {
  const pieces: Array<{ text: string; at: number; sep: string }> = [];
  let quote = '', depth = 0, start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = ''; else if (ch === '\\' && quote === '"') i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '(' || ch === '{') { depth++; continue; }
    if ((ch === ')' || ch === '}') && depth) { depth--; continue; }
    if (depth) continue;
    const two = line.slice(i, i + 2);
    const sep = two === '&&' || two === '||' ? two : ch === ';' || ch === '|' ? ch : '';
    if (!sep) continue;
    pieces.push({ text: line.slice(start, i), at: start, sep });
    i += sep.length - 1; start = i + 1;
  }
  pieces.push({ text: line.slice(start), at: start, sep: '' });
  return pieces.filter(piece => piece.text.trim());
}

/** Set-up a command line starts with: moving into a directory, setting a variable, defining a function. */
const SETUP = [/^cd\s/, /^(export\s+)?([A-Za-z_]\w*=("[^"]*"|'[^']*'|\$\([^)]*\)|\S)*\s*)+$/, /^[A-Za-z_][\w-]*\s*\(\)\s*\{/, /^set\s+-/, /^(source|\.)\s/];
/** Commands that only print or wait between the ones that do the work. */
const FILLER = /^(echo|printf|sleep|true|:)(\s|$)/;

/**
 * A command as it reads best: the first one its first line runs (a heredoc's
 * body is not the command), without the set-up before it, with the project's
 * and the home directory's paths shortened; and how many more it runs after.
 */
export function commandText(command: string, project = '', home = process.env.HOME ?? ''): { text: string; more: number } {
  const line = command.split('\n').find(part => part.trim()) ?? '';
  const pieces = shellPieces(line);
  const firstAt = pieces.findIndex(piece => !SETUP.some(pattern => pattern.test(piece.text.trim())));
  const kept = firstAt < 0 ? pieces : pieces.slice(firstAt);
  // The first command runs up to the first ; && or ||; a pipe stays part of it.
  let last = 0;
  while (last < kept.length - 1 && kept[last].sep === '|') last++;
  let text = kept.length ? line.slice(kept[0].at, kept[last].at + kept[last].text.length).trim() : line.trim();
  // The first line of a command whose quote goes on to the next lines: what it runs, then … for the rest.
  if (command.trim().includes('\n') && ((text.match(/"/g)?.length ?? 0) % 2 || (text.match(/'/g)?.length ?? 0) % 2)) text = text.replace(/\s*["'][^"']*$/, '') + ' …';
  const more = kept.slice(last + 1).filter((piece, index, rest) => (index === 0 || rest[index - 1].sep !== '|') && !FILLER.test(piece.text.trim())).length;
  const script = text.match(/^(python3?|node|ruby|bash|sh|zsh)\s+(-\S*\s+)*-?\s*<<-?\s*['"]?\w+['"]?\s*$/);
  if (script) text = `${script[1]} script`;
  text = text.replace(/\s*<<-?\s*['"]?\w+['"]?\s*$/, '');
  if (project) text = text.split(project.replace(/\/$/, '') + '/').join('');
  if (home) text = text.split(home + '/').join('~/');
  return { text: text.replace(/\s+/g, ' '), more };
}

/**
 * The words of a call's line: the agent's own description, the summary's
 * first part, or the command itself where the summary only repeats it; and
 * how many more parts it has.
 */
function callText(chapterRow: ChapterRow, ctx: PageContext): { text: string; more: number; command?: boolean } {
  let label = chapterRow.label.replace(/^调用 Bash · /, '').replace(/（(动态参数|含管道|复合命令)）/g, '');
  const command = chapterRow.command;
  const shell = SHELL.test(chapterRow.tool);
  const squash = (text: string) => text.replace(/\s+/g, '');
  if (shell && command !== undefined && squash(label).slice(0, 12) === squash(command).slice(0, 12)) {
    const shown = commandText(command, ctx.session.projectPath);
    return { text: shown.text || chapterRow.tool, more: shown.more, command: true };
  }
  // A command's parts and a search's queries are joined by ；: the first one reads, the rest are counted.
  const parts = shell || WEB.test(chapterRow.tool) ? label.split('；') : [label];
  label = parts[0];
  if (shell) {
    const named = label.replace(SHELL_READ, '').replace(SHELL_SEARCH, '');
    // A summary that names no file or pattern ("检索项目记忆") says less than the command it stands for.
    if (named === label && command !== undefined && /[\u3400-\u9fff]/.test(label) && !/^运行 \S+ 脚本$/.test(label)) {
      const shown = commandText(command, ctx.session.projectPath);
      if (shown.text) return { text: shown.text, more: shown.more, command: true };
    }
    // "运行 python3 脚本" is the command, said in other words: it reads as a command does.
    if (/^运行 /.test(named)) return { text: named.replace(/^运行 (\S+) 脚本$/, '$1 script').replace(/^运行 /, ''), more: parts.length - 1, command: true };
    label = named;
  }
  label = label.replace(/^文件变化 · /, '');
  // What was searched or fetched reads like a command: as it was given, on one line.
  return { text: label.replace(/\s+/g, ' ').trim() || chapterRow.tool, more: parts.length - 1, ...(WEB.test(chapterRow.tool) ? { command: true } : {}) };
}

const WEB = /^(WebSearch|WebFetch|WEB|Web)$/;
/** The sources a web search returned, recorded apart from the call. */
const isSources = (chapterRow: ChapterRow): boolean => chapterRow.items.length > 0 && chapterRow.items.every(item => item.title === 'Web 来源');

/**
 * The calls as steps. A shared output and the sources of a search the row
 * before already made are records of a step, not steps: they open from the
 * call, and take no line of their own. Sources with no call before them are
 * the search itself.
 */
function steps(rows: ChapterRow[]): ChapterRow[] {
  const kept: ChapterRow[] = [];
  for (const chapterRow of rows) {
    if (chapterRow.output) continue;
    if (isSources(chapterRow)) {
      if (kept.length && WEB.test(kept.at(-1)!.tool)) continue;
      kept.push({ ...chapterRow, tool: 'WebSearch', label: chapterRow.items[0].summary.replace(/\s*\.\.\.$/, '') });
      continue;
    }
    kept.push(chapterRow);
  }
  return kept;
}

/** Lines added and removed by a recorded change, and whether it wrote a new file. */
const SIZES = new WeakMap<ChapterRow, { added: number; removed: number; edited: boolean } | undefined>();
function changeSize(chapterRow: ChapterRow, ctx: PageContext): { added: number; removed: number; edited: boolean } | undefined {
  if (SIZES.has(chapterRow)) return SIZES.get(chapterRow);
  const size = measureChange(chapterRow, ctx);
  SIZES.set(chapterRow, size);
  return size;
}
function measureChange(chapterRow: ChapterRow, ctx: PageContext): { added: number; removed: number; edited: boolean } | undefined {
  const all = recordedFiles(chapterRow.items, resolveOutlineEvidence(ctx.session, chapterRow.id, chapterRow.items[0])?.entry);
  const files = all.length > 1 ? all.filter(file => base(file.path) === base(chapterRow.label)) : all;
  if (!files.length) return undefined;
  let added = 0, removed = 0;
  for (const file of files) for (const line of file.lines) {
    if (file.operation === 'write') added++;
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed, edited: files.some(file => file.operation === 'update' || file.operation === 'delete') };
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

/** What shows on the right of a call: a failure in red, a call still out, the size of a change. */
function callEnd(chapterRow: ChapterRow, ctx: PageContext, live: boolean, asking: boolean): Span[] {
  const call = rowView(chapterRow, live);
  if (call.word) return [{ text: call.word, style: { fg: 'red' } }];
  if (call.empty) return [{ text: 'no match', style: DIM }];
  if (call.out) return [{ text: asking ? '?' : symbol(ctx.caps, '…'), style: YELLOW }];
  if (isChange(chapterRow)) {
    const size = changeSize(chapterRow, ctx);
    if (size) return [...(size.added ? [{ text: `+${size.added}`, style: { fg: 'green' } as Style }] : []), ...(size.added && size.removed ? [{ text: ' ' }] : []), ...(size.removed ? [{ text: `-${size.removed}`, style: { fg: 'red' } as Style }] : [])];
  }
  return call.note ? [{ text: call.note, style: DIM }] : [];
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
  const rows = steps(all);
  const tint = bandColor(ctx.caps.background);
  const live = view.live || waitingOn;
  const names = rows.map(chapterRow => toolName(chapterRow, ctx));
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
      const branch: Span = { text: lead + symbol(ctx.caps, end ? '└' : '├') + ' ', style: DIM };
      const through: Span = { text: lead + (end ? ' ' : symbol(ctx.caps, '│')) + ' ', style: DIM };
      const shown = callText(chapterRow, ctx);
      // The tool's name stands out; what the call worked on reads a step back, in grey.
      const style = owned(DIM, chapterRow.id);
      const label = shown.text + (chapterRow.count > 1 ? ` · ${chapterRow.count} 次` : '');
      const outcome = callEnd(chapterRow, ctx, live, waitingOn && chapterRow === rows.at(-1));
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
      wrapped.forEach((part, piece) => push([piece ? through : branch, ...part], piece === 0 && chapterRow.openable ? [{ row: chapterRow, height: wrapped.length }] : []));
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
const wordLines = (source: string, ctx: PageContext, style: Style = {}, indent = MARGIN): Span[][] =>
  prose(source, ctx.width - 1, { glyph: ch => symbol(ctx.caps, ch), indent, style });

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
  if (!text) return view.turn.aborted ? [[labelLead(), chip('Interrupted', 'red', ctx.caps.background)]] : [];
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

/** The end of the turn: waiting on you, no word for a while, or the answer it closed with. While it runs, nothing. */
function tailLines(view: TurnView, latest: boolean, ctx: PageContext): Line[] {
  const status = ctx.status;
  const lead: Span = { text: ' '.repeat(MARGIN) };
  if (latest && status.kind === 'waiting') {
    const what = [status.approval.tool, /^\/.+\/[^/]+$/.test(status.approval.summary) ? status.approval.summary.split('/').at(-1)! : status.approval.summary].filter(Boolean);
    return [
      cutLine([labelLead(), chip('Needs approval', 'yellow', ctx.caps.background), ...(what.length ? [{ text: ' ' + what[0], style: { bold: true } }, ...(what[1] ? [{ text: ' · ' + what[1].replace(/\s+/g, ' ') }] : [])] : [])], ctx.width),
      cutLine([lead, { text: `在 ${providerName(ctx.session.provider)} 里选择批准或拒绝。`, style: DIM }], ctx.width),
    ];
  }
  if (latest && status.kind === 'running') return [];
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
export interface CallTarget { line: number; height: number; row?: ChapterRow; answer?: boolean; from?: number; to?: number }

/** The page and where each call row and the answer are on it, for selecting and opening them. */
export function turnLayout(ctx: PageContext): { lines: Line[]; targets: CallTarget[] } {
  const lines = turnBody(ctx);
  const targets: CallTarget[] = [];
  lines.forEach((line, index) => {
    if (typeof line !== 'object') return;
    for (const target of TARGETS.get(line) ?? []) targets.push({ line: index, ...target });
    const answer = ANSWER.get(line);
    if (answer) targets.push({ line: index, height: answer, answer: true });
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
  // A finished turn's closing answer folds to one line; an open turn shows everything so far.
  const closed = !(latest && (view.live || waitingOn));
  const blocks: Line[][] = [[...promptLines(requestText(view.turn.request, group), ctx), ...changedLine(view, ctx)]];
  for (const segment of closed ? view.process : view.turn.segments) blocks.push(...segmentBlocks(segment, view, ctx, waitingOn));
  // On screen in the agent, not yet in the transcript: set as the words will be, so nothing changes when the record arrives.
  if (latest && ctx.extras.draft && going) blocks.push(wordLines(ctx.extras.draft, ctx));
  blocks.push(tailLines(view, latest, ctx));
  return blocks.filter(block => block.length).flatMap((block, index) => index ? [[], ...block] : block);
}
