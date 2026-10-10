import { isAbsolute, join } from 'node:path';
import type { SessionData } from '../../../core/src/model';
import type { TurnGroup } from '../../../core/src/timeline';
import { resolveOutlineEvidence } from '../../../core/src/outline';
import { describeDisplayAction, fileLanguage, fileReading, presentEvidence, recordedFiles, toolOutputContents, type FileReading, type InputContent, type PatchFile } from '../../../core/src/presentation';
import { chapterTurn, type ChapterRow } from '../../../core/src/chapters';
import { outcomeWord } from '../../../core/src/turn-view';
import { recordedToolInputs } from '../../../core/src/actions';
import { plainText, type Line, type Span, type Style } from '../screen';
import { textWidth } from '../width';
import { hardWrap, highlightLines } from './code';
import type { Glyph } from './prose';

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
const base = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) || path;
const dir = (path: string) => { const parts = path.replace(/\\/g, '/').split('/'); parts.pop(); return parts.length ? parts.join('/') + '/' : ''; };
const absolute = (path: string, session: SessionData) => isAbsolute(path) ? path : join(session.projectPath, path);
/** A path inside the project reads relative to it. */
const shown = (path: string, session: SessionData) => {
  const full = absolute(path, session), root = session.projectPath.replace(/\/$/, '') + '/';
  return full.startsWith(root) ? full.slice(root.length) : full;
};

/**
 * Every detail is made of panels of one shape: a left column, a bar, the text.
 * The left column holds a line number, a + or -, or nothing. Long lines wrap
 * under the bar with an empty left column.
 */
export interface PanelRow { mark?: string; markStyle?: Style; spans: Span[] }
const GUTTER = 4;

export function panel(rows: PanelRow[], width: number, glyph: Glyph): Line[] {
  const gutter = Math.max(GUTTER, ...rows.map(row => textWidth(row.mark ?? '')));
  const bar = glyph('│');
  const room = Math.max(8, width - gutter - 4);
  return rows.flatMap(row => (row.spans.length ? hardWrap(row.spans, room) : [[]]).map((part, piece) => [
    { text: ' ' + (piece ? '' : row.mark ?? '').padStart(gutter), style: row.markStyle ?? DIM },
    { text: ` ${bar} `, style: DIM }, ...part,
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

interface DiffRow { sign: ' ' | '+' | '-'; no?: number; text: string; words?: Array<[number, number]> }
type DiffPiece = DiffRow | { gap: string };

/** Where two lines differ, as character ranges of each, word by word; nothing when they share too little to compare. */
export function changedWords(before: string, after: string): { before: Array<[number, number]>; after: Array<[number, number]> } | undefined {
  const split = (text: string) => text.match(/\w+|\s+|[^\w\s]/g) ?? [];
  const a = split(before), b = split(after);
  if (!a.length || !b.length || a.length * b.length > 40_000) return undefined;
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const keptA = new Set<number>(), keptB = new Set<number>();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { keptA.add(i++); keptB.add(j++); } else if (table[i + 1][j] >= table[i][j + 1]) i++; else j++;
  }
  const same = [...keptA].reduce((n, i) => n + a[i].length, 0);
  // Mostly rewritten: the whole line is the change, as Claude Code shows it.
  if (same < Math.max(before.length, after.length) * 0.4) return undefined;
  const ranges = (tokens: string[], kept: Set<number>) => {
    const out: Array<[number, number]> = [];
    let at = 0;
    tokens.forEach((token, index) => {
      if (!kept.has(index) && token.trim()) { const last = out.at(-1); if (last && last[1] === at) last[1] = at + token.length; else out.push([at, at + token.length]); }
      at += token.length;
    });
    return out;
  };
  return { before: ranges(a, keptA), after: ranges(b, keptB) };
}

/** A recorded change's lines, numbered where the record says where they are, the words that changed in a replaced line marked. */
function diffRows(file: PatchFile): DiffPiece[] {
  if (file.operation === 'write') return file.lines.map((text, index) => ({ sign: '+' as const, no: index + 1, text }));
  const pieces: DiffPiece[] = [];
  let oldNo: number | undefined, newNo: number | undefined;
  for (const raw of file.lines) {
    if (raw.startsWith('@@')) {
      const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
      oldNo = at ? Number(at[1]) : undefined; newNo = at ? Number(at[2]) : undefined;
      // Between hunks, a gap; the first hunk needs none.
      if (pieces.length || (at ? at[3] : raw.replace(/^@@\s*/, ''))) pieces.push({ gap: at ? at[3] : raw.replace(/^@@\s*/, '') });
      continue;
    }
    const sign = raw[0] === '+' || raw[0] === '-' ? raw[0] : ' ';
    const text = sign !== ' ' || raw[0] === ' ' ? raw.slice(1) : raw;
    const no = sign === '-' ? oldNo : newNo;
    if (sign !== '+' && oldNo !== undefined) oldNo++;
    if (sign !== '-' && newNo !== undefined) newNo++;
    pieces.push({ sign, ...(no !== undefined ? { no } : {}), text });
  }
  // A run of removed lines followed by added ones: the k-th of each are the same line, changed.
  for (let i = 0; i < pieces.length;) {
    const removed: DiffRow[] = [], added: DiffRow[] = [];
    let j = i;
    while (j < pieces.length && 'sign' in pieces[j] && (pieces[j] as DiffRow).sign === '-') removed.push(pieces[j++] as DiffRow);
    while (j < pieces.length && 'sign' in pieces[j] && (pieces[j] as DiffRow).sign === '+') added.push(pieces[j++] as DiffRow);
    if (removed.length && added.length) for (let k = 0; k < Math.min(removed.length, added.length); k++) {
      const words = changedWords(removed[k].text, added[k].text);
      if (words) { removed[k].words = words.before; added[k].words = words.after; }
    }
    i = j > i ? j : i + 1;
  }
  return pieces;
}

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
  const gutter = 1 + (digits ? digits + 1 : 0) + 2;
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
        { text: ' ' + (index ? ' '.repeat(number.length) : number), style: numberStyle },
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

const section = (title: string): Line => [{ text: ' ' + title, style: { ...DIM, bold: true } }];
const join2 = (blocks: Line[][]): Line[] => blocks.filter(block => block.length).flatMap((block, index) => index ? [[], ...block] : block);

/** A call that may have changed a file: only these are looked up for the other changes to it. */
const CHANGES = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file)$/i;
const mayChange = (row: ChapterRow): boolean => !row.output
  && (CHANGES.test(row.tool) || row.items.some(item => item.kind === 'file-change'));

/** Every change to `path` in the turn, in order, as (row, file) pairs. */
function changesOf(path: string, rows: ChapterRow[], session: SessionData): Array<{ row: ChapterRow; file: PatchFile }> {
  return rows.filter(mayChange).flatMap(row => recordedFiles(row.items, resolveOutlineEvidence(session, row.id, row.items[0])?.entry).filter(file => file.path === path).map(file => ({ row, file })));
}

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
}

export function detailDoc({ session, group, row, width, glyph, edit, background }: DetailInput): DetailDoc | undefined {
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
    const changes = changesOf(path, rows, session);
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

/** An image a call read, as the transcript kept it: its bytes where recorded, else the path it was read from. */
export interface RecordedImage { name: string; data?: string; mime?: string; path?: string }

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)$/i;

/**
 * The image a call only read, to open in the system's viewer rather than as
 * a page of its path: the bytes of the time when the transcript has them.
 */
export function recordedImage(session: SessionData, row: ChapterRow): RecordedImage | undefined {
  if (row.output || !/^(Read|view_image|view|NotebookRead)$/i.test(row.tool)) return undefined;
  const evidence = resolveOutlineEvidence(session, row.id, row.items[0]);
  const records = evidence ? evidence.items ?? [evidence.item] : row.items;
  const input = records.flatMap(record => recordedToolInputs(record)).map(call => call.input as Record<string, unknown>)[0] ?? {};
  const path = [input.file_path, input.path].find((value): value is string => typeof value === 'string');
  const block = records.flatMap(record => record.detail?.blocks ?? []).find(candidate => candidate.kind === 'image' && candidate.data);
  if (block?.data) return { name: base(path ?? `image.${(block.mime ?? 'image/png').split('/')[1]}`), data: block.data, ...(block.mime ? { mime: block.mime } : {}), ...(path ? { path: absolute(path, session) } : {}) };
  return path && IMAGE_FILE.test(path) ? { name: base(path), path: absolute(path, session) } : undefined;
}

/** Calls whose detail says what a link could not: the file as read, the diff, the command and its output, the results. */
const HAS_DETAIL = /^(Read|view|view_image|NotebookRead|Edit|MultiEdit|Write|NotebookEdit|apply_patch|edit_file|write_file|Bash|exec_command|shell|local_shell|BashOutput|KillShell|Terminal|Script|Grep|Glob|LS|WebSearch|Web|WEB|WebFind|ToolSearch|Ask|AskUserQuestion|Agent|Task|TodoWrite|Skill)$/i;
const URL_AT = /https?:\/\/[^\s"'<>)\]]+/;

/**
 * Where a call points, to open instead of a page about it: the first web
 * address in what the call shows, in its input, or in what came back; else a
 * local file it was given. Calls with a detail of their own keep it.
 */
export function callLink(session: SessionData, row: ChapterRow): { target: string; name: string } | undefined {
  if (row.output || HAS_DETAIL.test(row.tool)) return undefined;
  const evidence = resolveOutlineEvidence(session, row.id, row.items[0]);
  const records = evidence ? evidence.items ?? [evidence.item] : row.items;
  const input = records.flatMap(record => recordedToolInputs(record)).map(call => (call.input ?? {}) as Record<string, unknown>)[0] ?? {};
  const returned = records.flatMap(record => presentEvidence(record).outputs.map(block => block.text ?? '')).join('\n');
  const url = [row.label, typeof input.url === 'string' ? input.url : '', returned].map(text => URL_AT.exec(text)?.[0]).find(Boolean);
  if (url) return { target: url.replace(/[.,;:]+$/, ''), name: url.replace(/^https?:\/\//, '').split(/[/?#]/)[0] };
  const path = [input.file_path, input.path].find((value): value is string => typeof value === 'string' && value.startsWith('/'));
  return path ? { target: path, name: base(path) } : undefined;
}

/** Width check helper for tests and the app: the widest line in cells. */
export const widest = (lines: Line[]): number => Math.max(0, ...lines.map(line => textWidth(plainText(line))));

