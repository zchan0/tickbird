import type { TimelineItem } from './model';
import type { TurnGroup } from './timeline';
import { actionRowSections, outlineTurn, hasReadableEvidence, type ActionRow, type OutlineNode } from './outline';
import { actionPresentation } from './actions';
import { describeDisplayAction, fileEvidenceId, recordedFiles, shortFileLabels, type PatchFile } from './presentation';
import { commandOutcome, exitReason, type OutcomeKind } from './outcome';
import { commandEffects } from './command-line';

/**
 * A chapter-level reading of one turn. The agent's own commentary heads each
 * chapter; the calls it made follow in source order. Nothing is summarised or
 * generated, and a live stream only ever appends: a record extends the current
 * chapter or opens a new one. Every row keeps the presentation id the outline
 * already resolves, so details and live updates use the existing paths.
 */
export interface RowOutcome { kind: Exclude<OutcomeKind, 'ok'>; exitCode?: number; reason?: string; denial?: string }
export interface ChapterRow {
  id: string;
  tool: string;
  label: string;
  count: number;
  items: TimelineItem[];
  outcome?: RowOutcome;
  running: boolean;
  /** No return recorded yet: in a live turn, the call is still out. */
  pending: boolean;
  /** Shared output of a multi-call wrapper, not a call of its own. */
  output: boolean;
  openable: boolean;
  command?: string;
  /** The agent's own words for what a command does (Claude's Bash description). */
  description?: string;
  /** A quiet word after the label, for a row whose state is not a failure. */
  note?: string;
  /** A question to the user: its options, and what was chosen as the source recorded it. */
  choices?: QuestionChoice[];
}
export interface QuestionChoice { header?: string; question: string; options: string[]; chosen: string[] }
/** Words said back to back, with no call between them, head one chapter together. */
export interface Chapter { key: string; headings: TimelineItem[]; rows: ChapterRow[]; records: TimelineItem[] }
export type TurnSegment =
  | { kind: 'chapter'; chapter: Chapter }
  | { kind: 'answer'; item: TimelineItem }
  | { kind: 'interjection'; item: TimelineItem };
/**
 * A file the turn changed: `id` opens its latest record. `added` and `removed`
 * are the lines its records change; absent when the turn only learned that it
 * changed (a script wrote it, and the agent was shown the file again).
 */
export interface ChangedFile { id: string; path: string; mark: 'A' | 'M' | 'D'; count: number; added?: number; removed?: number }
export interface ChapterTurn {
  request?: TimelineItem;
  /** Phase markers and pending-review notices: kept for the coverage ledger, never shown in the turn. */
  background: TimelineItem[];
  segments: TurnSegment[];
  files: ChangedFile[];
  start?: string;
  durationMs?: number;
  aborted: boolean;
  /** The source closed the turn: an end record, a stop, or a final answer last. */
  ended: boolean;
  /** Latest source timestamp in the turn. */
  lastAt?: string;
}

const invocationArgs = (row: ActionRow): Record<string, unknown> => {
  if (!row.description.key.startsWith('["invocation",')) return {};
  try { return JSON.parse(row.description.key)[2] ?? {}; } catch { return {}; }
};

/** The source's own words decide: a refusal, a stop, an exit code, a status. */
export function rowOutcome(row: ActionRow, command?: string): RowOutcome | undefined {
  // A matched native execution record carries the real status; the call row mirrors it.
  const states = row.items.some(item => item.commandInput) ? row.items.filter(item => item.commandInput) : row.items;
  const denied = states.find(item => item.denial);
  if (denied) return { kind: 'denied', denial: denied.denial };
  if (states.some(item => item.interrupted)) return { kind: 'interrupted' };
  const coded = states.find(item => item.exitCode !== undefined);
  if (coded && command !== undefined) {
    const kind = commandOutcome(command, coded.exitCode);
    if (kind === 'empty') return { kind: 'empty', exitCode: coded.exitCode };
    if (kind === 'failed') return { kind: 'failed', exitCode: coded.exitCode, reason: exitReason(coded.exitCode) };
    if (kind === 'ok' && !states.some(item => item.status === 'failed')) return undefined;
  }
  if (states.some(item => item.status === 'failed')) return { kind: 'failed', ...(coded ? { exitCode: coded.exitCode, reason: exitReason(coded.exitCode) } : {}) };
  return undefined;
}

/** A write is one row per file, each opening that file's own recorded diff — never the wrapper. */
function splitWrite(row: ChapterRow, source: ActionRow): ChapterRow[] {
  if (row.tool !== 'Write' || row.output) return [row];
  const files = recordedFiles(source.items, source.description);
  if (!files.length) return [row];
  const labels = shortFileLabels(files.map(file => file.path));
  return files.map((file, index) => ({ ...row, id: fileEvidenceId(source.id, index, file.path), label: labels[index], count: 1 }));
}

function chapterRows(node: Extract<OutlineNode, { kind: 'actions' }>): ChapterRow[] {
  return actionRowSections(node).flatMap(section => section.rows).flatMap(row => {
    const args = invocationArgs(row);
    const command = typeof args.cmd === 'string' ? args.cmd : typeof args.command === 'string' ? args.command : undefined;
    const description = command !== undefined && typeof args.description === 'string' ? args.description.replace(/\s+/g, ' ').trim() : '';
    // Same naming as the product's action rows: a Web source result is WEB, not a tool call.
    const presentation = actionPresentation(row.description);
    const source = row.description.toolName === 'Web 来源';
    const tool = source ? presentation.type : row.description.toolName || presentation.type;
    const label = (source ? row.description.label.replace(/^Web · /, '')
      : row.description.toolName ? row.description.label : presentation.label || row.description.label).replace(/\s+/g, ' ').trim();
    const outcome = row.role === 'output' ? undefined : rowOutcome(row, command);
    return splitWrite({
      id: row.id, tool, label, count: row.count, items: row.items, output: row.role === 'output',
      running: row.items.some(item => item.status === 'running'),
      pending: row.role !== 'output' && !outcome && row.items.every(item => item.result === 'not-observed' && !['failed', 'completed'].includes(item.status)),
      openable: row.items.some(hasReadableEvidence),
      ...(outcome ? { outcome } : {}), ...(command !== undefined ? { command } : {}), ...(description ? { description } : {}),
    }, row);
  });
}

/**
 * A path a command or a fragment names that is no file of the work: one
 * under a temporary folder (the agent's scratch files), or behind a shell
 * variable the record cannot expand. A Write or an Edit always counts.
 */
const scratch = (path: string): boolean => /\$|^\/(private\/)?(tmp|var\/folders)\/|\/scratchpad\//.test(path);

/** The lines a recorded change adds and removes: a whole new file is all added. */
function lineCounts(file: PatchFile): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of file.lines) {
    if (file.operation === 'write' || file.operation === 'add' && !/^[+\- ]/.test(line)) added++;
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

/**
 * Paths changed this turn, first-seen order, with how often each was touched
 * and the lines changed. A file the agent was shown again because it changed
 * outside its own edits (by a script it ran) counts too, without line counts.
 */
function changedFiles(nodes: OutlineNode[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  // A command names a file as it runs (docs/TODO.md, ~/x); a record, by its full path. They are one file when one path ends the other.
  const known = (path: string): ChangedFile | undefined => {
    if (byPath.has(path)) return byPath.get(path);
    const tail = (value: string) => value.replace(/^~\//, '/').replace(/^\.\//, '/').replace(/^(?!\/)/, '/');
    for (const file of byPath.values()) if (file.path.endsWith(tail(path)) || path.endsWith(tail(file.path))) return file;
    return undefined;
  };
  for (const node of nodes) {
    if (node.kind !== 'actions') continue;
    for (const row of actionRowSections(node).flatMap(section => section.rows)) {
      // A command changes files too: those it names (a script's writes, sed -i, > file…), without line counts.
      const args = invocationArgs(row);
      const command = typeof args.cmd === 'string' ? args.cmd : typeof args.command === 'string' ? args.command : undefined;
      if (command !== undefined && row.description.toolName !== 'Write' && row.description.toolName !== 'Edit') {
        for (const file of commandEffects(command, '', '')?.files ?? []) {
          if (scratch(file.path)) continue;
          const existing = known(file.path);
          if (existing) { if (file.deleted) existing.mark = 'D'; continue; }
          byPath.set(file.path, { id: row.id, path: file.path, mark: file.deleted ? 'D' : 'M', count: 1 });
        }
        continue;
      }
      const writes = row.items.every(item => item.kind === 'file-change') || row.description.toolName === 'Write' || row.description.toolName === 'Edit';
      if (!writes) continue;
      if (row.items.length && row.items.every(item => item.title === '记录中的文件片段')) {
        for (const item of row.items) if (item.summary && !scratch(item.summary) && !known(item.summary)) byPath.set(item.summary, { id: row.id, path: item.summary, mark: 'M', count: 1 });
        continue;
      }
      recordedFiles(row.items, row.description).forEach((file: PatchFile, index) => {
        const counts = lineCounts(file);
        const existing = known(file.path);
        // The latest record opens: that is the state the turn left the file in.
        if (existing) {
          existing.count++; existing.id = fileEvidenceId(row.id, index, file.path);
          if (file.operation === 'delete') existing.mark = 'D';
          // A file first known from a fragment gets its counts once a record has them.
          existing.added = (existing.added ?? 0) + counts.added; existing.removed = (existing.removed ?? 0) + counts.removed;
          return;
        }
        // A file the turn made is new however often it is written after.
        const made = file.operation === 'add' || row.items.some(item => item.fileOperation === 'create');
        byPath.set(file.path, { id: fileEvidenceId(row.id, index, file.path), path: file.path, count: 1,
          mark: made ? 'A' : file.operation === 'delete' ? 'D' : 'M', ...counts });
      });
    }
  }
  return [...byPath.values()];
}

const pendingReview = (item: TimelineItem) => item.kind === 'notice' && item.title.startsWith('待核对');

const parsed = (text?: string): Record<string, unknown> => { try { const value = JSON.parse(text ?? ''); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };

/** Each question's options, and the ones chosen, from the call's own input and the recorded answers. */
function questionChoices(item: TimelineItem): QuestionChoice[] | undefined {
  const block = (label: string) => item.detail?.blocks.find(candidate => candidate.label === label)?.text;
  const input = parsed(block('当时调用参数')), recorded = parsed(block('问题及记录的回答'));
  const questions = (Array.isArray(input.questions) ? input.questions : Array.isArray(recorded.questions) ? recorded.questions : []) as Array<Record<string, unknown>>;
  const answers = (recorded.answers && typeof recorded.answers === 'object' ? recorded.answers : {}) as Record<string, unknown>;
  const choices = questions.map(question => {
    const text = typeof question.question === 'string' ? question.question : '';
    const options = (Array.isArray(question.options) ? question.options : []).map(option => typeof option === 'string' ? option : String((option as { label?: unknown })?.label ?? '')).filter(Boolean);
    const answer = answers[text];
    const said = Array.isArray(answer) ? answer.map(String) : typeof answer === 'string' && answer ? [answer] : [];
    // A multi-select answer is one string; a typed answer is not one of the options.
    const chosen = said.flatMap(value => options.includes(value) ? [value] : question.multiSelect ? value.split(/,\s*/) : [value]).filter(Boolean);
    return { ...(typeof question.header === 'string' && question.header ? { header: question.header } : {}), question: text, options, chosen };
  }).filter(choice => choice.question || choice.options.length);
  return choices.length ? choices : undefined;
}

/**
 * A question to the user or a subagent is a call the agent made, recorded as
 * its own kind. It reads as a row in its place, not after the calls around it.
 */
function callRecordRow(item: TimelineItem): ChapterRow {
  const description = describeDisplayAction(item), entry = description.entries[0];
  const tool = entry?.toolName || (item.kind === 'question' ? 'Ask' : 'Agent');
  const label = (entry?.label || description.label || item.title).replace(/\s+/g, ' ').trim();
  const outcome = rowOutcome({ id: item.id, description: entry ?? { label, key: item.id, count: 1 }, items: [item], count: 1 });
  const choices = item.kind === 'question' ? questionChoices(item) : undefined;
  const answered = Boolean(choices?.some(choice => choice.chosen.length));
  return { id: item.id, tool, label, count: 1, items: [item], output: false, openable: hasReadableEvidence(item),
    running: item.status === 'running', pending: !answered && item.result === 'not-observed' && !['failed', 'completed'].includes(item.status),
    ...(outcome ? { outcome } : {}), ...(choices ? { choices } : {}) };
}

/** A background task reporting back reads as the call it finished. */
function notificationRow(item: TimelineItem): ChapterRow {
  const outcome: RowOutcome | undefined = item.interrupted ? { kind: 'interrupted' } : item.status === 'failed'
    ? { kind: 'failed', ...(item.exitCode !== undefined ? { exitCode: item.exitCode, reason: exitReason(item.exitCode) } : {}) } : undefined;
  return { id: item.id, tool: item.taskTool ?? 'Task', label: item.title, count: 1, items: [item], running: false, pending: false, output: false,
    openable: hasReadableEvidence(item), ...(outcome ? { outcome } : { note: /^Stopped watching\b/.test(item.summary) ? 'stopped' : 'done' }) };
}

const time = (value?: string) => { const ms = value ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : undefined; };

export function chapterTurn(group: TurnGroup): ChapterTurn {
  const outline = outlineTurn(group);
  const order = new Map(group.items.map((item, index) => [item, index]));
  const firstIndex = (node: OutlineNode) => order.get(node.kind === 'actions' ? node.items[0] : node.item) ?? 0;
  const requests = outline.background.filter(item => item.kind === 'request');
  const [request, ...later] = requests;
  // Later requests in the same turn are the reader's own interjections: keep them where they happened.
  const placed: Array<{ at: number; node?: OutlineNode; interjection?: TimelineItem }> = [
    ...outline.nodes.map(node => ({ at: firstIndex(node), node })),
    ...later.map(item => ({ at: order.get(item) ?? 0, interjection: item })),
  ].sort((a, b) => a.at - b.at);

  const segments: TurnSegment[] = [];
  const background = outline.background.filter(item => item.kind !== 'request');
  let chapter: Chapter | undefined;
  const open = (heading?: TimelineItem) => {
    chapter = { key: `chapter:${heading?.id ?? group.key + ':lead'}`, headings: heading ? [heading] : [], rows: [], records: [] };
    segments.push({ kind: 'chapter', chapter });
    return chapter;
  };
  for (const entry of placed) {
    if (entry.interjection) { segments.push({ kind: 'interjection', item: entry.interjection }); chapter = undefined; continue; }
    const node = entry.node!;
    if (node.kind === 'narrative') {
      // A thinking summary and the commentary right after it are one step, not two.
      if (chapter?.headings.length && !chapter.rows.length && !chapter.records.length) chapter.headings.push(node.item);
      else open(node.item);
      continue;
    }
    if (node.kind === 'record' && node.item.kind === 'answer') { segments.push({ kind: 'answer', item: node.item }); chapter = undefined; continue; }
    // A notice that only says "this source shape is not yet supported" is ledger
    // material: it stays in the turn, folded, not between the agent's steps.
    if (node.kind === 'record' && pendingReview(node.item)) { background.push(node.item); continue; }
    if (node.kind === 'record' && node.item.noticeType === 'task-notification') { (chapter ?? open()).rows.push(notificationRow(node.item)); continue; }
    if (node.kind === 'record' && (node.item.kind === 'question' || node.item.kind === 'subagent')) { (chapter ?? open()).rows.push(callRecordRow(node.item)); continue; }
    const target = chapter ?? open();
    if (node.kind === 'actions') target.rows.push(...chapterRows(node));
    else target.records.push(node.item);
  }

  const stamps = group.items.map(item => time(item.timestamp)).filter((ms): ms is number => ms !== undefined);
  const begin = outline.boundaries.find(item => item.title === '回合开始');
  const end = [...outline.boundaries].reverse().find(item => item.title === '回合结束');
  const closed = group.items.some(item => item.kind === 'notice' && ['回合结束', '回合中断'].includes(item.title));
  const startMs = time(begin?.timestamp) ?? (stamps.length ? Math.min(...stamps) : undefined);
  const endMs = time(end?.timestamp) ?? (stamps.length ? Math.max(...stamps) : undefined);
  const rows = segments.flatMap(segment => segment.kind === 'chapter' ? segment.chapter.rows : []);
  return {
    ...(request ? { request } : {}),
    background,
    segments,
    files: changedFiles(outline.nodes),
    ...(startMs !== undefined ? { start: new Date(startMs).toISOString() } : {}),
    // The harness's own measured duration wins over a timestamp span.
    ...(end?.durationMs !== undefined ? { durationMs: end.durationMs }
      : startMs !== undefined && endMs !== undefined && endMs >= startMs ? { durationMs: endMs - startMs } : {}),
    aborted: group.items.some(item => item.kind === 'notice' && item.title === '回合中断'),
    ended: closed || segments.at(-1)?.kind === 'answer',
    ...(stamps.length ? { lastAt: new Date(Math.max(...stamps)).toISOString() } : {}),
  };
}
