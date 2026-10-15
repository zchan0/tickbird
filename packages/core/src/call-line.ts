import type { SessionData } from './model';
import type { ChapterRow } from './chapters';
import type { SessionCall } from './session-state';
import { recordedFiles } from './presentation';
import { resolveOutlineEvidence } from './outline';
import { commandEffects, commandText, exploreText } from './command-line';
import { toolView } from './tool-view';
import { rowView } from './turn-view';

/**
 * A call's line, the same in the terminal and in VS Code: which tool, by the
 * name the agent gives it; the words, from the agent's description or the
 * command itself; and what shows at its end. Each view lays it out in its own
 * room; none of it depends on the width.
 */

const base = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) || path;

const SHELL = /^(Bash|exec_command|shell|local_shell|BashOutput|KillShell|Terminal|Script)$/i;

/**
 * The tool, by the name the agent gives it: Bash, Read, Write. A write that
 * patched a file is an Edit; an MCP tool goes by its own last name.
 */
export function callTool(chapterRow: ChapterRow, session: SessionData): string {
  if (chapterRow.output) return 'Output';
  const tool = chapterRow.tool;
  if (/^Write$/i.test(tool) && changeSize(chapterRow, session)?.edited) return 'Edit';
  if (/^mcp__/.test(tool)) return tool.split('__').at(-1) || tool;
  return tool;
}

/** Edits and writes are what the turn leaves behind: their names read in the body colour, their size on the right. */
export const isChange = (chapterRow: ChapterRow): boolean => !chapterRow.output
  && (/^(Write|Edit|MultiEdit|apply_patch|NotebookEdit)$/i.test(chapterRow.tool) || (chapterRow.items.length > 0 && chapterRow.items.every(item => item.kind === 'file-change')));

/**
 * The words of a call's line: the agent's own description of a command, or
 * the command itself as it reads best, and how many more commands it runs;
 * for other calls, their summary, its first part where it has several.
 */
export function callText(chapterRow: ChapterRow, session: SessionData): { text: string; more: number; command?: boolean } {
  const command = chapterRow.command;
  if (command !== undefined && (SHELL.test(chapterRow.tool) || EXPLORE.test(chapterRow.tool))) {
    // What the command changes and does is read from all of it. The agent's words for it come first; when the
    // command changes files, which its words may leave out, what it changes and does follows them.
    const effects = commandEffects(command, session.projectPath);
    if (chapterRow.description) return effects?.files.length ? { text: `${chapterRow.description} · ${effects.text}`, more: effects.more } : { text: chapterRow.description, more: 0 };
    const explored = exploreText(command, session.projectPath);
    if (explored) return { text: explored.text, more: explored.more, command: true };
    if (effects) return { text: effects.text, more: effects.more };
    const shown = commandText(command, session.projectPath);
    return { text: shown.text || chapterRow.tool, more: shown.more, command: true };
  }
  // A search's queries are joined by ；: the first one reads, the rest are counted.
  const parts = WEB.test(chapterRow.tool) ? chapterRow.label.split('；') : [chapterRow.label];
  const label = parts[0].replace(/^文件变化 · /, '');
  // What was searched or fetched reads like a command: as it was given, on one line.
  return { text: label.replace(/\s+/g, ' ').trim() || chapterRow.tool, more: parts.length - 1, ...(WEB.test(chapterRow.tool) ? { command: true } : {}) };
}

const WEB = /^(WebSearch|WebFetch|WEB|Web)$/;
/** A command that only looked at files, named for the look: its words are worked out from the command. */
const EXPLORE = /^(Read|Search|List)$/;
/** The sources a web search returned, recorded apart from the call. */
const isSources = (chapterRow: ChapterRow): boolean => chapterRow.items.length > 0 && chapterRow.items.every(item => item.title === 'Web 来源');

/**
 * The calls as steps. A shared output and the sources of a search the row
 * before already made are records of a step, not steps: they open from the
 * call, and take no line of their own. Sources with no call before them are
 * the search itself. A file shown again after it changed is no step at all.
 */
export function callSteps(rows: ChapterRow[]): ChapterRow[] {
  const kept: ChapterRow[] = [];
  for (const chapterRow of rows) {
    if (chapterRow.output || isFragment(chapterRow)) continue;
    if (isSources(chapterRow)) {
      if (kept.length && WEB.test(kept.at(-1)!.tool)) continue;
      kept.push({ ...chapterRow, tool: 'WebSearch', label: chapterRow.items[0].summary.replace(/\s*\.\.\.$/, '') });
      continue;
    }
    kept.push(chapterRow);
  }
  return kept;
}

/**
 * A call the agent shows as running, from its hook, before the transcript has
 * it: drawn as its record will be, so nothing moves when the record comes.
 */
export function announcedRow(call: SessionCall, index: number): ChapterRow {
  const view = toolView(call.tool, call.input);
  const command = call.input.command;
  return { id: `announced:${index}:${call.at}`, tool: view.name, label: view.label, count: 1, items: [], running: true, pending: true, output: false, openable: false,
    ...(command !== undefined ? { command } : {}), ...(call.input.description ? { description: call.input.description } : {}), input: call.input };
}

/**
 * A file the agent was shown again because it changed outside its own edits
 * (by a script it ran, or by someone else): a record of the file, not a call.
 */
const isFragment = (chapterRow: ChapterRow): boolean => chapterRow.items.length > 0 && chapterRow.items.every(item => item.title === '记录中的文件片段');

/** Lines added and removed by a recorded change, and whether it wrote a new file. */
const SIZES = new WeakMap<ChapterRow, { added: number; removed: number; edited: boolean } | undefined>();
export function changeSize(chapterRow: ChapterRow, session: SessionData): { added: number; removed: number; edited: boolean } | undefined {
  if (SIZES.has(chapterRow)) return SIZES.get(chapterRow);
  const size = measureChange(chapterRow, session);
  SIZES.set(chapterRow, size);
  return size;
}
function measureChange(chapterRow: ChapterRow, session: SessionData): { added: number; removed: number; edited: boolean } | undefined {
  if (!chapterRow.items.length) return undefined;
  const all = recordedFiles(chapterRow.items, resolveOutlineEvidence(session, chapterRow.id, chapterRow.items[0])?.entry);
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

/** What shows at a call's end: a failure, a search that found nothing, the size of a change, a note. */
export type CallEnd =
  | { kind: 'failed'; word: string; reason: string }
  | { kind: 'empty' }
  | { kind: 'size'; added: number; removed: number }
  | { kind: 'note'; text: string };

/** A call still out shows nothing at its end: it is marked where its tree branches. */
export function callEnd(chapterRow: ChapterRow, session: SessionData, live: boolean): CallEnd | undefined {
  const call = rowView(chapterRow, live);
  if (call.word) return { kind: 'failed', word: call.word, reason: call.reason };
  if (call.empty) return { kind: 'empty' };
  if (call.out) return undefined;
  if (isChange(chapterRow)) {
    const size = changeSize(chapterRow, session);
    if (size && (size.added || size.removed)) return { kind: 'size', added: size.added, removed: size.removed };
  }
  return call.note ? { kind: 'note', text: call.note } : undefined;
}
