import { isAbsolute, join } from 'node:path';
import type { SessionData } from './model';
import type { TurnGroup } from './timeline';
import { chapterTurn, type ChapterRow } from './chapters';
import { resolveOutlineEvidence, visibleTurnGroups } from './outline';
import { fileReading, presentEvidence, recordedFiles, type PatchFile } from './presentation';
import { recordedToolInputs } from './actions';

/**
 * What a call points at, the same in the terminal and in VS Code: the file it
 * read, the change it made line by line, the image it looked at, the address
 * it fetched. Each view opens it its own way.
 */

const base = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) || path;
export const absolute = (path: string, session: SessionData): string => isAbsolute(path) ? path : join(session.projectPath, path);

/** The row a panel's line stands for, and its turn: a call, or a file in Changes (which carries the id of the row that last wrote it). */
export function findRow(session: SessionData, id: string): { group: TurnGroup; row: ChapterRow } | undefined {
  for (const group of visibleTurnGroups(session)) {
    for (const segment of chapterTurn(group).segments) {
      if (segment.kind !== 'chapter') continue;
      const row = segment.chapter.rows.find(candidate => candidate.id === id);
      if (row) return { group, row };
    }
  }
  return undefined;
}

/** The records behind a row: a call and its native execution are one read. */
const sources = (session: SessionData, row: ChapterRow) => {
  const evidence = resolveOutlineEvidence(session, row.id, row.items[0]);
  return { evidence, records: evidence ? evidence.items ?? [evidence.item] : row.items };
};

/** The one file a call read, where it starts and how many lines: to open the file itself there. */
export function fileRead(session: SessionData, row: ChapterRow): { path: string; start?: number; count: number } | undefined {
  if (row.output) return undefined;
  const { records } = sources(session, row);
  const reads = records.filter(record => !record.commandInput || !records.some(parent => parent.id === record.commandInput!.itemId)).map(parent => {
    const native = records.find(record => record.commandInput?.itemId === parent.id);
    return (native && fileReading(native)) || fileReading(parent);
  });
  const first = reads[0];
  if (!first || reads.some(reading => !reading || reading.path !== first.path)) return undefined;
  return { path: absolute(first.path, session), ...(first.start !== undefined ? { start: first.start } : {}), count: first.lines.length };
}

/** What a call changed, as the harness recorded it where it did (real line numbers and context), else as the call asked. */
export function rowChanges(session: SessionData, row: ChapterRow): PatchFile[] {
  if (row.output || fileRead(session, row)) return [];
  const { evidence } = sources(session, row);
  return recordedFiles(row.items, evidence?.entry);
}

export interface DiffRow { sign: ' ' | '+' | '-'; no?: number; text: string; words?: Array<[number, number]> }
export type DiffPiece = DiffRow | { gap: string };

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
export function diffRows(file: PatchFile): DiffPiece[] {
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

