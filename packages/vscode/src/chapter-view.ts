import type { TimelineItem } from '../../core/src/model';
import type { TurnGroup } from '../../core/src/timeline';
import type { ChapterRow, ChangedFile } from '../../core/src/chapters';
import { clock, duration, rowView, runStarts, turnView } from '../../core/src/turn-view';
import { renderMarkdown } from './markdown';
import type { Provider } from '../../core/src/model';

/**
 * One turn as chapters: the agent's own commentary heads each chapter and the
 * calls it made follow in source order. Rows are `button[data-item-id]`, so a
 * click takes the same path to the editor-area detail as every other row.
 * Every block keeps a `data-observation-key` for the live morph.
 */
export interface ChapterRenderers {
  publicBody(item: TimelineItem): string;
  request(item: TimelineItem): string;
  record(item: TimelineItem): string;
  answer(item: TimelineItem): string;
  /** Images and other blocks that came with the agent's words. */
  attachments(item: TimelineItem): string;
  /** Why a row cannot be opened, in the product's existing words. */
  unavailable(items: TimelineItem[]): string;
}

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

// Machine strings (paths, patterns, identifiers) and the agent's prose are two voices.
const MACHINE = new Set(['Read', 'Write', 'Edit', 'Skill', 'Instructions', 'Memory', 'Grep', 'Glob', 'ToolSearch', 'WebFetch']);

function rowHtml(row: ChapterRow, lead: boolean, render: ChapterRenderers, key: string, live: boolean): string {
  const state = row.outcome ? row.outcome.kind === 'empty' ? 'empty' : 'failed' : row.running ? 'running' : 'info';
  // In the live turn a call without a return is still out: its arrow moves, the
  // label stays still. Elsewhere a missing return only means none was recorded.
  const view = rowView(row, live);
  const out = view.out ? ' data-out' : '';
  const note = view.note ? `<i class="cnone">${escapeHtml(view.note)}</i>` : '';
  const { word, reason: exit, label, tool } = view;
  const voice = row.output || MACHINE.has(row.tool) ? 'machine' : 'prose';
  // A question shows what was chosen under it; waiting in a live turn says so.
  const answer = !view.choices ? '' : view.choices.map(choice => `<span class="cchoices">${choice.header ? `<i class="cq">${escapeHtml(choice.header)}</i>` : ''}`
    + (choice.chosen.length ? choice.chosen.map(value => `<b class="cchoice">✓ ${escapeHtml(value)}</b>`).join('')
      : choice.waiting ? '<i class="cq">等待你的选择</i>' : '')
    + '</span>').join('');
  const copy = `<span class="ctool"${lead && tool.length > 7 ? ` title="${escapeHtml(tool)}"` : ''}>${lead ? escapeHtml(tool) : ''}</span>`
    + `<span class="clabel ${voice}${answer ? ' asked' : ''}">${word ? `<b class="cbad">${word}</b> · ` : ''}${escapeHtml(label)}${answer}`
    + `${view.count > 1 ? `<i class="crep"> · ${view.count} 次</i>` : ''}`
    + `${view.empty ? '<i class="cnone">no match</i>' : ''}`
    + `${note}</span>`;
  // The state stays in the tooltip; on the row it is the label's shimmer, not a word.
  const title = [row.tool, label, word, exit, row.running || out ? '进行中' : '', row.openable ? '在编辑器里打开记录' : render.unavailable(row.items)].filter(Boolean).join(' · ');
  const body = row.openable
    ? `<button type="button" class="crow node-button" data-item-id="${escapeHtml(row.id)}" data-tool="${escapeHtml(tool)}" data-status="${state}"${out} aria-pressed="false" title="${escapeHtml(title)}">${copy}<span class="cgo" aria-hidden="true">→</span></button>`
    : `<div class="crow" data-tool="${escapeHtml(tool)}" data-status="${state}"${out} role="group" aria-label="${escapeHtml(title)}">${copy}${out ? '<span class="cgo" aria-hidden="true">→</span>' : '<span></span>'}</div>`;
  return `<li class="crow-item" data-observation-key="${escapeHtml(key)}">${body}</li>`;
}

/** A tool name is written once per run of the same tool; the column stays aligned. */
/** Keyed by position in the chapter, not by row id: rows only ever append, while an
 *  id changes whenever a repeated call raises the count. Position keeps the node,
 *  so a live update rewrites its text in place instead of replacing the row. */
function rowsHtml(rows: ChapterRow[], render: ChapterRenderers, chapterKey: string, live: boolean): string {
  const leads = runStarts(rows);
  return rows.map((row, index) => rowHtml(row, leads[index], render, `${chapterKey}#${index}`, live)).join('');
}

function filesHtml(files: ChangedFile[], turnKey: string): string {
  if (!files.length) return '';
  const base = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) || path;
  const row = (file: ChangedFile) => `<li data-observation-key="${escapeHtml(file.id)}"><button type="button" class="cfile node-button" data-item-id="${escapeHtml(file.id)}" aria-pressed="false" title="${escapeHtml(file.path)}">`
    + `<span class="cmark" data-mark="${file.mark}">${file.mark}</span><span class="cname">${escapeHtml(base(file.path))}</span>`
    + `<span class="ccount">${file.count > 1 ? file.count + ' 次' : ''}</span><span class="cgo" aria-hidden="true">→</span></button></li>`;
  const [shown, rest] = [files.slice(0, 4), files.slice(4)];
  return `<section class="changed" aria-label="本轮改动的文件"><div class="kicker">Changed</div><ol class="cfiles">${shown.map(row).join('')}</ol>`
    + (rest.length ? `<details class="cfiles-more" data-action-group="changed:${escapeHtml(turnKey)}"><summary data-action-group="changed:${escapeHtml(turnKey)}">全部 ${files.length} 个文件</summary><ol class="cfiles">${rest.map(row).join('')}</ol></details>` : '')
    + '</section>';
}

/**
 * What the integration hooks add to the newest turn: the approval the agent is
 * waiting for, and text already on screen but not yet in the transcript.
 */
export interface LiveExtras { approval?: { tool: string; summary: string }; draft?: string }

/** A path names its file; anything else is kept, shortened by the row's own ellipsis. */
const waitingFor = ({ tool, summary }: { tool: string; summary: string }): string =>
  [tool, /^\/.+\/[^/]+$/.test(summary) ? summary.split('/').at(-1) : summary].filter(Boolean).join(' ');

/** `latest` marks the newest turn: only it can still be running. */
export function renderChapterTurn(group: TurnGroup, render: ChapterRenderers, latest = false, provider?: Provider, extras: LiveExtras = {}): string {
  const view = turnView(group, latest, provider);
  const { turn, live, label } = view;
  const segmentHtml = (segment: typeof turn.segments[number]) => {
    if (segment.kind === 'answer') return `<li class="cseg" data-observation-key="${escapeHtml(segment.item.id)}">${render.answer(segment.item)}</li>`;
    if (segment.kind === 'interjection') return `<li class="cseg interjection" data-observation-key="${escapeHtml(segment.item.id)}"><div class="kicker">你的消息</div>${render.request(segment.item)}</li>`;
    const { chapter } = segment;
    // The agent's own words are shown in full, never clamped.
    const say = chapter.headings.map(heading => `<div class="csay" data-observation-key="say:${escapeHtml(heading.id)}" data-text-id="${escapeHtml(heading.id)}" data-status="${escapeHtml(heading.status)}">`
      + `${heading.status === 'failed' ? '<span class="availability">失败</span>' : ''}${renderMarkdown(render.publicBody(heading))}${render.attachments(heading)}</div>`).join('');
    return `<li class="chapter${chapter.headings.length ? '' : ' silent'}" data-observation-key="${escapeHtml(chapter.key)}">${say}`
      + (chapter.rows.length ? `<ol class="crows">${rowsHtml(chapter.rows, render, chapter.key, live)}</ol>` : '')
      + (chapter.records.length ? `<ol class="nodes">${chapter.records.map(render.record).join('')}</ol>` : '')
      + '</li>';
  };
  // Waiting for the reader keeps the turn open, whatever its record clock says.
  const waiting = latest && !turn.ended && extras.approval;
  const open = live || Boolean(waiting);
  // Once a turn is over its whole process folds into the line the agents print
  // ("Crunched for 3m 12s"); the request, the files and the final answer stay.
  const process = open ? turn.segments : view.process;
  const answers = open ? [] : view.answers;
  const { calls } = view;
  const stream = process.map(segmentHtml).join('');
  // One status line while the turn runs, as the agents show it. The clock counts
  // from the start of the turn, the same point Claude Code and Codex time from.
  const { verb } = view;
  // Waiting for the reader replaces the status word: the agent is not working.
  const tail = waiting
    ? `<li class="cseg live-tail awaiting" data-observation-key="live-tail:${escapeHtml(group.key)}"><div class="ctail"><span class="cwait">等你批准</span>`
      + `${waitingFor(waiting) ? ` · <span class="cwait-what">${escapeHtml(waitingFor(waiting))}</span>` : ''}</div></li>`
    : live
    ? `<li class="cseg live-tail" data-observation-key="live-tail:${escapeHtml(group.key)}"><div class="ctail"><span class="shimmer" data-live-verb="${verb}">${verb}</span><span data-since="${escapeHtml(turn.start ?? turn.lastAt)}"></span></div></li>` : '';
  // On screen in the agent, not yet in the transcript: shown faint until the record arrives.
  const draft = live && extras.draft
    ? `<li class="cseg cdraft-item" data-observation-key="draft:${escapeHtml(group.key)}"><div class="cdraft" title="Agent 正在显示，还没写入会话记录">${renderMarkdown(extras.draft)}</div></li>` : '';
  return `<section class="turn-panel chapter-turn tw-${view.toolWidth}" data-turn-panel="${escapeHtml(group.key)}"${live ? ` data-last-at="${escapeHtml(turn.lastAt)}"` : ''} aria-label="${label}">`
    + `<header class="turn-heading"><span class="tclock">${clock(turn.start)}</span><span class="tlabel">${label}</span>${turn.aborted ? '<span class="tstop">中断</span>' : live ? '<span class="tstop tidle">已停止</span>' : ''}<span class="tdur">${duration(turn.durationMs)}</span></header>`
    + (turn.request ? render.request(turn.request) : '')
    + filesHtml(turn.files, group.key)
    + (open || !process.length ? `<ol class="cstream${view.chapters > 1 ? ' tracked' : ''}${tail ? ' live' : ''}">${stream}${draft}${tail}</ol>`
      : `<details class="cprocess" data-fold="process:${escapeHtml(group.key)}"><summary>`
        + `<span class="cdone">${view.done}</span>`
        + `${calls ? `<span class="ccount-calls"> · ${calls} ${calls === 1 ? 'call' : 'calls'}</span>` : ''}<span class="cfold-arrow" aria-hidden="true">›</span></summary>`
        + `<ol class="cstream${view.chapters > 1 ? ' tracked' : ''}">${stream}</ol></details>`)
    + (answers.length ? `<ol class="cstream">${answers.map(segmentHtml).join('')}</ol>` : '')
    + (turn.segments.length || tail ? '' : '<p class="empty">暂未取得本轮过程。</p>')
    + `<div class="turn-content-end" aria-hidden="true"></div></section>`;
}

/** Colours come only from the VS Code theme; greys are mixed from it. */
export const chapterStyles = `
  .chapter-turn { --ink-3: color-mix(in srgb, var(--vscode-foreground) 72%, transparent); --ink-4: color-mix(in srgb, var(--vscode-foreground) 58%, transparent);
    --hair: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); --mono: var(--vscode-editor-font-family, ui-monospace, monospace); --tw: 6ch; }
  ${Array.from({ length: 5 }, (_, index) => `.chapter-turn.tw-${index + 3} { --tw: ${index + 3 + 1}ch; }`).join(' ')}
  .chapter-turn .turn-heading { justify-content: flex-start; gap: 8px; font: 10.5px/1.6 var(--mono); color: var(--ink-4); }
  .chapter-turn .tdur { margin-left: auto; }
  .chapter-turn .tstop { color: var(--ink-3); }
  .chapter-turn .kicker { font: 9.5px/1.8 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-4); }
  .changed { margin: 0 0 16px; padding-bottom: 10px; border-bottom: 1px solid var(--hair); }
  .cfiles { list-style: none; margin: 2px 0 0; padding: 0; }
  .cfile { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto 14px; align-items: baseline; gap: 8px; width: 100%; padding: 2px 4px; margin: 0 -4px; border: 0; border-radius: 4px; background: transparent; text-align: left; }
  .cmark { font: 10px/1.7 var(--mono); color: var(--ink-4); }
  .cmark[data-mark="A"] { color: var(--vscode-charts-green, var(--vscode-foreground)); }
  .cmark[data-mark="D"] { color: var(--vscode-errorForeground); }
  .cname { font: 11px/1.7 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ccount { font: 10px/1.7 var(--mono); color: var(--ink-4); }
  .cfiles-more > summary { cursor: pointer; font-size: 11px; color: var(--ink-3); padding: 2px 0; }
  .cstream { list-style: none; margin: 0; padding: 0; }
  .chapter, .cseg { margin: 0 0 16px; }
  .csay { line-height: 1.7; overflow-wrap: anywhere; }
  .csay .markdown > :first-child { margin-top: 0; }
  .crows { list-style: none; margin: 6px 0 0; padding: 0; }
  /* A finished turn's process, folded into one line; open, it is the full process. */
  .cprocess { margin: 0 0 4px; }
  .cprocess > summary { display: flex; align-items: baseline; width: fit-content; max-width: 100%; padding: 2px 0; list-style: none; cursor: pointer; font-size: 12px; color: var(--ink-3); }
  .cprocess > summary::-webkit-details-marker { display: none; }
  .cprocess > summary:hover { color: var(--vscode-foreground); }
  .cprocess > summary::before { content: "✻"; margin-right: 7px; color: var(--ink-4); }
  .ccount-calls { white-space: pre; color: var(--ink-4); }
  .cfold-arrow { display: inline-block; margin-left: 8px; transition: transform .12s; }
  .cprocess[open] > summary .cfold-arrow { transform: rotate(90deg); }
  .cprocess > .cstream { margin-top: 10px; }
  .crow { display: grid; grid-template-columns: var(--tw) minmax(0, 1fr) 14px; align-items: baseline; gap: 8px; width: 100%; padding: 1px 4px; margin: 0 -4px; border: 0; border-radius: 4px; background: transparent; text-align: left; }
  .ctool { font: 600 10px/1.8 var(--mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Two lines at most: a raw command without a description can be a paragraph. */
  .clabel { min-width: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .clabel.machine { font: 11px/1.7 var(--mono); }
  .cbad { font-weight: 500; color: var(--vscode-errorForeground); }
  /* A question: its words, then its options on one wrapping line, the chosen ones marked. */
  .clabel.asked { display: block; -webkit-line-clamp: unset; }
  .cchoices { display: flex; flex-wrap: wrap; align-items: baseline; gap: 1px 12px; margin-top: 2px; font-size: 12px; }
  .cchoices:empty { display: none; }
  .cchoice { font-weight: 500; color: var(--vscode-foreground); }
  .cchoices .cq { font-style: normal; font-size: 11px; color: var(--ink-4); }
  .crow[data-status="empty"] .clabel { color: var(--ink-3); }
  .crep, .cnone { font-style: normal; color: var(--ink-4); }
  .cnone { margin-left: 6px; font: 10px/1 var(--mono); }
  .cgo { font: 11px/1.6 var(--mono); color: var(--ink-4); text-align: right; }
  .crow.node-button:hover .cgo, .cfile:hover .cgo, .crow[aria-pressed="true"] .cgo, .cfile[aria-pressed="true"] .cgo { color: var(--vscode-textLink-foreground); }
  .crow[aria-pressed="true"], .cfile[aria-pressed="true"] { background: var(--vscode-list-inactiveSelectionBackground); }
  /* Several chapters: a rail with one dot per chapter. One chapter needs no rail, unless the turn is running. */
  :is(.cstream.tracked, [data-fresh] .cstream.live) > :is(.chapter, .live-tail) { position: relative; padding-left: 14px; }
  :is(.cstream.tracked, [data-fresh] .cstream.live) > :is(.chapter, .live-tail)::before { content: ""; position: absolute; left: 2px; top: .62em; width: 5px; height: 5px; border-radius: 50%; background: var(--ink-4); }
  :is(.cstream.tracked, [data-fresh] .cstream.live) > .chapter::after { content: ""; position: absolute; left: 4px; top: calc(.62em + 9px); bottom: -12px; width: 1px; background: var(--hair); }
  :is(.cstream.tracked, [data-fresh] .cstream.live) > .chapter:last-of-type::after, .turn-panel:not([data-fresh]) .cstream > .chapter:has(+ .live-tail)::after { display: none; }
  .interjection .turn-question { margin-bottom: 0; }
  .ctail { font-size: 12px; line-height: 1.6; padding: 1px 0; color: var(--ink-3); }
  /* A light sweeps across the word while the turn runs, as in Claude Code and Codex; it stops when the source goes quiet. */
  .shimmer { background: linear-gradient(90deg, var(--ink-4) 35%, var(--vscode-foreground) 50%, var(--ink-4) 65%) 0 0 / 250% 100%;
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; animation: sidecar-shimmer 2s linear infinite; }
  @keyframes sidecar-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }
  .turn-panel[data-stale] .shimmer { animation: none; background: none; -webkit-text-fill-color: currentColor; }
  /* The rail's last dot is the live edge: it breathes while the turn runs. */
  .chapter-turn .cstream.live > .live-tail::before { background: var(--vscode-foreground); animation: sidecar-beat 1.4s ease-in-out infinite; }
  @keyframes sidecar-beat { 0%, 100% { opacity: .3; transform: scale(1); } 50% { opacity: 1; transform: scale(1.4); } }
  .turn-panel[data-stale] .cstream > .live-tail::before { animation: none; background: var(--ink-4); }
  /* Hidden until the client sees the source is still being written: a day-old open turn is not running. */
  .turn-panel:not([data-fresh]) .live-tail { display: none; }
  /* Waiting for the reader shows whatever the record clock says. */
  .chapter-turn .cstream > .live-tail.awaiting { display: block; }
  .chapter-turn .cstream.live > .live-tail.awaiting::before { background: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); animation: none; }
  .cwait { font-weight: 600; color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  .cwait-what { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); overflow-wrap: anywhere; }
  .cdraft { color: var(--ink-4); font-size: 12.5px; line-height: 1.55; }
  /* Aligned with the chapters' text, without a rail dot of its own: it is not a step yet. */
  :is(.cstream.tracked, [data-fresh] .cstream.live) > .cdraft-item { padding-left: 14px; }
  .cdraft > :first-child { margin-top: 0; } .cdraft > :last-child { margin-bottom: 0; }
  /* The agent says it went idle without writing a stop: an interrupt before any output. */
  .tidle { display: none; }
  .turn-panel[data-idle] .tidle { display: inline; }
  /* A call still out: its arrow nudges forward and back. Multi-line labels stay still. */
  .turn-panel[data-fresh]:not([data-stale]) .crow[data-out] .cgo { color: var(--vscode-foreground); animation: sidecar-nudge 1.2s ease-in-out infinite; }
  @keyframes sidecar-nudge { 0%, 100% { transform: translateX(-2px); opacity: .35; } 50% { transform: translateX(2px); opacity: 1; } }
  /* Live arrivals fade in one after another, a step apart, so a burst reads in order. */
  @keyframes sidecar-arrive { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  .arrived { animation: sidecar-arrive .26s cubic-bezier(.2, .7, .3, 1) backwards; }
  @media (prefers-reduced-motion: reduce) { .arrived, .chapter-turn .cstream.live > .live-tail::before { animation: none; }
    .shimmer { animation: none; background: none; -webkit-text-fill-color: currentColor; } .crow[data-out] .cgo { animation: none; } }
`;
