import type { SessionData, TimelineItem } from '../../core/src/model';
import type { TurnGroup } from '../../core/src/timeline';
import type { ChapterRow, ChangedFile, TurnSegment } from '../../core/src/chapters';
import { backgroundLine, clock, rowView, turnView } from '../../core/src/turn-view';
import { announcedRow, callEnd, callSteps, callText, callTool } from '../../core/src/call-line';
import { shortFileLabels } from '../../core/src/presentation';
import { agentFacts, agentGroup, agentState } from '../../core/src/agent-line';
import { renderMarkdown } from './markdown';
import type { LiveExtras } from '../../core/src/live-extras';

export type { LiveExtras };

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
  /** Images and other blocks that came with the agent's words. */
  attachments(item: TimelineItem): string;
  /** Why a row cannot be opened, in the product's existing words. */
  unavailable(items: TimelineItem[]): string;
}

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

const base = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) || path;

/**
 * A call on the tree: its words in the editor font, grey, and what shows at
 * its end. A call still out turns where its branch would be; one waiting on
 * you shows ? there. Done, the branch is back.
 */
function callHtml(row: ChapterRow, key: string, session: SessionData, live: boolean, asking: boolean, unavailable: ChapterRenderers['unavailable']): string {
  const view = rowView(row, live);
  const words = callText(row, session);
  const end = callEnd(row, session, live);
  const state = end?.kind === 'failed' ? 'failed' : end?.kind === 'empty' ? 'empty' : view.out || row.running ? 'running' : 'info';
  const label = words.text + (row.count > 1 ? ` · ${row.count} 次` : '');
  const tail = (words.more ? `<span class="cmore">+${words.more}</span>` : '')
    + (end?.kind === 'failed' ? `<span class="cbad" title="${escapeHtml(end.reason)}">${escapeHtml(end.word)}</span>`
      : end?.kind === 'empty' ? '<span class="cnote">no match</span>'
      : end?.kind === 'note' ? `<span class="cnote">${escapeHtml(end.text)}</span>`
      : end?.kind === 'size' ? `<span class="csize">${end.added ? `<span class="cadd">+${end.added}</span>` : ''}${end.removed ? `<span class="cdel">-${end.removed}</span>` : ''}</span>` : '');
  // A call waiting on the reader shows ? in its tree cell. One still running is drawn as any other: the spinner is the turn's, at its end.
  const out = view.out && asking ? ' data-ask' : '';
  const copy = `<span class="cbranch" aria-hidden="true">${out ? '?' : ''}</span>`
    + `<span class="clabel${words.command ? ' command' : ''}">${escapeHtml(label)}</span>${tail}`;
  const title = [callTool(row, session), label, end?.kind === 'failed' ? `${end.word} ${end.reason}`.trim() : '', view.out || row.running ? '进行中' : '', row.openable ? '' : unavailable(row.items)].filter(Boolean).join(' · ');
  const tool = escapeHtml(callTool(row, session));
  const body = row.openable
    ? `<button type="button" class="crow node-button" data-item-id="${escapeHtml(row.id)}" data-tool="${tool}" data-status="${state}"${out} aria-pressed="false" title="${escapeHtml(title)}">${copy}</button>`
    : `<div class="crow" data-tool="${tool}" data-status="${state}"${out} role="group" aria-label="${escapeHtml(title)}">${copy}</div>`;
  // A question's chosen answers, under it on the tree.
  const choices = (view.choices ?? []).map(choice => {
    const chosen = choice.chosen.length ? choice.chosen.map(value => `<b class="cchoice">✓ ${escapeHtml(value)}</b>`).join('') : choice.waiting ? '<i class="cwaiting">等待你的选择</i>' : '';
    return chosen ? `<div class="cchoices">${choice.header ? `<i class="cq">${escapeHtml(choice.header)}</i>` : ''}${chosen}</div>` : '';
  }).join('');
  return `<li class="crow-item" data-observation-key="${escapeHtml(key)}">${body}${choices}</li>`;
}

/**
 * A step's calls under the words that explain them, on the page itself, as a tree: the
 * tool's name once for a run of one tool, each call hung from it. Every call is
 * shown: the reader is here for the process. Keyed by position, not by row id:
 * rows only ever append, while an id changes when a repeated call raises its
 * count, so a live update rewrites a row in place.
 */
function callsHtml(all: ChapterRow[], key: string, session: SessionData, live: boolean, waiting: boolean, unavailable: ChapterRenderers['unavailable']): string {
  const rows = callSteps(all);
  if (!rows.length) return '';
  const names = rows.map(row => callTool(row, session));
  // Agent calls are other agents set to work, not tools: set off from them, each with a dot for its state, as in the terminal.
  const agent = (row: ChapterRow) => row.items[0]?.kind === 'subagent';
  let html = '', block = '', start = 0;
  const close = (end: number) => {
    if (!block) return;
    const id = escapeHtml(start ? `${key}:calls@${start}` : `${key}:calls`);
    html += agent(rows[start]) ? `<div class="cagents" data-observation-key="${id}">${block}</div>` : `<div class="ccalls" data-observation-key="${id}">${block}</div>`;
    block = ''; start = end;
  };
  for (let at = 0; at < rows.length;) {
    let last = at;
    while (last + 1 < rows.length && names[last + 1] === names[at] && agent(rows[last + 1]) === agent(rows[at])) last++;
    if (at && agent(rows[at]) !== agent(rows[at - 1])) close(at);
    if (agent(rows[at])) {
      block += agentsHtml(rows.slice(at, last + 1), `${key}@${at}`, `${key}#${at}`, session, unavailable);
      at = last + 1;
      continue;
    }
    const run = rows.slice(at, last + 1).map((row, index) => callHtml(row, `${key}#${at + index}`, session, live, waiting && at + index === rows.length - 1, unavailable)).join('');
    block += `<div class="crun" data-observation-key="${escapeHtml(`${key}@${at}`)}"><div class="ctool">${escapeHtml(names[at])}</div><ol class="ctree">${run}</ol></div>`;
    at = last + 1;
  }
  close(rows.length);
  return html;
}

/**
 * Agent calls, as in the terminal (design v10): the tool's name and the lead
 * their descriptions share, then each a dot coloured by its state, its own
 * words, and under them what the run came to.
 */
function agentsHtml(rows: ChapterRow[], key: string, rowKey: string, session: SessionData, unavailable: ChapterRenderers['unavailable']): string {
  const group = agentGroup(rows.map(row => callText(row, session).text));
  const states: Record<string, string> = { running: '运行中', done: '已完成', failed: '失败', stopped: '已停止' };
  const items = rows.map((row, index) => {
    const state = agentState(row);
    const facts = agentFacts(row, Date.now());
    const label = group.names[index] + (row.count > 1 ? ` · ${row.count} 次` : '');
    const title = [callTool(row, session), callText(row, session).text, states[state], facts, row.openable ? '' : unavailable(row.items)].filter(Boolean).join(' · ');
    const copy = `<span class="cdot" aria-hidden="true"></span><span class="clabel">${escapeHtml(label)}</span>${facts ? `<span class="cfacts">${escapeHtml(facts)}</span>` : ''}`;
    const body = row.openable
      ? `<button type="button" class="crow cagent node-button" data-item-id="${escapeHtml(row.id)}" data-tool="Agent" data-state="${state}" aria-pressed="false" title="${escapeHtml(title)}">${copy}</button>`
      : `<div class="crow cagent" data-tool="Agent" data-state="${state}" role="group" aria-label="${escapeHtml(title)}">${copy}</div>`;
    return `<li class="cagent-item" data-observation-key="${escapeHtml(`${rowKey}+${index}`)}">${body}</li>`;
  }).join('');
  return `<div class="crun" data-observation-key="${escapeHtml(key)}"><div class="ctool">${escapeHtml(callTool(rows[0], session))}${group.lead ? `<span class="clead"> · ${escapeHtml(group.lead)}</span>` : ''}</div><ol class="cagent-list">${items}</ol></div>`;
}

/** The label over a block, as in the terminal: a small grey word on a line of its own; coloured only for what is going on (Needs approval, Interrupted). */
const label = (text: string, tone = ''): string => `<div class="tlabel"${tone ? ` data-tone="${tone}"` : ''}>${text}</div>`;

/** The answer folded: its opening lines run together, as words: marks of headings, lists, emphasis, code and links dropped. */
const flatAnswer = (text: string): string => text.split(/\n/).map(line => line.trim().replace(/^#+\s*|^[-*]\s+|^\d+\.\s+|^>\s*/, '')).filter(Boolean).join(' ')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '');

/**
 * The files the turn changed, after its answer: folded, how many and the
 * lines changed in all ("等" when some have no counts, known only from a
 * script's fragment); opened, a line each, which opens its change.
 */
function changesHtml(files: ChangedFile[], turnKey: string): string {
  if (!files.length) return '';
  const size = (added?: number, removed?: number) => `${added ? `<span class="cadd">+${added}</span>` : ''}${removed ? `<span class="cdel">-${removed}</span>` : ''}`;
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0), removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  // 等: some files' lines are counted and some are not; with none counted there is no total to qualify.
  const partial = files.some(file => file.added === undefined) && files.some(file => file.added !== undefined);
  const names = shortFileLabels(files.map(file => file.path));
  const rows = files.map((file, index) => `<li data-observation-key="${escapeHtml(file.id)}"><button type="button" class="cfile node-button" data-item-id="${escapeHtml(file.id)}" data-path="${escapeHtml(file.path)}" aria-pressed="false" title="${escapeHtml(file.path)}">`
    + `<span class="cmark" data-mark="${file.mark}">${file.mark}</span><span class="cname">${escapeHtml(names[index] || base(file.path))}</span><span class="csize">${size(file.added, file.removed)}</span></button></li>`).join('');
  return `<details class="cfold cchanges" data-fold="changes:${escapeHtml(turnKey)}" data-observation-key="changes:${escapeHtml(turnKey)}"><summary>${label('Changes')}`
    + `<span class="fline"><span class="ftext">${files.length} 个文件 <span class="csize">${size(added, removed)}</span>${partial ? '<span class="cnote">等</span>' : ''}</span><span class="fchev" aria-hidden="true">▾</span></span></summary>`
    + `<ol class="cfiles">${rows}</ol></details>`;
}

/** A path names its file; anything else is kept, shortened by the row's own ellipsis. */
const waitingFor = ({ tool, summary }: { tool: string; summary: string }): string[] =>
  [tool, /^\/.+\/[^/]+$/.test(summary) ? summary.split('/').at(-1)! : summary].filter(Boolean);

export interface TurnContext { latest: boolean; session: SessionData; extras?: LiveExtras }

/**
 * The whole turn, top to bottom, as the terminal sets it (design v11 B): what
 * was asked, raised on a sheet under a Prompt label; the agent's words with the
 * calls each explains under them, on the page itself; then, under a rule, how
 * the turn ended. While it runs, a dot breathes at the end; waiting on you,
 * Needs approval. Over, the answer and the changes fold to a line each; the
 * process stays open.
 */
export function renderChapterTurn(group: TurnGroup, render: ChapterRenderers, { latest, session, extras = {} }: TurnContext): string {
  const view = turnView(group, latest, session.provider);
  const { turn, live } = view;
  // Waiting for the reader keeps the turn open, whatever its record clock says.
  const waiting = latest && !turn.ended && extras.approval;
  const open = live || Boolean(waiting);
  const words = (item: TimelineItem) => `<div class="csay" data-observation-key="say:${escapeHtml(item.id)}" data-text-id="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}">`
    + `${item.status === 'failed' ? '<span class="availability">失败</span>' : ''}${renderMarkdown(render.publicBody(item))}${render.attachments(item)}</div>`;
  const segmentHtml = (segment: TurnSegment) => {
    if (segment.kind === 'answer') return `<li class="cseg" data-observation-key="${escapeHtml(segment.item.id)}">${words(segment.item)}</li>`;
    // Your own words sent during the turn: a prompt too.
    if (segment.kind === 'interjection') return `<li class="cseg tprompt" data-observation-key="${escapeHtml(segment.item.id)}">${label('Prompt')}${render.request(segment.item)}</li>`;
    const { chapter } = segment;
    return `<li class="chapter" data-observation-key="${escapeHtml(chapter.key)}">${chapter.headings.map(words).join('')}`
      + callsHtml(chapter.rows, chapter.key, session, open, Boolean(waiting), render.unavailable)
      + (chapter.records.length ? `<ol class="nodes">${chapter.records.map(render.record).join('')}</ol>` : '')
      + '</li>';
  };
  const stream = (open ? turn.segments : view.process).map(segmentHtml).join('');
  // On screen in the agent, not yet in the transcript: set as the words and calls will be, so nothing moves when the record comes.
  const draft = live && extras.draft
    ? `<li class="cseg" data-observation-key="draft:${escapeHtml(group.key)}"><div class="csay">${renderMarkdown(extras.draft)}</div></li>` : '';
  const announced = open && extras.calls?.length
    ? `<li class="chapter" data-observation-key="announced:${escapeHtml(group.key)}">${callsHtml(extras.calls.map(announcedRow), `announced:${group.key}`, session, true, Boolean(waiting), render.unavailable)}</li>` : '';
  let end = '';
  if (waiting) {
    const [tool, what] = waitingFor(waiting);
    end = `<li class="cseg tend awaiting" data-observation-key="live-tail:${escapeHtml(group.key)}">${label('Needs approval', 'yellow')}`
      + `${tool ? `<div class="cwait-what"><b>${escapeHtml(tool)}</b>${what ? ` · ${escapeHtml(what.replace(/\s+/g, ' '))}` : ''}</div>` : ''}`
      + `<div class="cnote">在 ${session.provider === 'claude' ? 'Claude Code' : 'Codex'} 里选择批准或拒绝。</div></li>`;
  } else if (live) {
    // The agent works out its next step: a dot breathes where the answer will come. The client hides it while what came last is still appearing.
    end = `<li class="cseg tend live-tail" data-observation-key="live-tail:${escapeHtml(group.key)}"><span class="cbranch"><span class="cspin"></span></span><span class="cquiet" data-live-verb=""></span><span class="cquiet" data-since=""></span></li>`;
  }
  const answers = open ? [] : view.answers.map(segment => segment.kind === 'answer' ? render.publicBody(segment.item) : '').filter(Boolean);
  const answerItems = open ? [] : view.answers.flatMap(segment => segment.kind === 'answer' ? [segment.item] : []);
  const closing = answers.length
    ? `<details class="cfold fanswer" data-fold="answer:${escapeHtml(group.key)}" data-observation-key="answer:${escapeHtml(group.key)}"><summary>${label('Final Answer')}`
      + `<span class="fline"><span class="ftext">${escapeHtml(flatAnswer(answers.join('\n')))}</span><span class="fchev" aria-hidden="true">▾</span></span></summary>`
      + `<div class="fbody">${answerItems.map(words).join('')}</div></details>`
    : !open && turn.aborted ? `<div class="tend" data-observation-key="interrupted:${escapeHtml(group.key)}">${label('Interrupted', 'red')}</div>` : '';
  const prompt = turn.request ? `<section class="tprompt" data-observation-key="prompt:${escapeHtml(group.key)}">${label('Prompt')}${render.request(turn.request)}</section>` : '';
  const ordinal = group.ordinal ?? 0;
  const started = clock(turn.start);
  const background = backgroundLine(session);
  return `<section class="turn-panel chapter-turn" data-turn-panel="${escapeHtml(group.key)}" data-ordinal="${ordinal}"${live ? ` data-last-at="${escapeHtml(turn.lastAt)}"` : ''} aria-label="${escapeHtml(view.label)}">`
    + `<header class="turn-heading">${group.turnId ? `<b>第 ${ordinal} 轮</b><span class="tsub"> / 共 <span data-turn-total>${ordinal}</span> 轮${started ? ` · ${started}` : ''}</span>` : '<span class="tsub">未归属回合的记录</span>'}</header>`
    + prompt
    + `<ol class="cstream">${stream}${draft}${announced}${end}</ol>`
    + closing
    + (open ? '' : changesHtml(turn.files, group.key))
    // Over, but tasks it left running have not reported back. Shown only while the agent reports its state (live-client).
    + (latest && !open && background ? `<p class="tbackground" data-observation-key="background:${escapeHtml(group.key)}">${escapeHtml(background)}</p>` : '')
    + (turn.segments.length || end ? '' : '<p class="empty">暂未取得本轮过程。</p>')
    + `<div class="turn-content-end" aria-hidden="true"></div></section>`;
}

/**
 * Colours come only from the VS Code theme (design v11 B, v12). The greys are
 * one ladder mixed from the theme's text and side-bar colours, opaque, so a
 * grey reads the same wherever it sits: words in the body colour, the next
 * steps at 78 and 58 percent, lines at 16. Two sizes, 13px for words and 12px
 * for the rest; gaps of 4, 8 and 16. Only what you asked is raised, on a sheet
 * a step lighter than the page; the process sits on the page itself. Colour
 * says only what is going on: gold the waiting dot, a running Agent and a call
 * waiting on you; green and red a change's size and an outcome. Each
 * takes a fifth of the text colour so none of them jumps out of the greys.
 */
export const chapterStyles = `
  .chapter-turn { --ink-2: color-mix(in oklch, var(--vscode-foreground) 78%, var(--surface)); --ink-3: color-mix(in oklch, var(--vscode-foreground) 58%, var(--surface));
    --ink-4: color-mix(in oklch, var(--vscode-foreground) 42%, var(--surface)); --hair: color-mix(in oklch, var(--vscode-foreground) 16%, var(--surface));
    --raise: color-mix(in oklch, var(--vscode-foreground) 6%, var(--surface)); --edge: color-mix(in oklch, var(--vscode-foreground) 13%, var(--surface));
    --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --gold: color-mix(in oklch, var(--vscode-editorWarning-foreground, #cca700) 80%, var(--vscode-foreground));
    --green: color-mix(in oklch, var(--vscode-charts-green, var(--vscode-gitDecoration-addedResourceForeground, #388a34)) 84%, var(--vscode-foreground));
    --red: color-mix(in oklch, var(--vscode-errorForeground, #f85149) 78%, var(--vscode-foreground));
    --left: 20px; --right: 16px; padding: 0 var(--right) 0 var(--left); font-variant-numeric: tabular-nums; }
  .chapter-turn .turn-heading { justify-content: flex-start; gap: 0; margin: 0 calc(-1 * var(--right)) 0 calc(-1 * var(--left)); padding: 8px var(--right) 8px var(--left); font-size: 12px; color: var(--vscode-foreground); }
  .chapter-turn .turn-heading b { font-weight: 600; }
  .chapter-turn .tsub { color: var(--ink-3); white-space: pre; }
  /* A label over a block: a small grey word on a line of its own, the block right under it. */
  .tlabel { font-weight: 500; font-size: 10.5px; line-height: 1.6; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 4px; }
  .tlabel[data-tone="yellow"] { color: var(--gold); } .tlabel[data-tone="red"] { color: var(--red); }
  /* What you asked: the one thing raised, a sheet a step lighter than the page with a hairline edge. */
  .tprompt { margin: 12px -4px 0 -10px; padding: 8px 10px 9px; background: var(--raise); border: 1px solid var(--edge); border-radius: 6px; }
  .cseg.tprompt { margin-top: 16px; }
  /* Agent calls: set off from the tools; a dot coloured by state, the words in the body colour, what the run came to under them. */
  .cagents { margin: 8px 0 0; }
  .chapter > .cagents:first-child { margin-top: 0; }
  .clead { font-weight: 400; }
  .cagent-list { list-style: none; margin: 2px 0 0; padding: 0; display: grid; gap: 4px; }
  .crow.cagent { display: grid; grid-template-columns: 7px minmax(0, 1fr); column-gap: 8px; align-items: baseline; color: var(--vscode-foreground); }
  .cagent .clabel { -webkit-line-clamp: 2; }
  .cagent .cfacts { grid-column: 2; font: 12px/1.6 var(--vscode-font-family, sans-serif); color: var(--ink-3); }
  .cdot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-4); transform: translateY(-1px); }
  .cagent[data-state="running"] .cdot { background: var(--gold); }
  .cagent[data-state="done"] .cdot { background: var(--green); }
  .cagent[data-state="failed"] .cdot { background: var(--red); }
  .tprompt .turn-question { margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; }
  .tprompt .question-more { color: var(--ink-3); }
  .cstream { list-style: none; margin: 0; padding: 0; }
  .chapter, .cseg { margin: 16px 0 0; }
  .csay { line-height: 1.65; overflow-wrap: anywhere; }
  .csay + .csay { margin-top: 8px; }
  .csay .markdown { line-height: 1.65; }
  /* Code in the words: the editor's font, a step grey, nothing behind it. */
  .csay :not(pre) > code { background: transparent; padding: 0; font-size: 12px; color: var(--ink-2); }
  /* A step's calls on the page itself, under the words that explain them. */
  .ccalls { margin: 8px 0 0; }
  .chapter > .ccalls:first-child { margin-top: 0; }
  .crun + .crun { margin-top: 4px; }
  .ctool { font-weight: 600; font-size: 12px; line-height: 1.6; }
  .ctree { list-style: none; margin: 0; padding: 0; }
  /* The tree: a line down from the tool's name, a tick to each call. Drawn, not typed, so it stays joined in any font. */
  .crow-item { position: relative; padding-left: 16px; }
  .crow-item::before { content: ""; position: absolute; left: 4px; top: 0; bottom: 0; border-left: 1px solid var(--hair); }
  .crow-item:last-child::before { bottom: auto; height: .8em; }
  .crow-item::after { content: ""; position: absolute; left: 4px; top: .8em; width: 7px; border-top: 1px solid var(--hair); }
  .crow-item:has(> .crow[data-ask])::after { display: none; }
  .crow-item:has(> .crow[data-ask])::before { top: 1.45em; }
  .crow-item:last-child:has(> .crow[data-ask])::before { display: none; }
  .crow { display: flex; align-items: last baseline; gap: 8px; width: 100%; min-width: 0; padding: 0; margin: 0; border: 0; background: transparent; text-align: left; color: var(--ink-3); font: 12px/1.6 var(--mono); }
  .cbranch { position: absolute; left: 0; top: 0; width: 11px; text-align: center; color: var(--gold); font: 700 12px/1.6 var(--mono); }
  .clabel { min-width: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .clabel.command { -webkit-line-clamp: 1; word-break: break-all; }
  .cmore { flex: none; font-weight: 600; color: var(--ink-4); }
  .cbad { flex: none; color: var(--red); }
  .cnote { flex: none; color: var(--ink-4); }
  .csize { flex: none; display: inline-flex; gap: 5px; }
  .cadd { color: var(--green); } .cdel { color: var(--red); }
  /* The line under the cursor or the pointer (design v13, 2b): grey comes up in the body colour; what is in the body colour already is underlined. No colour of its own. */
  .crow.node-button:hover > :is(.clabel, .cmore, .cnote), .crow[aria-pressed="true"] > :is(.clabel, .cmore, .cnote),
  .cagent.node-button:hover .cfacts, .cagent[aria-pressed="true"] .cfacts, .cfile:hover .cmark[data-mark="M"], .cfile[aria-pressed="true"] .cmark[data-mark="M"] { color: var(--vscode-foreground); }
  .cagent.node-button:hover .clabel, .cagent[aria-pressed="true"] .clabel, .cfile:hover .cname, .cfile[aria-pressed="true"] .cname { text-decoration: underline; text-underline-offset: 2px; }
  .cchoices { display: flex; flex-wrap: wrap; align-items: baseline; gap: 1px 10px; font-size: 12px; }
  .cchoice { font-weight: 600; color: var(--vscode-foreground); }
  .cq, .cwaiting { font-style: normal; color: var(--ink-3); }
  .chapter > .nodes { margin-top: 8px; }
  /* The end of a running turn: a gold dot breathing where the answer will come, or how long it has been quiet. */
  .tend { margin-top: 16px; }
  .live-tail { display: flex; align-items: center; gap: 8px; min-height: 1.6em; font-size: 12px; color: var(--ink-3); }
  .live-tail .cbranch { position: static; display: inline-flex; align-items: center; width: auto; height: 1.6em; }
  .cspin { display: block; width: 7px; height: 7px; border-radius: 50%; background: var(--gold); animation: sidecar-breathe 1.6s ease-in-out infinite; }
  @keyframes sidecar-breathe { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
  .live-tail .cquiet:empty { display: none; }
  .turn-panel:not([data-fresh]) .live-tail, .turn-panel[data-idle] .live-tail { display: none; }
  .turn-panel[data-stale] .live-tail .cbranch { display: none; }
  .tbackground { display: none; margin: 12px 0 0; font-size: 12px; color: var(--ink-3); }
  [data-agent-known] .tbackground { display: block; }
  .awaiting .cwait-what { font-size: 12px; overflow-wrap: anywhere; }
  .awaiting .cwait-what b { font-weight: 600; }
  .awaiting .cnote { font-size: 12px; color: var(--ink-3); }
  /* The answer and the changes fold to a line each: the label, then one full line and ▾. A hairline sets them, or how the turn broke off, apart from the process. */
  .cfold { margin-top: 8px; }
  .cstream ~ .cfold:first-of-type, .cstream + .tend { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--hair); }
  .cstream + .tend ~ .cfold { margin-top: 8px; padding-top: 0; border-top: 0; }
  .cfold > summary { display: block; list-style: none; cursor: pointer; }
  .cfold > summary::-webkit-details-marker { display: none; }
  .fline { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .ftext { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .fchev { flex: none; color: var(--ink-3); }
  .cfold > summary:hover .ftext { text-decoration: underline; text-underline-offset: 2px; }
  .cfold[open] .fline { display: none; }
  .fbody .csay + .csay { margin-top: 10px; }
  .cchanges .ftext { display: flex; gap: 8px; }
  .cfiles { list-style: none; margin: 0; padding: 0; }
  .cfile { display: grid; grid-template-columns: 1em minmax(0, 1fr) auto; align-items: baseline; gap: 8px; width: 100%; padding: 0; border: 0; background: transparent; text-align: left; }
  .cmark { font: 12px/1.6 var(--mono); color: var(--ink-3); }
  .cmark[data-mark="A"] { color: var(--green); } .cmark[data-mark="D"] { color: var(--red); }
  .cname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cfile .csize { font: 12px/1.6 var(--mono); }
  /* Live arrivals (design v12): not on the page until their turn, so the page only grows at its end; then a 200ms fade. The words type out instead (live-client). */
  .pending { display: none !important; }
  @keyframes sidecar-arrive { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  .arrived { animation: sidecar-arrive .2s cubic-bezier(.2, .7, .3, 1) backwards; }
  @media (prefers-reduced-motion: reduce) { .arrived, .cspin { animation: none; } .cspin { opacity: 1; } }
`;
