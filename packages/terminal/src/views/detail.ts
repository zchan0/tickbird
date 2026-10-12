import { isAbsolute, join } from 'node:path';
import type { SessionData } from '../../../core/src/model';
import type { TurnGroup } from '../../../core/src/timeline';
import { resolveOutlineEvidence } from '../../../core/src/outline';
import { describeDisplayAction, fileLanguage, fileReading, presentEvidence, recordedFiles, toolOutputContents, type FileReading, type InputContent, type PatchFile } from '../../../core/src/presentation';
import { chapterTurn, type ChapterRow } from '../../../core/src/chapters';
import { outcomeWord } from '../../../core/src/turn-view';
import { recordedToolInputs } from '../../../core/src/actions';
import { diffRows, fileChanges } from '../../../core/src/call-target';
import { plainText, type Line, type Span, type Style } from '../screen';
import { textWidth } from '../width';
import { hardWrap, highlightLines } from './code';
import type { Glyph } from './prose';
import { MARGIN, turnBody, type PageContext } from './turn-page';
import { visibleTurnGroups } from '../../../core/src/outline';
import { publicBody, turnView } from '../../../core/src/turn-view';
import type { Capabilities } from '../caps';

/**
 * A call opened in the pane: a read shows the file as read, a change shows the
 * diff as recorded, anything else its input and its return. Always the content
 * of the time, from the transcript; the file on disk is only opened with `o`.
 */
export interface DetailDoc {
  kind: 'file' | 'diff' | 'call';
  /** File name, or the call's label. */
  title: string;
  /** Directory of the file, for the second header line. */
  directory?: string;
  /** Absolute path, for `o` and `y`. */
  path?: string;
  /** First line shown, for `o`. */
  line?: number;
  /** Right side of the header: "Read · 第 1–12 行", "Edit · 第 2 次 / 共 3 次". */
  meta: string;
  /** What `y` copies, and its name. */
  copy: { text: string; what: string };
  /** Other changes to the same file in this turn, switched with < >. */
  edits?: { index: number; total: number };
  lines: Line[];
}

const DIM: Style = { dim: true };
export { changedWords, recordedImage, callLink, type RecordedImage } from '../../../core/src/call-target';
const base = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) || path;
const dir = (path: string) => { const parts = path.replace(/\\/g, '/').split('/'); parts.pop(); return parts.length ? parts.join('/') + '/' : ''; };
const absolute = (path: string, session: SessionData) => isAbsolute(path) ? path : join(session.projectPath, path);
/** A path inside the project reads relative to it. */
const shown = (path: string, session: SessionData) => {
  const full = absolute(path, session), root = session.projectPath.replace(/\/$/, '') + '/';
  return full.startsWith(root) ? full.slice(root.length) : full;
};

/**
 * Every detail is made of panels of one shape: a left column, a bar, the text,
 * from the page's margin as the rest of the page is. The left column holds line
 * numbers or marks, and is there only when a row has one: input and output
 * start at the bar. Long lines wrap under the bar with an empty left column.
 */
export interface PanelRow { mark?: string; markStyle?: Style; spans: Span[] }

export function panel(rows: PanelRow[], width: number, glyph: Glyph): Line[] {
  // As wide as the widest mark, as a diff's line numbers are.
  const gutter = rows.some(row => row.mark) ? Math.max(...rows.map(row => textWidth(row.mark ?? ''))) + 1 : 0;
  const bar = glyph('│');
  const room = Math.max(8, width - MARGIN - gutter - 3);
  return rows.flatMap(row => (row.spans.length ? hardWrap(row.spans, room) : [[]]).map((part, piece) => [
    { text: ' '.repeat(MARGIN) + (gutter ? (piece ? '' : row.mark ?? '').padStart(gutter - 1) + ' ' : ''), style: row.markStyle ?? DIM },
    { text: `${bar} `, style: DIM }, ...part,
  ]));
}

/** A file as read: its line numbers in the left column, the text highlighted. */
export function fileLines(reading: Pick<FileReading, 'lines' | 'start' | 'language'>, width: number, glyph: Glyph): Line[] {
  return panel(highlightLines(reading.lines.join('\n'), reading.language).map((spans, index) => ({
    ...(reading.start !== undefined ? { mark: String(reading.start + index) } : {}), spans,
  })), width, glyph);
}

type Rgb = readonly [number, number, number];
/** Claude Code's diff colours (its dark and light themes): the changed line, and the words that changed in it. */
const DIFF_COLOURS: Record<'dark' | 'light', { add: Rgb; del: Rgb; addWord: Rgb; delWord: Rgb }> = {
  dark: { add: [34, 92, 43], del: [122, 41, 54], addWord: [56, 166, 96], delWord: [179, 89, 107] },
  light: { add: [199, 225, 203], del: [253, 210, 216], addWord: [105, 219, 124], delWord: [255, 168, 180] },
};
export type Background = { r: number; g: number; b: number; dark: boolean } | undefined;

/**
 * A recorded change as Claude Code draws one: each line's number, then its
 * sign; a removed line on red and an added one on green across the pane, the
 * words that changed in a replaced line on a brighter shade. Where the record
 * gives no line numbers (a Codex patch) the column is left out. On a terminal
 * whose background is unknown, the colour goes on the text instead.
 */
export function diffLines(file: PatchFile, width: number, glyph: Glyph, background?: Background): Line[] {
  const colours = background ? DIFF_COLOURS[background.dark ? 'dark' : 'light'] : undefined;
  const pieces = diffRows(file);
  const numbers = pieces.flatMap(piece => 'no' in piece && piece.no !== undefined ? [piece.no] : []);
  const digits = numbers.length ? String(Math.max(...numbers)).length : 0;
  const gutter = MARGIN + (digits ? digits + 1 : 0) + 2;
  const room = Math.max(8, width - gutter - 1);
  const lines: Line[] = [];
  for (const piece of pieces) {
    if ('gap' in piece) { lines.push([{ text: ' '.repeat(gutter) + (piece.gap || glyph('…')), style: DIM }]); continue; }
    const changed = piece.sign !== ' ';
    const lineBg = colours && changed ? (piece.sign === '+' ? colours.add : colours.del) : undefined;
    const wordBg = colours && changed ? (piece.sign === '+' ? colours.addWord : colours.delWord) : undefined;
    const fg: Style = !colours && changed ? { fg: piece.sign === '+' ? 'green' : 'red' } : {};
    const base: Style = { ...fg, ...(lineBg ? { bgRgb: lineBg } : {}) };
    // The text in spans: the changed words on their own shade.
    const spans: Span[] = [];
    let at = 0;
    for (const [from, to] of piece.words ?? []) {
      if (from > at) spans.push({ text: piece.text.slice(at, from), style: base });
      spans.push({ text: piece.text.slice(from, to), style: { ...base, ...(wordBg ? { bgRgb: wordBg } : { bold: true }) } });
      at = to;
    }
    if (at < piece.text.length || !spans.length) spans.push({ text: piece.text.slice(at), style: base });
    const number = digits ? (piece.no !== undefined ? String(piece.no).padStart(digits) : ' '.repeat(digits)) + ' ' : '';
    const numberStyle: Style = { ...(lineBg ? { bgRgb: lineBg } : {}), ...(changed && lineBg ? {} : DIM) };
    hardWrap(spans, room).forEach((part, index) => {
      const used = gutter + textWidth(plainText(part));
      lines.push([
        { text: ' '.repeat(MARGIN) + (index ? ' '.repeat(number.length) : number), style: numberStyle },
        { text: index ? '  ' : piece.sign + ' ', style: { ...base, ...(changed ? {} : DIM) } },
        ...part,
        ...(lineBg && used < width ? [{ text: ' '.repeat(width - used), style: { bgRgb: lineBg } }] : []),
      ]);
    });
  }
  return lines;
}

/** Code or output: a panel with an empty left column. */
const codePanel = (text: string, language: string | undefined, width: number, glyph: Glyph): Line[] =>
  panel(highlightLines(text.replace(/\n$/, ''), language).map(spans => ({ spans })), width, glyph);

/** name: value rows, the name dim. A value's own lines stay lines. */
const fieldRows = (fields: Array<[string, string]>): PanelRow[] => fields.flatMap(([name, value]) =>
  value.split('\n').map((line, index) => ({ spans: index ? [{ text: '  ' + line }] : [{ text: name + ': ', style: DIM }, { text: line }] })));

/** Extra arguments as fields. The description is left out: it is already the title. */
function argumentFields(content: InputContent): Array<[string, string]> | undefined {
  if (content.kind !== 'code' || content.label !== '参数') return undefined;
  try {
    const value = JSON.parse(content.text) as Record<string, unknown>;
    return Object.entries(value).filter(([key]) => key !== 'description').map(([key, item]) => [key, typeof item === 'string' ? item : JSON.stringify(item)]);
  } catch { return undefined; }
}

/** One call's input, as one panel. */
function inputLines(contents: InputContent[], width: number, glyph: Glyph): Line[] {
  const rows: PanelRow[] = [];
  const lines: Line[] = [];
  const flush = () => { if (rows.length) lines.push(...panel(rows.splice(0), width, glyph)); };
  for (const content of contents) {
    const fields = argumentFields(content);
    if (fields) { rows.push(...fieldRows(fields)); continue; }
    if (content.kind === 'fields') { rows.push(...fieldRows(content.rows.filter(([name]) => name !== '描述'))); continue; }
    if (content.kind === 'code') { rows.push(...highlightLines(content.text.replace(/\n$/, ''), content.language).map(spans => ({ spans }))); continue; }
    flush();
    for (const file of content.files) {
      if (content.files.length > 1) lines.push(section(file.path));
      lines.push(...diffLines(file, width, glyph));
    }
  }
  flush();
  return lines;
}

/** Output contents as one panel. */
const outputLines = (contents: InputContent[], width: number, glyph: Glyph): Line[] => panel(contents.flatMap((content): PanelRow[] =>
  content.kind === 'fields' ? fieldRows(content.rows)
    : content.kind === 'code' ? highlightLines(content.text.replace(/\n$/, ''), content.language).map(spans => ({ spans }))
    : content.files.flatMap(file => file.lines.map(line => ({ spans: [{ text: line }] })))), width, glyph);

const section = (title: string): Line => [{ text: ' '.repeat(MARGIN) + title, style: { ...DIM, bold: true } }];
const join2 = (blocks: Line[][]): Line[] => blocks.filter(block => block.length).flatMap((block, index) => index ? [[], ...block] : block);

export interface DetailInput {
  session: SessionData;
  group: TurnGroup;
  row: ChapterRow;
  width: number;
  glyph: Glyph;
  /** Which change of the same file, when switched with < >; the row's own by default. */
  edit?: number;
  /** The terminal's background, for the diff's colours. */
  background?: Background;
  /** For an Agent call: the subagent's own session, when its record is there. */
  subagent?: SessionData;
  caps?: Pick<Capabilities, 'symbols' | 'background'>;
  now?: number;
}

/**
 * An Agent call whose subagent kept its own record: that record's one turn, set
 * as a turn page is, with the task (the first lines of it) as the prompt and
 * the answer open. While the subagent runs, the spinner turns at its end.
 */
function subagentDoc(row: ChapterRow, subagent: SessionData, width: number, caps: Pick<Capabilities, 'symbols' | 'background'>, now: number): DetailDoc | undefined {
  const groups = visibleTurnGroups(subagent);
  const group = groups[0];
  if (!group) return undefined;
  const view = turnView(group, true, subagent.provider);
  const running = row.items[0]?.status === 'running';
  const status: PageContext['status'] = running ? { kind: 'running', since: view.turn.start, verb: view.verb } : { kind: 'idle' };
  const lines = turnBody({ session: subagent, groups: [group], index: 0, status, extras: {}, caps, width, now, answerOpen: true, promptMax: 3 });
  const word = running ? 'running' : row.outcome ? outcomeWord(row.outcome) : '';
  return { kind: 'call', title: row.label || 'Agent', meta: ['Agent', word].filter(Boolean).join(' · '),
    copy: { text: view.turn.request ? publicBody(view.turn.request) : row.label, what: '任务' }, lines };
}

export function detailDoc({ session, group, row, width, glyph, edit, background, subagent, caps, now }: DetailInput): DetailDoc | undefined {
  if (subagent && caps) {
    const page = subagentDoc(row, subagent, width, caps, now ?? Date.now());
    if (page) return page;
  }
  const evidence = resolveOutlineEvidence(session, row.id, row.items[0]);
  const records = evidence ? evidence.items ?? [evidence.item] : row.items;
  if (!records.length) return undefined;
  const calls = records.flatMap(record => recordedToolInputs(record));
  const tool = row.tool;
  const word = row.outcome ? outcomeWord(row.outcome) : '';

  // A read of one file, or of the same file several times.
  const reads = records.filter(record => !record.commandInput || !records.some(parent => parent.id === record.commandInput!.itemId)).map(parent => {
    const native = records.find(record => record.commandInput?.itemId === parent.id);
    return (native && fileReading(native)) || fileReading(parent);
  });
  if (reads.length && reads.every(Boolean)) {
    const first = reads[0]!;
    const range = (reading: FileReading) => reading.start !== undefined ? `第 ${reading.start}–${reading.start + reading.lines.length - 1} 行` : `${reading.lines.length} 行`;
    const blocks = reads.map((reading, index) => [...(reads.length > 1 ? [section(`第 ${index + 1} 次读取 · ${range(reading!)}`)] : []), ...fileLines(reading!, width, glyph)]);
    return {
      kind: 'file', title: base(first.path), directory: dir(shown(first.path, session)), path: absolute(first.path, session), line: first.start ?? 1,
      meta: `${tool} · ${reads.length > 1 ? `${reads.length} 次读取` : range(first)}`, copy: { text: absolute(first.path, session), what: '路径' }, lines: join2(blocks),
    };
  }

  // A change: the diff as recorded, and every other change to the same file in this turn.
  const files = recordedFiles(row.items, evidence?.entry);
  if (files.length) {
    const rows = chapterTurn(group).segments.flatMap(segment => segment.kind === 'chapter' ? segment.chapter.rows : []);
    const path = files[0].path;
    const changes = fileChanges(session, rows, path);
    const own = Math.max(0, changes.findIndex(change => change.row.id === row.id));
    const index = Math.max(0, Math.min(changes.length - 1, edit ?? own));
    const current = changes[index] ?? { row, file: files[0] };
    const shownFiles = changes.length ? [current.file] : files;
    const failed = current.row.outcome ? ` · ${outcomeWord(current.row.outcome)}` : '';
    const what = current.file.operation === 'write' ? ` · 写入 ${current.file.lines.length} 行` : '';
    const outputs = current.row.items.flatMap(item => presentEvidence(item).outputs).filter(block => block.label === '修改返回错误' || current.row.outcome);
    return {
      kind: 'diff', title: base(path), directory: dir(shown(path, session)), path: absolute(path, session),
      meta: `${current.row.tool === 'Write' && current.file.operation === 'update' ? 'Edit' : current.row.tool}${changes.length > 1 ? ` · 第 ${index + 1} 次 / 共 ${changes.length} 次` : what}${failed}`,
      copy: { text: absolute(path, session), what: '路径' },
      ...(changes.length > 1 ? { edits: { index, total: changes.length } } : {}),
      lines: join2([
        ...shownFiles.map((file, n) => [...(shownFiles.length > 1 || n ? [[{ text: ' ' + shown(file.path, session), style: { bold: true } } as Span]] : []), ...diffLines(file, width, glyph, background)]),
        outputs.length ? [section('返回'), ...codePanel(outputs.map(block => block.text ?? '').join('\n'), undefined, width, glyph)] : [],
      ]),
    };
  }

  // Anything else: what was asked, and what came back.
  const parents = records.filter(record => !record.commandInput || !records.some(parent => parent.id === record.commandInput!.itemId));
  const blocks = parents.flatMap(record => {
    const natives = records.filter(other => other.commandInput?.itemId === record.id);
    const presentation = presentEvidence(record);
    const outputs = (natives.length ? natives : [record]).flatMap(source => presentEvidence(source).outputs.flatMap(block => toolOutputContents(source, block.text ?? '')));
    const state = parents.length === 1 ? row.outcome : undefined;
    return [
      [...(parents.length > 1 ? [section(describeDisplayAction(record).label)] : []),
        ...(presentation.calls.some(call => call.contents.length) ? [section('输入'), ...presentation.calls.flatMap(call => inputLines(call.contents, width, glyph))] : [])],
      outputs.length ? [section(`返回${state ? ' · ' + outcomeWord(state) : ''}`), ...outputLines(outputs, width, glyph)]
        : [[{ text: ' ' + (record.status === 'running' ? '还没有返回' : '没有记录返回内容'), style: DIM }]],
    ];
  });
  const command = calls.map(call => { const args = call.input as Record<string, unknown>; return typeof args?.command === 'string' ? args.command : typeof args?.cmd === 'string' ? args.cmd : ''; }).filter(Boolean).join('\n');
  return {
    kind: 'call', title: row.label || tool, meta: [tool, word].filter(Boolean).join(' · '),
    copy: command ? { text: command, what: '命令' } : { text: row.label, what: '标签' }, lines: join2(blocks),
  };
}

/** Width check helper for tests and the app: the widest line in cells. */
export const widest = (lines: Line[]): number => Math.max(0, ...lines.map(line => textWidth(plainText(line))));

