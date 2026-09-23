import type { TimelineItem } from '../../core/src/model';
import type { TurnGroup } from '../../core/src/timeline';
import { chapterTurn, type ChapterRow, type ChangedFile, type RowOutcome } from '../../core/src/chapters';
import { presentEvidence } from '../../core/src/presentation';
import { renderMarkdown } from './markdown';
import { statusVerb } from './verbs';
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
const clock = (iso?: string) => iso ? new Date(iso).toTimeString().slice(0, 5) : '';
const duration = (ms?: number) => ms === undefined || ms < 1000 ? '' : ms < 60000 ? Math.round(ms / 1000) + 's'
  : ms < 3600000 ? Math.round(ms / 60000) + 'm' : (ms / 3600000).toFixed(1) + 'h';

/** In the harness's own terms, as the call rows' machine voice: an exit code, a refusal, a stop. */
function outcomeWord(outcome: RowOutcome): string {
  if (outcome.kind === 'denied') return outcome.denial === 'user-rejected' ? 'rejected' : 'denied';
  if (outcome.kind === 'interrupted') return 'interrupted';
  if (outcome.kind === 'failed') return outcome.exitCode !== undefined ? `exit ${outcome.exitCode}` : 'failed';
  return '';
}


function rowHtml(row: ChapterRow, lead: boolean, render: ChapterRenderers, key: string, live: boolean): string {
  const state = row.outcome ? row.outcome.kind === 'empty' ? 'empty' : 'failed' : row.running ? 'running' : 'info';
  // In the live turn a call without a return is still out: its arrow moves, the
  // label stays still. Elsewhere a missing return only means none was recorded.
  const out = live && (row.pending || row.running) ? ' data-out' : '';
  const note = row.note ? `<i class="cnone">${escapeHtml(row.note)}</i>` : '';
  const word = row.outcome ? outcomeWord(row.outcome) : '';
  const exit = row.outcome?.reason ?? '';
  // A shared output is a wrapper's transport record; its first line is rarely readable.
  const output = row.output ? presentEvidence(row.items[0]).outputs.map(block => block.text ?? '').join('\n') : '';
  const label = row.output ? `返回内容 · ${output.split(/\r?\n/).length} 行` : row.label || '无记录参数';
  const voice = row.output || MACHINE.has(row.tool) ? 'machine' : 'prose';
  const tool = row.output ? 'OUT' : row.tool;
  const copy = `<span class="ctool"${lead && tool.length > 7 ? ` title="${escapeHtml(tool)}"` : ''}>${lead ? escapeHtml(tool) : ''}</span>`
    + `<span class="clabel ${voice}">${word ? `<b class="cbad">${word}</b> · ` : ''}${escapeHtml(label)}`
    + `${row.count > 1 ? `<i class="crep"> · ${row.count} 次</i>` : ''}`
    + `${row.outcome?.kind === 'empty' ? '<i class="cnone">no match</i>' : ''}`
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
  return rows.map((row, index) => rowHtml(row, index === 0 || rows[index - 1].tool !== row.tool || rows[index - 1].output !== row.output, render, `${chapterKey}#${index}`, live)).join('');
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

/** What a folded chapter did, by tool, in the order first used: `Bash ×5 · Read ×3`. */
function toolCounts(rows: ChapterRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) if (!row.output) counts.set(row.tool, (counts.get(row.tool) ?? 0) + row.count);
  return [...counts].map(([tool, count]) => `<span class="cfold-item"><b class="cfold-tool">${escapeHtml(tool)}</b>${count > 1 ? ` ×${count}` : ''}</span>`).join('<span class="cfold-sep"> · </span>');
}

/** Tool-name column width, as a class: the webview CSP forbids style="" attributes. */
function toolWidth(rows: ChapterRow[]): string {
  // Capped: one long name (ToolSearch) must not widen every row of the turn.
  const longest = Math.max(3, ...rows.map(row => (row.output ? 'OUT' : row.tool).length));
  return `tw-${Math.min(7, longest)}`;
}

/** `latest` marks the newest turn: only it can still be running. */
export function renderChapterTurn(group: TurnGroup, render: ChapterRenderers, latest = false, provider?: Provider): string {
  const turn = chapterTurn(group);
  const live = latest && !turn.ended && Boolean(turn.lastAt);
  const label = group.turnId ? `第 ${group.ordinal} 轮` : '未归属回合的记录';
  const chapters = turn.segments.filter(segment => segment.kind === 'chapter');
  const rows = chapters.flatMap(segment => segment.kind === 'chapter' ? segment.chapter.rows : []);
  const stream = turn.segments.map(segment => {
    if (segment.kind === 'answer') return `<li class="cseg" data-observation-key="${escapeHtml(segment.item.id)}">${render.answer(segment.item)}</li>`;
    if (segment.kind === 'interjection') return `<li class="cseg interjection" data-observation-key="${escapeHtml(segment.item.id)}"><div class="kicker">你的消息</div>${render.request(segment.item)}</li>`;
    const { chapter } = segment;
    // The agent's own words are shown in full, never clamped.
    const say = chapter.headings.map(heading => `<div class="csay" data-observation-key="say:${escapeHtml(heading.id)}" data-text-id="${escapeHtml(heading.id)}" data-status="${escapeHtml(heading.status)}">`
      + `${heading.status === 'failed' ? '<span class="availability">失败</span>' : ''}${renderMarkdown(render.publicBody(heading))}${render.attachments(heading)}</div>`).join('');
    return `<li class="chapter${chapter.headings.length ? '' : ' silent'}" data-observation-key="${escapeHtml(chapter.key)}">${say}`
      + (!chapter.rows.length ? '' : live || chapter.rows.length <= 2 ? `<ol class="crows">${rowsHtml(chapter.rows, render, chapter.key, live)}</ol>`
        // Once a turn is over it keeps the agent's words and folds its calls into one line.
        : `<details class="cfold" data-fold="${escapeHtml(chapter.key)}"><summary>${toolCounts(chapter.rows)}<span class="cfold-arrow" aria-hidden="true">›</span></summary>`
          + `<ol class="crows">${rowsHtml(chapter.rows, render, chapter.key, live)}</ol></details>`)
      + (chapter.records.length ? `<ol class="nodes">${chapter.records.map(render.record).join('')}</ol>` : '')
      + '</li>';
  }).join('');
  // One status line while the turn runs, as the agents show it. The clock counts
  // from the start of the turn, the same point Claude Code and Codex time from.
  const verb = statusVerb(provider, group.key);
  const tail = live
    ? `<li class="cseg live-tail" data-observation-key="live-tail:${escapeHtml(group.key)}"><div class="ctail"><span class="shimmer" data-live-verb="${verb}">${verb}</span><span data-since="${escapeHtml(turn.start ?? turn.lastAt)}"></span></div></li>` : '';
  return `<section class="turn-panel chapter-turn ${toolWidth(rows)}" data-turn-panel="${escapeHtml(group.key)}"${live ? ` data-last-at="${escapeHtml(turn.lastAt)}"` : ''} aria-label="${label}">`
    + `<header class="turn-heading"><span class="tclock">${clock(turn.start)}</span><span class="tlabel">${label}</span>${turn.aborted ? '<span class="tstop">中断</span>' : live ? '<span class="tstop tidle">已停止</span>' : ''}<span class="tdur">${duration(turn.durationMs)}</span></header>`
    + (turn.request ? render.request(turn.request) : '')
    + filesHtml(turn.files, group.key)
    + `<ol class="cstream${chapters.length > 1 ? ' tracked' : ''}${tail ? ' live' : ''}">${stream}${tail}</ol>`
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
  .cfold { margin: 6px 0 0; }
  .cfold > summary { display: flex; align-items: baseline; width: fit-content; max-width: 100%; padding: 1px 0; list-style: none; cursor: pointer; font: 10.5px/1.8 var(--mono); color: var(--ink-3); }
  .cfold > summary::-webkit-details-marker { display: none; }
  .cfold > summary:hover { color: var(--vscode-foreground); }
  .cfold-item { white-space: pre; }
  .cfold-tool { font-weight: 600; }
  .cfold-sep { white-space: pre; }
  .cfold-arrow { display: inline-block; margin-left: 7px; transition: transform .12s; }
  .cfold[open] > summary .cfold-arrow { transform: rotate(90deg); }
  .cfold > .crows { margin-top: 2px; }
  .crow { display: grid; grid-template-columns: var(--tw) minmax(0, 1fr) 14px; align-items: baseline; gap: 8px; width: 100%; padding: 1px 4px; margin: 0 -4px; border: 0; border-radius: 4px; background: transparent; text-align: left; }
  .ctool { font: 600 10px/1.8 var(--mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Two lines at most: a raw command without a description can be a paragraph. */
  .clabel { min-width: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .clabel.machine { font: 11px/1.7 var(--mono); }
  .cbad { font-weight: 500; color: var(--vscode-errorForeground); }
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
