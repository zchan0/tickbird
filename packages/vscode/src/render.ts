import { renderChapterTurn, chapterStyles } from './chapter-view';
import type { EvidenceBlock, ItemKind, Provider, SessionData, TimelineItem } from '../../core/src/model';
import type { TurnGroup } from '../../core/src/timeline';
import { actionRowSections, outlineTurn, visibleTurnGroups, type OutlineNode, type OutlineEvidence } from '../../core/src/outline';
import { actionPresentation, describeAction, recordedToolInputs, type ActionEntry } from '../../core/src/actions';
import { renderMarkdown, renderUserText } from './markdown';
import { plainPasted } from '../../core/src/pasted';
import { sourceTimestamp } from '../../core/src/jsonl';
import { liveClient } from './live-client';
import { followClient } from './follow-client';
import { inlineClient } from './inline-client';
import { createHash } from 'node:crypto';
import { describeDisplayAction, presentEvidence, parsePatch, publicLabels, toolOutputContents, invocationInput, recordedFiles, fileEvidenceId, shortFileLabels, fileReading, type FileReading, type InputContent } from '../../core/src/presentation';
import { renderCode, renderFile } from './code';
import { uiLabel } from './labels';
import { publicBody, publicBodyLabels } from '../../core/src/turn-view';

export interface SidecarRenderOptions { projectName: string; session?: SessionData; nonce: string; streamId?: string; locale?: string }
export interface SidecarProjection { sessionKey: string; name: string; identity: string; map: string; lens: string; warnings: string; empty: string; turns: Array<{ key: string; html: string }> }
export type TurnRenderCache = Map<string, { digest: string; html: string }>;
export interface DetailRenderOptions { item: TimelineItem; items?: TimelineItem[]; provider: Provider; kept: boolean; nonce: string; locale?: string }

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

const kindNames: Record<ItemKind, string> = {
  request: '用户提问', message: '过程说明', tool: '工具记录', answer: '回答记录',
  context: '相关背景', notice: '记录说明', question: '提问与回复', subagent: '子任务', 'file-change': '文件变化',
};
const statusNames: Record<TimelineItem['status'], string> = {
  info: '', running: '进行中', completed: '已完成', failed: '失败', unknown: '',
};
const availabilityNames: Record<TimelineItem['availability'], string> = {
  none: '', available: '', partial: '部分内容', unavailable: '内容不可用',
};
const providerName = (provider: Provider): string => provider === 'claude' ? 'Claude Code' : 'Codex';

function safeImage(block: EvidenceBlock): string | undefined {
  if (!block.data || !/^image\/(png|jpeg|gif|webp)$/.test(block.mime ?? '')) return undefined;
  if (block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) return undefined;
  return `data:${block.mime};base64,${block.data}`;
}

function hasContent(item: TimelineItem): boolean {
  return Boolean(item.detail?.blocks.some(block =>
    block.kind === 'image' ? Boolean(safeImage(block)) : Boolean(block.text?.trim()),
  ));
}

function canOpen(item: TimelineItem): boolean {
  return (item.availability === 'available' || item.availability === 'partial') && hasContent(item);
}

function unavailableReason(items: TimelineItem[]): string {
  const item = items.find(record => record.availability === 'unavailable');
  if (!item) return '';
  const explanation = item.detail?.notice || (item.summary !== item.title ? item.summary : '');
  return `未取得可读的记录内容${explanation ? `：${explanation.replace(/\s+/g, ' ').trim().slice(0, 160)}` : '；可在覆盖记录中核对来源。'}`;
}

const styles = `
  :root {
    color-scheme: light dark;
    --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --border: var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    --muted: var(--vscode-descriptionForeground);
    --warning: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
  }
  * { box-sizing: border-box; }
  /* VS Code injects body { padding: 0 20px } into every webview; a sidebar view must reach both edges. */
  html, body { height: 100%; margin: 0; padding: 0; }
  body:has(> main.detail) { background: var(--vscode-editor-background); }
  body { color: var(--vscode-foreground); background: var(--surface); font: var(--vscode-font-size, 13px)/1.6 var(--vscode-font-family, sans-serif); }
  button { color: inherit; font: inherit; cursor: pointer; }
  button:disabled { cursor: default; opacity: .65; }
  button:focus-visible, summary:focus-visible, [tabindex]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 15px; font-weight: 500; line-height: 1.65; overflow-wrap: anywhere; }
  h2 { font-size: 14px; font-weight: 500; }
  h3 { font-size: 12px; font-weight: 500; margin: 0 0 7px; }
  .sidecar { display: flex; flex-direction: column; height: 100vh; background: var(--surface); }
  [hidden] { display: none !important; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; flex: none; }
  .project { min-width: 0; overflow-wrap: anywhere; color: var(--muted); font-size: 11px; }
  .sidecar > .toolbar { min-height: 49px; padding: 9px 10px; border-bottom: 1px solid var(--border); }
  .session-title { min-width: 0; font-size: 13px; line-height: 1.5; font-weight: 600; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .controls { display: flex; align-items: center; gap: 1px; flex: none; }
  .observation-status { flex: none; color: var(--muted); font-size: 10px; white-space: nowrap; }
  .observation-status[data-state="paused"] { color: var(--warning); }
  .observation-status[data-state="running"] { color: var(--vscode-foreground); }
  .observation-status[data-state="running"]::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; vertical-align: 1px; border-radius: 50%; background: var(--vscode-charts-green, var(--vscode-foreground)); }
  .observation-problem { flex: none; color: var(--warning); padding: 7px 12px; font-size: 11px; border-bottom: 1px solid var(--border); }
  .icon-button { display: grid; place-items: center; width: 24px; height: 26px; padding: 0; border: 0; border-radius: 4px; background: transparent; }
  .icon-button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.25; stroke-linecap: round; stroke-linejoin: round; }
  .icon-button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  .quiet-button { border: 1px solid transparent; border-radius: 4px; background: transparent; padding: 3px 7px; font-size: 11px; }
  .quiet-button:hover:not(:disabled), .node-button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  .eyebrow { color: var(--muted); font-size: 11px; margin-bottom: 5px; }
  .reading-layout { display: flex; flex: 1; min-height: 0; }
  .turn-map { position: relative; flex: 0 0 20px; overflow-y: auto; scrollbar-width: none; display: flex; flex-direction: column; padding: 8px 1px; gap: 0; }
  .turn-map button:first-child { margin-top: auto; }
  .turn-map button:last-child { margin-bottom: auto; }
  .turn-map::-webkit-scrollbar { display: none; }
  .turn-mark { position: relative; display: flex; justify-content: center; align-items: center; border: 0; background: transparent; min-height: 16px; flex: none; width: 100%; padding: 4px 1px; border-radius: 3px; }
  .turn-tick { height: 2px; background: var(--vscode-foreground); opacity: .25; width: 5px; border-radius: 1px; }
  .turn-mark[data-weight="2"] .turn-tick { width: 7px; }
  .turn-mark[data-weight="3"] .turn-tick { width: 9px; }
  .turn-mark[data-weight="4"] .turn-tick { width: 12px; }
  .turn-mark:hover, .turn-mark:focus-visible { background: var(--vscode-list-hoverBackground); }
  .turn-mark[aria-pressed="true"] .turn-tick { opacity: .9; }
  .turn-lens { position: fixed; z-index: 3; width: min(260px, calc(100vw - 28px)); max-height: calc(100vh - 16px); overflow-y: auto; padding: 5px; border: 1px solid var(--vscode-widget-border, var(--border)); border-radius: 7px; background: var(--vscode-editorWidget-background, var(--surface)); box-shadow: 0 4px 16px var(--vscode-widget-shadow, transparent); }
  .turn-lens button { display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 9px; border: 0; border-radius: 4px; background: transparent; text-align: left; }
  .turn-lens button:hover, .turn-lens button:focus-visible { background: var(--vscode-list-hoverBackground); }
  .turn-lens button[aria-pressed="true"] { background: var(--vscode-list-inactiveSelectionBackground); }
  .turn-lens-number { color: var(--muted); font-size: 10px; }
  .turn-lens-title { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
  .turn-lens-request { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 12px; line-height: 1.5; }
  .tool-fields { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 14px; font-size: 12px; }
  .tool-fields dt { color: var(--muted); }
  .tool-fields dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .timeline { position: relative; flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: 14px 12px 20px 6px; scrollbar-width: thin; overflow-anchor: none; }
  .turn-panel + .turn-panel { margin-top: 28px; padding-top: 22px; border-top: 1px solid var(--border); }
  .turn-panel:last-child { min-height: 100%; }
  .nodes { list-style: none; margin: 0; padding: 0; }
  .turn-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 11px; margin-bottom: 7px; }
  .turn-question { padding: 10px 11px; margin: 0 0 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--vscode-textBlockQuote-background, color-mix(in srgb, var(--vscode-foreground) 5%, transparent)); }
  .question-text { font-size: 13px; line-height: 1.65; font-weight: 500; overflow-wrap: anywhere; max-height: 9.9em; overflow: hidden; }
  .question-more { display: block; margin-top: 6px; padding: 0; border: 0; background: transparent; font-size: 11px; color: var(--muted); }
  .question-more:hover, .narrative-more:hover { color: var(--vscode-foreground); text-decoration: underline; }
  .pasted { margin: .5em 0 .8em; padding: 1px 0 1px 10px; border-left: 2px solid var(--vscode-textBlockQuote-border, var(--border)); }
  .pasted-label { margin-bottom: 2px; color: var(--muted); font-size: 10.5px; }
  .narrative { padding: 0; margin: 10px 0 15px; line-height: 1.75; overflow-wrap: anywhere; }
  .narrative-preview { max-height: 18em; overflow: hidden; }
  .thinking-phase { display: flex; align-items: baseline; gap: 8px; color: var(--muted); font-size: 11px; margin: 12px 0; padding-left: 3px; }
  .thinking-phase .timeline-dot { color: var(--muted); }
  .markdown { white-space: normal; overflow-wrap: anywhere; min-width: 0; line-height: 1.75; }
  .markdown > :first-child { margin-top: 0; }
  .markdown > :last-child { margin-bottom: 0; }
  .markdown p { margin: 0 0 .8em; }
  .markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: 1.15em 0 .55em; line-height: 1.5; font-size: 1.06em; font-weight: 600; }
  .markdown ul, .markdown ol { padding-left: 1.5em; margin: .5em 0 .9em; }
  .markdown li + li { margin-top: .25em; }
  .markdown blockquote { border-left: 2px solid var(--vscode-textBlockQuote-border, var(--border)); padding-left: .85em; margin: .75em 0; color: var(--muted); }
  .markdown hr { border: 0; border-top: 1px solid var(--border); margin: 1.25em 0; }
  .markdown pre { overflow: auto; max-width: 100%; white-space: pre; margin: .7em 0; padding: 10px; border-radius: 5px; }
  .markdown code { font-family: var(--vscode-editor-font-family, monospace); font-size: .93em; background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: .08em .25em; }
  .markdown pre code { padding: 0; background: transparent; }
  .markdown-table { overflow-x: auto; }
  .markdown table { border-collapse: collapse; font-size: .95em; }
  .markdown th, .markdown td { border: 1px solid var(--border); padding: 5px 8px; }
  .markdown-link { color: var(--vscode-textLink-foreground, var(--vscode-foreground)); text-decoration: underline; text-underline-offset: 2px; }
  .markdown-image-reference { color: var(--muted); font-size: .93em; }
  .narrative-more { display: block; padding: 0; margin-top: 4px; color: var(--muted); background: transparent; border: 0; font-size: 11px; }
  .action-list, .action-sections { list-style: none; margin: 12px 0 18px; padding: 0; }
  .action-list > li, .action-sections > li { position: relative; }
  .action-list > li:not(:last-child)::after, .action-sections > li:not(:last-child)::after { content: ''; position: absolute; left: 12px; top: 21px; bottom: -13px; width: 1px; background: var(--border); pointer-events: none; }
  .action-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: baseline; gap: 7px; width: 100%; min-height: 36px; padding: 7px 3px; border: 0; border-radius: 5px; background: transparent; text-align: left; }
  .action-copy { min-width: 0; }
  .action-copy .action-type { margin-right: 9px; overflow-wrap: anywhere; }
  .action-copy .action-purpose, .action-copy .action-purpose-text { display: inline; }
  .timeline-dot { position: relative; z-index: 1; display: grid; place-items: center; width: 18px; height: 18px; align-self: start; margin-top: 1px; color: var(--muted); }
  .timeline-dot::before { content: ''; width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: .55; }
  .action-fold > summary { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto 9px; align-items: baseline; gap: 6px; padding: 7px 3px; min-height: 34px; border-radius: 4px; cursor: pointer; list-style: none; }
  .action-fold > summary::-webkit-details-marker { display: none; }
  .action-fold > summary:hover { background: var(--vscode-list-hoverBackground); }
  .action-fold-types { display: block; min-width: 0; color: var(--muted); font: 500 11px/1.7 var(--vscode-editor-font-family, monospace); overflow-wrap: anywhere; }
  .action-fold-count { color: var(--muted); font-size: 10px; white-space: nowrap; }
  .action-fold-arrow { display: block; color: var(--muted); }
  .action-fold[open] > summary .action-fold-arrow { transform: rotate(90deg); }
  .action-fold > .action-list { margin: 2px 0 8px 24px; }
  .action-symbol { position: relative; z-index: 1; display: grid; place-items: center; width: 18px; height: 18px; align-self: start; margin-top: 1px; color: var(--action-color); background: var(--surface); border-radius: 4px; }
  .action-symbol svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.35; stroke-linecap: round; stroke-linejoin: round; }
  .action-type { font: 600 12px/1.6 var(--vscode-font-family, sans-serif); }
  .action-purpose { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; min-width: 0; }
  .action-purpose-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .action-row .node-arrow { align-self: start; font-size: 13px; }
  .action-row[aria-pressed="true"] { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); }
  .action-row[data-status="failed"] .action-state { color: var(--vscode-errorForeground); }
  .action-count { white-space: nowrap; font-size: 11px; }
  .action-state { display: block; color: var(--muted); font-size: 10px; }
  .node { display: grid; grid-template-columns: 16px minmax(0, 1fr) 12px; align-items: start; gap: 8px; width: 100%; padding: 9px; margin: 2px 0; border: 0; border-radius: 5px; background: transparent; text-align: left; }
  .node[aria-pressed="true"] { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); }
  .node-title { display: block; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; white-space: pre-wrap; }
  .node-summary { display: block; font-size: 11px; color: var(--muted); margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .node-meta { display: block; font-size: 11px; color: var(--muted); margin-top: 4px; }
  .node-icon, .node-arrow { color: var(--muted); }
  .node[data-action-type="AGENT"] { grid-template-columns: 18px minmax(0, 1fr) 9px; gap: 6px; padding: 7px 3px; }
  .node[data-status="failed"] .node-icon, .node[data-status="failed"] .node-meta { color: var(--vscode-errorForeground); }
  .availability { display: block; margin-top: 4px; color: var(--warning); font-size: 11px; }
  .display-only .node-icon { opacity: .65; }
  .empty p { color: var(--muted); font-size: 11px; }
  .empty { padding: 18px 9px; }
  .empty h2 { margin-bottom: 8px; }
  .gap-action { margin-top: 6px; padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; font-size: 12px; }
  .gap-action:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  .notice { border-left: 2px solid var(--warning); padding: 9px 11px; background: var(--vscode-textBlockQuote-background, transparent); color: var(--warning); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .session-warning { margin: 8px 0; }
  .detail { max-width: 960px; margin: 0 auto; padding-bottom: 24px; }
  .detail .toolbar { position: sticky; top: 0; z-index: 2; min-height: 38px; padding: 5px 16px; border-bottom: 1px solid var(--border); background: var(--vscode-editor-background); }
  .detail-identity { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; color: var(--muted); font-size: 11px; }
  .detail-heading { padding: 14px 16px 13px; }
  .detail-heading h1 { font-size: 16px; line-height: 1.5; }
  .detail-heading .eyebrow { margin-bottom: 4px; }
  .detail-state-line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; margin-top: 7px; font-size: 11px; color: var(--muted); }
  .detail-state { padding: 1px 6px; border: 1px solid var(--border); border-radius: 4px; }
  .detail-state[data-status="failed"] { color: var(--vscode-errorForeground); }
  .detail-content { padding: 0 16px; }
  .evidence-record + .evidence-record { padding-top: 18px; margin-top: 24px; border-top: 1px solid var(--border); }
  .evidence-record-heading { margin-bottom: 12px; }
  .evidence-record-heading h2 { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
  .evidence-notices { margin-bottom: 12px; }
  .evidence-notices .notice { padding: 6px 10px; line-height: 1.6; }
  .evidence-notices .notice + .notice { padding-top: 2px; }
  .evidence-scope { margin: 0 0 12px; color: var(--muted); font-size: 11px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
  .evidence-block { margin-bottom: 16px; }
  .evidence-block > h3 { margin: 0 0 6px; font-size: 11px; color: var(--muted); }
  .evidence-block[data-evidence-kind="json"] > pre, .evidence-block[data-evidence-kind="code"] > pre { border-radius: 6px; }
  .plain-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  pre { margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--vscode-textCodeBlock-background, var(--surface)); font: var(--vscode-editor-font-size, 12px)/1.75 var(--vscode-editor-font-family, monospace); white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; }
  .patch { padding: 8px 0; }
  .patch-line { display: block; padding: 0 10px; min-height: 1.75em; }
  .patch-added { background: var(--vscode-diffEditor-insertedTextBackground); }
  .patch-removed { background: var(--vscode-diffEditor-removedTextBackground); }
  .patch-header { color: var(--muted); }
  .code-block { white-space: pre; overflow-x: auto; overflow-wrap: normal; max-width: 100%; }
  .file-meta { display: flex; flex-wrap: wrap; gap: 3px 12px; margin: 0 0 9px; color: var(--muted); font-size: 11px; }
  .file-path { font-family: var(--vscode-editor-font-family, monospace); overflow-wrap: anywhere; color: var(--vscode-foreground); }
  .code-surface { display: grid; grid-template-columns: auto minmax(0, 1fr); overflow: auto; border: 1px solid var(--border); border-radius: 5px; background: var(--vscode-textCodeBlock-background, var(--surface)); font: var(--vscode-editor-font-size, 12px)/1.7 var(--vscode-editor-font-family, monospace); }
  .code-surface.no-gutter { grid-template-columns: minmax(0, 1fr); }
  .code-surface pre { margin: 0; padding: 10px 14px; border: 0; border-radius: 0; background: transparent; font: inherit; white-space: pre; overflow-wrap: normal; tab-size: 4; }
  /* The gutter stays put while a long line scrolls sideways. */
  .code-surface .line-numbers { position: sticky; left: 0; z-index: 1; padding-right: 10px; text-align: right; color: var(--muted); user-select: none; border-right: 1px solid var(--border); background: var(--vscode-textCodeBlock-background, var(--surface)); }
  .code-surface .source-code { min-width: max-content; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal { color: var(--vscode-symbolIcon-keywordForeground, #b18ad6); }
  .hljs-string, .hljs-template-variable { color: var(--vscode-symbolIcon-stringForeground, #b99672); }
  .hljs-number, .hljs-built_in { color: var(--vscode-symbolIcon-numberForeground, #76aaa8); }
  .hljs-comment { color: var(--muted); }
  .hljs-title, .hljs-attr { color: var(--vscode-symbolIcon-functionForeground, #b8ae80); }
  .io-section { margin: 0 0 20px; min-width: 0; }
  .io-section > h2 { font-size: 11px; color: var(--muted); margin-bottom: 7px; }
  .io-section > .code-block + .code-block { margin-top: 8px; }
  .invocation-input + .invocation-input { margin-top: 14px; }
  .invocation-input > h3 { color: var(--muted); }
  .patch-file { margin: 0 0 12px; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
  .patch-file > h3 { padding: 7px 10px; margin: 0; overflow-wrap: anywhere; background: var(--surface); font-family: var(--vscode-editor-font-family, monospace); }
  .patch-file > h3 span { margin-left: 8px; color: var(--muted); font-size: 10px; }
  .patch-file .patch { border: 0; border-radius: 0; overflow-x: auto; white-space: pre; }
  .output-preview { margin: 5px 0 14px 21px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 5px; min-width: 0; }
  .output-preview h3 { color: var(--muted); font-size: 10px; }
  .output-preview pre { padding: 0; border: 0; background: transparent; font-size: 11px; max-height: 5.25em; overflow: hidden; }
  .output-preview button { margin-top: 5px; border: 0; padding: 0; background: none; color: var(--muted); font-size: 11px; }
  .action-sections > .output-preview::after { display: none; }
  .bash-step { margin: 0; }
  .bash-disclosure > summary { cursor: pointer; list-style: none; }
  .bash-disclosure > summary::-webkit-details-marker { display: none; }
  .bash-disclosure > summary:hover { background: var(--vscode-list-hoverBackground); }
  .bash-disclosure > summary .node-arrow { transition: transform .12s; }
  .bash-disclosure[open] > summary .node-arrow { transform: rotate(90deg); }
  .bash-disclosure .action-copy { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 8px; }
  .bash-disclosure .action-type { color: var(--muted); margin-right: 0; font-weight: 500; }
  .bash-disclosure .action-purpose { flex: 1; min-width: 70px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .bash-disclosure .action-state { flex-basis: 100%; }
  .bash-disclosure .action-io { margin-bottom: 10px; }
  .bash-disclosure .io-preview-text { -webkit-line-clamp: 6; max-height: 10.5em; }
  .io-more { display: block; width: 100%; padding: 5px 8px; border: 0; border-top: 1px solid var(--border); background: transparent; color: var(--muted); font-size: 11px; text-align: right; }
  .io-more:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
  .follow-bar { flex: none; padding: 5px 12px 6px 26px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 10px; }
  .follow-button { border: 0; border-radius: 4px; padding: 3px 7px; color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); font-size: 11px; }
  .follow-button[aria-pressed="true"] { color: var(--muted); background: transparent; }
  .tool-disclosure > summary, .record-disclosure > summary { cursor: pointer; list-style: none; }
  .tool-disclosure > summary::-webkit-details-marker, .record-disclosure > summary::-webkit-details-marker { display: none; }
  .tool-disclosure > summary:hover, .record-disclosure > summary:hover { background: var(--vscode-list-hoverBackground); }
  .tool-disclosure[open] > summary { background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); }
  .tool-step .action-symbol { color: var(--vscode-foreground); opacity: .7; }
  .tool-step .action-copy { display: flex; align-items: baseline; flex-wrap: wrap; gap: 1px 7px; }
  .tool-step .action-type { color: var(--vscode-foreground); margin-right: 0; }
  .tool-step .action-purpose { flex: 1; min-width: 65px; color: var(--muted); }
  .tool-step .action-purpose-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .tool-step .action-state { flex-basis: 100%; }
  .action-affordance { display: inline-flex; align-items: center; gap: 3px; }
  .disclosure-arrow, .output-indicator { display: inline-flex; color: var(--muted); width: 13px; height: 15px; flex: none; }
  .disclosure-arrow svg, .output-indicator svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
  details[open] > summary > .disclosure-arrow, details[open] > summary > .action-affordance > .disclosure-arrow { transform: rotate(180deg); }
  .detail-arrow { color: var(--vscode-textLink-foreground, var(--muted)); font-size: 15px; }
  .output-disclosure > summary { display: flex; align-items: center; gap: 7px; width: max-content; min-height: 24px; padding: 1px 6px; color: var(--muted); border-radius: 4px; }
  .inline-evidence { margin: 2px 0 12px 28px; padding: 10px; min-width: 0; border-left: 1px solid var(--border); background: var(--vscode-textCodeBlock-background, transparent); border-radius: 0 5px 5px 0; font-size: 12px; }
  .inline-evidence .io-section { margin-bottom: 12px; }
  .inline-evidence .io-section h2, .inline-evidence .io-section h3 { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .inline-evidence pre { max-height: 340px; overflow: auto; font-size: 11px; border: 0; padding: 7px 0; }
  .inline-evidence .tool-fields { display: block; }
  .inline-evidence .tool-fields dd { margin: 0 0 8px; }
  .inline-evidence img { max-width: 100%; }
  .inline-evidence .sources { font-size: 10px; }
  .inline-placeholder { color: var(--muted); font-size: 11px; }
  .inline-evidence .io-preview { background: transparent; padding: 5px 0; }
  .file-change-result { margin: 0; }
  .file-change-result .action-copy { grid-column: auto; }
  .text-expanded > .question-text, .text-expanded > .narrative-preview { max-height: none; }
  .follow-button { padding: 2px 5px; font-size: 10px; white-space: nowrap; margin-right: 3px; }
  .action-io { margin: 0 0 0 27px; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
  .io-preview { display: grid; grid-template-columns: 25px minmax(0, 1fr); gap: 7px; width: 100%; padding: 8px; border: 0; background: var(--vscode-textCodeBlock-background, transparent); text-align: left; }
  .io-preview + .io-preview { border-top: 1px solid var(--border); }
  .io-preview:hover { background: var(--vscode-list-hoverBackground); }
  .io-preview-label { color: var(--muted); font: 11px/1.75 var(--vscode-editor-font-family, monospace); }
  .io-preview-text { white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; max-height: 5.25em; overflow: hidden; font: 11px/1.75 var(--vscode-editor-font-family, monospace); }
  .file-change-result { margin: 5px 0 14px; }
  .file-change-result .action-copy { grid-column: 2; }
  .file-change-paths { margin: 0 0 5px 27px; font: 11px/1.75 var(--vscode-editor-font-family, monospace); overflow-wrap: anywhere; }
  .compact-marker { color: var(--muted); font-size: 12px; }
  .compact-marker .action-symbol { color: var(--muted); }
  .shared-output { margin-left: 27px; padding: 0; }
  .shared-output .io-preview { margin: 0; padding: 8px; }
  .render-note { color: var(--muted); font-size: 11px; margin-bottom: 13px; }
  .source-list { list-style: none; padding: 0; margin: 8px 0 0; }
  .source-list li { padding: 5px 0; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
  .sources { margin-top: 14px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
  .sources > summary { padding: 9px 0; cursor: pointer; }
  .source-metadata { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 4px 0 12px; }
  .source-metadata dt { color: var(--muted); }
  .source-metadata dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  .sources .render-note { margin-bottom: 9px; }
  .source-path { font-family: var(--vscode-editor-font-family, monospace); }
  .question-record { padding: 12px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; }
  .question-record p { margin: 7px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .question-options { padding-left: 19px; margin: 8px 0 0; }
  .question-options li { margin: 6px 0; overflow-wrap: anywhere; }
  .question-options span { display: block; color: var(--muted); font-size: 11px; }
  .answers { margin: 0; }
  .answers dt { color: var(--muted); font-size: 11px; margin-top: 9px; overflow-wrap: anywhere; }
  .answers dd { margin: 3px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  figure { margin: 0; }
  figure img { display: block; max-width: 100%; height: auto; }
  figcaption { color: var(--muted); font-size: 11px; margin-top: 8px; }
  /* Accepted reading layout: prose gets room; actions remain compact and quiet. */
  .sidecar > .toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 10px; padding: 14px 14px 10px; }
  .session-title { grid-column: 1 / -1; font-size: 14px; font-weight: 500; }
  .observation-status { font-size: 11px; }
  .controls { justify-content: flex-end; gap: 3px; }
  .follow-button { white-space: nowrap; font-size: 11px; min-height: 26px; }
  .timeline { padding-top: 18px; padding-bottom: 30px; }
  .turn-question { padding: 12px 13px; border-radius: 9px; background: var(--vscode-editor-background); margin-bottom: 20px; }
  .question-text { font-weight: 400; line-height: 1.8; max-height: none; }
  .narrative { margin: 19px 3px; font-size: 13px; color: var(--vscode-foreground); }
  .narrative .markdown, .question-text .markdown { line-height: 1.8; }
  .narrative-preview, .question-text { max-height: none; }
  .narrative-preview > .markdown, .question-text > .markdown { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
  .text-expanded .narrative-preview, .text-expanded .question-text { max-height: none; }
  .text-expanded .narrative-preview > .markdown, .text-expanded .question-text > .markdown { display: block; -webkit-line-clamp: unset; }
  .narrative-more, .question-more { font-size: 11px; padding: 3px 0; margin-top: 6px; }
  .question-foot { display: flex; justify-content: flex-end; }
  .question-foot:not(:has(> :not([hidden]))) { display: none; }
  .question-foot .question-more { margin-top: 4px; }
  .question-more[aria-pressed="true"] { color: var(--vscode-textLink-foreground); }
  .narrative-attachments { margin-top: 10px; font-size: 11px; color: var(--muted); }
  .narrative-attachments > summary { cursor: pointer; }
  .final-answer { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--border); }
  /* Right under a folded process line, the answer follows closely. */
  .cprocess + .cstream .final-answer { margin-top: 6px; padding-top: 12px; }
  .answer-label { margin-bottom: 10px; color: var(--muted); font-size: 11px; }
  .action-sections, .action-list { margin: 10px 0 18px; }
  .action-sections > li::after, .action-list > li::after { display: none; }
  .tool-step { margin: 2px 0; background: transparent; border-radius: 0; }
  .action-row { min-height: 28px; padding: 5px 0; border-radius: 0; grid-template-columns: minmax(0, 1fr) auto; gap: 9px; }
  .tool-step .action-copy { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; line-height: 1.75; }
  .tool-step .action-type { display: inline; margin-right: 7px; color: var(--muted); font-weight: 400; font-size: 11px; }
  .tool-step .action-purpose { display: inline; min-width: 0; color: var(--vscode-foreground); font-size: 12px; line-height: 1.75; }
  .tool-step .action-purpose-text { display: inline; }
  .action-state { display: inline; font-size: 10px; margin: 0 7px 0 0; }
  .action-symbol { width: 16px; height: 18px; background: transparent; color: var(--muted); }
  .tool-disclosure[open] { border-radius: 0; box-shadow: none; }
  .tool-disclosure > summary:hover, .tool-disclosure[open] > summary, .record-disclosure > summary:hover { background: transparent; }
  .tool-disclosure > summary .disclosure-arrow { opacity: .45; }
  .tool-disclosure > summary:hover .disclosure-arrow, .tool-disclosure > summary:focus-visible .disclosure-arrow, .tool-disclosure[open] > summary .disclosure-arrow { opacity: 1; }
  .tool-disclosure > .inline-evidence { margin: 3px 0 10px 1px; padding-left: 12px; border-left: 1px solid var(--border); }
  .inline-evidence { margin: 0; padding: 5px 10px 12px 32px; border: 0; background: transparent; }
  .inline-evidence .io-section { margin-bottom: 12px; }
  .inline-return > summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; padding: 7px 0; color: var(--muted); font-size: 11px; }
  .inline-return > summary::-webkit-details-marker { display: none; }
  .inline-return pre { max-height: 360px; }
  .output-disclosure[open] { box-shadow: none; }
  .shared-output { margin: 0 0 7px; }
  .shared-output .output-disclosure > summary { display: flex; align-items: center; gap: 8px; width: 100%; padding: 3px 0 5px; font-size: 11px; color: var(--muted); }
  .output-label, .output-lines { flex: none; font-size: 10px; }
  .output-excerpt { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .write-group { margin: 7px 0 10px; padding: 2px 0; background: transparent; border: 0; border-radius: 0; }
  .write-heading { display: flex; align-items: center; gap: 7px; margin-bottom: 3px; }
  .write-heading .action-type { font-size: 12px; font-weight: 500; color: var(--muted); }
  .write-count { font-size: 11px; color: var(--muted); }
  .write-file { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 27px; padding: 3px 0 3px 10px; border: 0; border-left: 2px solid transparent; background: transparent; border-radius: 0; text-align: left; }
  .write-file.node-button:hover { background: transparent; }
  .write-file:hover .write-name { text-decoration: underline; text-underline-offset: 3px; }
  .write-file[aria-pressed="true"] { border-left-color: var(--vscode-focusBorder); background: transparent; }
  .write-files { margin-left: 2px; padding-left: 8px; border-left: 1px solid var(--border); }
  .write-single { display: flex; align-items: baseline; gap: 8px; }
  .write-single .write-heading { flex: none; margin: 0; }
  .write-single .write-files { flex: 1; min-width: 0; margin: 0; padding: 0; border: 0; }
  .write-single .write-file { padding-left: 0; border-left: 0; }
  .write-operation { font-size: 10px; font-family: var(--vscode-font-family); color: var(--muted); white-space: nowrap; }
  .write-failure { color: var(--vscode-errorForeground); font-size: 11px; }
  .write-name { flex: 1; min-width: 0; overflow-wrap: anywhere; font: 12px/1.6 var(--vscode-editor-font-family, monospace); }
  .write-added, .write-removed { font: 11px/1.6 var(--vscode-editor-font-family, monospace); white-space: nowrap; }
  .write-added { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-foreground)); }
  .write-removed { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground)); }
`;

const script = `(() => {
  const vscode = acquireVsCodeApi();
  const sidecar = document.querySelector('.sidecar');
  const timeline = document.querySelector('.timeline');
  const turnMap = document.querySelector('.turn-map');
  const turnLens = document.querySelector('.turn-lens');
  const sessionId = document.body.dataset.sessionId || '';
  const previous = vscode.getState();
  const saved = previous && previous.sessionId === sessionId ? previous : {};
  let selectedId = typeof saved.selectedId === 'string' ? saved.selectedId : '';
  let focusId = typeof saved.focusId === 'string' ? saved.focusId : '';
  let focusTurnId = typeof saved.focusTurnId === 'string' ? saved.focusTurnId : '';
  let focusGroupId = typeof saved.focusGroupId === 'string' ? saved.focusGroupId : '';
  const actions = ['chooseSession', 'refresh', 'coverage', 'keep', 'openFolder'];
  let focusAction = typeof saved.focusAction === 'string' && actions.includes(saved.focusAction) ? saved.focusAction : '';
  const nodes = () => [...document.querySelectorAll('button[data-item-id]')];
  const panels = () => [...document.querySelectorAll('[data-turn-panel]')];
  const turns = () => [...document.querySelectorAll('button[data-turn-id]')];
  const lensTurns = () => [...document.querySelectorAll('button[data-lens-turn-id]')];
  const groups = () => [...document.querySelectorAll('details[data-action-group]')];
  const summaries = () => [...document.querySelectorAll('summary[data-action-group]')];
  // A changed evidence membership receives a new ID. Do not silently retarget
  // a previous selection/focus to a different set of source records.
  if (selectedId && !nodes().some(button => button.dataset.itemId === selectedId)) selectedId = '';
  if (focusId && !nodes().some(button => button.dataset.itemId === focusId)) focusId = '';
  if (focusTurnId && !turns().some(button => button.dataset.turnId === focusTurnId)) focusTurnId = '';
  if (focusGroupId && !summaries().some(summary => summary.dataset.actionGroup === focusGroupId)) focusGroupId = '';
  const initialPanel = panels()[0];
  let selectedTurnId = panels().some(panel => panel.dataset.turnPanel === saved.selectedTurnId)
    ? saved.selectedTurnId : initialPanel ? initialPanel.dataset.turnPanel : '';
  if (Array.isArray(saved.expandedActionIds)) {
    const expanded = new Set(saved.expandedActionIds.filter(id => typeof id === 'string'));
    groups().forEach(group => { group.open = expanded.has(group.dataset.actionGroup); });
  }
  ${followClient}
  ${inlineClient}
  const persist = () => {
    const panel = panels().find(panel => panel.dataset.turnPanel === selectedTurnId);
    vscode.setState({ sessionId, selectedId, focusId, focusAction, scrollTop: timeline ? timeline.scrollTop : 0,
      readingVersion: 2, selectedTurnId, focusTurnId, focusGroupId, autoFollow: following,
      readingAnchor: panel && timeline ? { turnId: selectedTurnId, offset: timeline.scrollTop - panel.offsetTop } : undefined,
      mapScrollTop: turnMap ? turnMap.scrollTop : 0,
      expandedTextIds: [...expandedTexts],
      expandedInlineSections: [...expandedInlineSections],
      openFolds: [...openFolds],
      expandedActionIds: groups().filter(group => group.open).map(group => group.dataset.actionGroup) });
  };
  const select = () => nodes().forEach(node => node.setAttribute('aria-pressed', String(node.dataset.itemId === selectedId)));
  const selectTurn = () => {
    turns().forEach(button => button.setAttribute('aria-pressed', String(button.dataset.turnId === selectedTurnId)));
    lensTurns().forEach(button => button.setAttribute('aria-pressed', String(button.dataset.lensTurnId === selectedTurnId)));
  };
  let lensAnchor;
  let returningFromLens = false;
  const hideLens = () => {
    if (turnLens) turnLens.hidden = true;
    turns().forEach(button => button.setAttribute('aria-expanded', 'false'));
  };
  const showLens = mark => {
    if (!turnLens || returningFromLens) return;
    const marks = turns();
    const index = marks.indexOf(mark);
    if (index < 0) return;
    lensAnchor = mark;
    lensTurns().forEach(button => { button.hidden = button.dataset.lensTurnId !== mark.dataset.turnId; });
    marks.forEach(button => button.setAttribute('aria-expanded', String(button === mark)));
    turnLens.hidden = false;
    const rect = mark.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right, window.innerWidth - turnLens.offsetWidth - 8));
    const top = Math.max(8, Math.min(rect.top + rect.height / 2 - turnLens.offsetHeight / 2, window.innerHeight - turnLens.offsetHeight - 8));
    turnLens.style.left = left + 'px';
    turnLens.style.top = top + 'px';
  };
  const inTurnNavigation = target => target instanceof Element && Boolean(target.closest('.turn-map, .turn-lens'));
  document.addEventListener('mouseover', event => {
    const mark = event.target instanceof Element ? event.target.closest('button[data-turn-id]') : null;
    if (mark) showLens(mark);
  });
  document.addEventListener('mouseout', event => {
    if (inTurnNavigation(event.target) && !inTurnNavigation(event.relatedTarget)) hideLens();
  });
  document.addEventListener('keydown', event => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (event.key === 'Escape' && turnLens && !turnLens.hidden) {
      event.preventDefault();
      hideLens();
      if (target && target.dataset.lensTurnId && lensAnchor) {
        returningFromLens = true;
        lensAnchor.focus({ preventScroll: true });
        returningFromLens = false;
      }
    } else if (target && target.dataset.turnId && event.key === 'ArrowRight') {
      event.preventDefault(); showLens(target);
      const entry = lensTurns().find(button => button.dataset.lensTurnId === target.dataset.turnId);
      if (entry) entry.focus({ preventScroll: true });
    } else if (target && target.dataset.lensTurnId && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      const entries = lensTurns().filter(button => !button.hidden);
      const next = entries[entries.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)];
      event.preventDefault();
      if (next) next.focus({ preventScroll: true });
    }
  });
  const revealMark = () => {
    const mark = turns().find(button => button.dataset.turnId === selectedTurnId);
    if (!mark || !turnMap) return;
    if (mark.offsetTop < turnMap.scrollTop) turnMap.scrollTop = mark.offsetTop;
    else if (mark.offsetTop + mark.offsetHeight > turnMap.scrollTop + turnMap.clientHeight)
      turnMap.scrollTop = mark.offsetTop + mark.offsetHeight - turnMap.clientHeight;
  };
  const trackReading = () => {
    if (!timeline) return;
    const visible = panels().filter(panel => panel.offsetTop <= timeline.scrollTop + 24).at(-1) || panels()[0];
    if (visible && selectedTurnId !== visible.dataset.turnPanel) {
      selectedTurnId = visible.dataset.turnPanel;
      selectTurn(); revealMark();
    }
  };
  selectTurn();
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target || target.disabled) return;
    const turnId = target.dataset.turnId || target.dataset.lensTurnId;
    if (turnId) {
      const panel = panels().find(panel => panel.dataset.turnPanel === turnId);
      if (!panel) return;
      selectedTurnId = turnId;
      selectedId = ''; focusId = ''; focusAction = ''; focusGroupId = ''; focusTurnId = selectedTurnId;
      selectTurn(); select();
      if (timeline) timeline.scrollTop = panel.offsetTop;
      hideLens();
      revealMark();
      if (target.dataset.lensTurnId) {
        returningFromLens = true;
        turns().find(button => button.dataset.turnId === turnId)?.focus({ preventScroll: true });
        returningFromLens = false;
      }
      persist();
      return;
    }
    if (target.dataset.itemId) {
      selectedId = target.dataset.itemId;
      focusId = selectedId;
      focusTurnId = '';
      focusGroupId = '';
      focusAction = '';
      select();
      persist();
      vscode.postMessage({ type: 'openDetail', itemId: selectedId });
      return;
    }
    const type = target.dataset.action;
    if (actions.includes(type)) {
      focusId = '';
      focusTurnId = '';
      focusGroupId = '';
      focusAction = type;
      persist();
      vscode.postMessage({ type });
    }
  });
  if (timeline) timeline.addEventListener('scroll', () => { hideLens(); trackReading(); persist(); }, { passive: true });
  if (turnMap) turnMap.addEventListener('scroll', () => { hideLens(); persist(); }, { passive: true });
  window.addEventListener('resize', hideLens);
  const boundGroups = new WeakSet();
  const bindGroups = () => groups().forEach(group => { if (!boundGroups.has(group)) { boundGroups.add(group); group.addEventListener('toggle', persist); } });
  bindGroups();
  if (sidecar) {
    sidecar.addEventListener('focusin', event => {
      const target = event.target instanceof Element ? event.target.closest('button, summary[data-action-group]') : null;
      if (!target || target.disabled) return;
      if (target.dataset.itemId) {
        focusId = target.dataset.itemId;
        focusAction = '';
        focusTurnId = '';
        focusGroupId = '';
      } else if (target.dataset.turnId) {
        showLens(target);
        focusTurnId = target.dataset.turnId;
        focusId = '';
        focusAction = '';
        focusGroupId = '';
      } else if (target.dataset.lensTurnId) {
        // Preview focus is transient; only an explicit click changes the turn.
        return;
      } else if (target.dataset.actionGroup) {
        focusGroupId = target.dataset.actionGroup;
        focusId = ''; focusTurnId = ''; focusAction = '';
      } else if (actions.includes(target.dataset.action)) {
        focusId = '';
        focusTurnId = '';
        focusGroupId = '';
        focusAction = target.dataset.action;
      } else return;
      persist();
    });
    sidecar.addEventListener('focusout', event => {
      if (inTurnNavigation(event.target) && !inTurnNavigation(event.relatedTarget)) hideLens();
    });
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).length !== 1 || message.type !== 'kept') return;
    const button = document.querySelector('.detail button[data-action="keep"]');
    const status = document.querySelector('[data-keep-status]');
    if (!button || !status) return;
    button.disabled = true;
    button.textContent = '已保留';
    status.textContent = '已保留';
  });
  ${liveClient}
  // Calls folded under an earlier chapter stay as the reader left them, across updates and reloads.
  const openFolds = new Set(Array.isArray(saved.openFolds) ? saved.openFolds.filter(key => typeof key === 'string') : []);
  const applyFolds = () => document.querySelectorAll('details[data-fold]').forEach(fold => { if (openFolds.has(fold.dataset.fold)) fold.open = true; });
  document.addEventListener('toggle', event => {
    const fold = event.target instanceof Element && event.target.matches('details[data-fold]') ? event.target : null;
    if (!fold) return;
    if (fold.open) openFolds.add(fold.dataset.fold); else openFolds.delete(fold.dataset.fold);
    persist();
  }, true);
  const ready = () => {
    applyFolds();
    measureText();
    select();
    if (timeline) {
      const anchor = saved.readingVersion === 2 && saved.readingAnchor;
      const panel = anchor && panels().find(panel => panel.dataset.turnPanel === anchor.turnId);
      if (panel && Number.isFinite(anchor.offset)) timeline.scrollTop = Math.max(0, panel.offsetTop + anchor.offset);
      else if (saved.readingVersion === 2 && Number.isFinite(saved.scrollTop)) timeline.scrollTop = saved.scrollTop;
      else {
        // Migrate the old single-turn reading location, without hiding history.
        const legacy = panels().find(panel => panel.dataset.turnPanel === saved.selectedTurnId);
        const offset = saved.turnScroll && saved.turnScroll[saved.selectedTurnId];
        timeline.scrollTop = legacy ? legacy.offsetTop + (Number.isFinite(offset) ? offset : 0) : 0;
      }
      trackReading();
      followLatest();
    }
    if (turnMap) {
      if (Number.isFinite(saved.mapScrollTop)) turnMap.scrollTop = saved.mapScrollTop;
      else revealMark();
    }
    const focus = focusAction && sidecar
      ? [...sidecar.querySelectorAll('button[data-action]')].find(button => button.dataset.action === focusAction)
      : focusTurnId ? turns().find(button => button.dataset.turnId === focusTurnId)
      : focusGroupId ? summaries().find(summary => summary.dataset.actionGroup === focusGroupId)
      : nodes().find(node => node.dataset.itemId === focusId);
    if (focus && !focus.disabled && !focus.closest('[hidden]') && !(focus.dataset.itemId && focus.closest('details:not([open])')) && document.hasFocus()) {
      returningFromLens = true;
      focus.focus({ preventScroll: true });
      returningFromLens = false;
    }
    if (timeline) {
      // Also preserve a reader who has not scrolled or clicked yet: a refresh
      // through the command palette must not jump to newly prepended turns.
      persist();
    }
    installObservation(() => {
      applyFolds();
      bindGroups();
      if (selectedId && !nodes().some(node => node.dataset.itemId === selectedId)) selectedId = '';
      if (!panels().some(panel => panel.dataset.turnPanel === selectedTurnId)) selectedTurnId = panels()[0]?.dataset.turnPanel || '';
      select(); selectTurn();
      loadOpenInline();
      if (turnLens && !turnLens.hidden && lensAnchor) {
        const mark = turns().find(button => button.dataset.turnId === lensAnchor.dataset.turnId);
        if (mark) showLens(mark); else hideLens();
      }
    });
    loadOpenInline();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();`;

function documentHtml(title: string, body: string, nonce: string, sessionId = '', locale = 'zh-CN'): string {
  const pageStyles = styles + chapterStyles;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(nonce)) throw new Error('Invalid webview CSP nonce');
  const csp = `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'`;
  return `<!DOCTYPE html><html lang="${escapeHtml(locale)}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><title>${escapeHtml(title)}</title><style nonce="${nonce}">${pageStyles}</style></head><body data-session-id="${escapeHtml(sessionId)}">${body}<script nonce="${nonce}">${script}</script></body></html>`;
}

const isCompaction = (item: TimelineItem) => item.kind === 'notice' && (item.noticeType === 'context-compacted' || item.title === '上下文已压缩');

function renderItem(item: TimelineItem, locale?: string): string {
  if (item.kind === 'answer') return renderNarrative(item);
  if (item.kind === 'notice' && item.title === '思考' && !item.detail) return `<li class="thinking-phase" title="${escapeHtml(item.summary)}">${timelineDot()}<span>思考阶段记录</span></li>`;
  if (item.kind === 'tool' || item.kind === 'file-change') {
    const description = describeDisplayAction(item);
    const entry = description.entries.length === 1 ? description.entries[0] : { label: description.label, key: '', count: 1 };
    return renderActionRow(item.id, entry, [item], 1);
  }
  const readable = canOpen(item);
  const title = isCompaction(item) ? uiLabel('compacted', locale)
    : item.kind === 'subagent' || item.kind === 'question' ? describeAction(item).label : item.title;
  const state = item.status === 'failed' ? '失败' : item.status === 'running' ? '进行中' : '';
  const summary = isCompaction(item) || item.kind === 'subagent' || item.kind === 'question' ? '' : item.summary;
  const content = `<span class="node-icon" aria-hidden="true">${actionIcon(isCompaction(item) ? 'COMPACT' : item.kind === 'question' ? 'ASK' : item.kind === 'subagent' ? 'AGENT' : 'WAIT')}</span><span><span class="node-title">${escapeHtml(title)}</span>${summary && summary !== title ? `<span class="node-summary">${escapeHtml(summary)}</span>` : ''}${state ? `<span class="node-meta">${state}</span>` : ''}</span>`;
  if (readable) return `<li data-observation-key="${escapeHtml(item.id)}"><details class="record-disclosure${isCompaction(item) ? ' compact-marker' : ''}" data-action-group="record:${escapeHtml(item.id)}"><summary class="node" data-action-group="record:${escapeHtml(item.id)}" data-status="${item.status}">${content}${disclosureArrow()}</summary>${inlineBody(item.id, [item])}</details></li>`;
  const reason = unavailableReason([item]);
  return `<li data-observation-key="${escapeHtml(item.id)}"><div class="node display-only${isCompaction(item) ? ' compact-marker' : ''}" data-status="${item.status}"${reason ? ` role="group" aria-label="${escapeHtml(title + ' — ' + reason)}" title="${escapeHtml(reason)}"` : ''}>${content}<span></span></div></li>`;
}

function renderNarrative(item: TimelineItem): string {
  const answer = item.kind === 'answer';
  const attachments = renderAttachments(item);
  return `<li class="narrative${answer ? ' final-answer' : ''}" data-text-id="${escapeHtml(item.id)}" data-observation-key="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}">${answer ? '<div class="answer-label">最终回答</div>' : ''}${item.status === 'failed' ? '<span class="availability">失败</span>' : ''}<div class="${answer ? 'answer-prose' : 'narrative-preview'}">${renderMarkdown(publicBody(item))}</div>${answer ? '' : '<button type="button" class="narrative-more" data-toggle-text aria-expanded="false" hidden>展开全文 ⌄</button>'}${item.availability === 'partial' || item.availability === 'unavailable' ? `<span class="availability">${escapeHtml(availabilityNames[item.availability])}</span>` : ''}${attachments}</li>`;
}


function renderActions(group: Extract<OutlineNode, { kind: 'actions' }>): string {
  const sections = actionRowSections(group).flatMap(section => {
    if (section.kind !== 'folded-actions') return [section];
    // A folded directory contains one concrete tool only. Keep source order;
    // non-adjacent tools must never be reordered merely to share a disclosure.
    const runs: typeof section[] = [];
    for (const row of section.rows) {
      const name = row.description.toolName || actionPresentation(row.description).type;
      const previous = runs.at(-1);
      if (previous && (previous.rows[0].description.toolName || actionPresentation(previous.rows[0].description).type) === name) previous.rows.push(row);
      else runs.push({ ...section, id: `${section.id}:${row.id}`, rows: [row] });
    }
    return runs.length === 1 ? [{ ...runs[0], id: section.id }] : runs;
  }).map(section => {
    const rows = section.rows.map(row => {
      if (row.role !== 'output') return renderActionRow(row.id, row.description, row.items, row.count, section.kind === 'result');
      const output = presentEvidence(row.items[0]).outputs.map(block => block.text ?? '').join('\n');
      if (!output.trim()) return '';
      return `<li class="shared-output" data-observation-key="${escapeHtml(row.id)}"><details class="tool-disclosure output-disclosure" data-action-group="output:${escapeHtml(row.id)}"><summary data-action-group="output:${escapeHtml(row.id)}" aria-label="展开共享返回" title="这组调用有返回内容，展开查看"><span class="output-label">OUT</span><span class="output-excerpt">${escapeHtml(output.trim().split(/\r?\n/).find(line => line.trim())?.slice(0, 96) || "返回内容")}</span><span class="output-lines">${output.split(/\r?\n/).length} 行</span>${disclosureArrow()}</summary>${inlineBody(row.id, row.items, renderIoPreview('OUT', output, row.id))}</details></li>`;
    }).join('');
    return rows;
  }).join('');
  return `<li><ol class="action-sections" aria-label="动作与证据">${sections}</ol></li>`;
}

function timelineDot(): string {
  return '<span class="timeline-dot" aria-hidden="true"></span>';
}

/** Small local glyphs: category is also written out, never conveyed by color alone. */
function actionIcon(type: string): string {
  const paths: Record<string, string> = {
    BASH: 'M2 4l4 4-4 4m6 0h6', READ: 'M3 2h7l3 3v9H3zM10 2v4h3M5.5 8h5m-5 3h5',
    COMPACT: 'M5 2H2v12h3M11 2h3v12h-3M5 5h6M5 8h4M5 11h6',
    FILE: 'M2 4h5l2 2h5v7H2z', SEARCH: 'M10.5 10.5L14 14M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
    WEB: 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0M2 8h12M8 2c-3 3-3 9 0 12 3-3 3-9 0-12',
    SKILL: 'M8 1.5l1.7 4.8L14.5 8l-4.8 1.7L8 14.5l-1.7-4.8L1.5 8l4.8-1.7z',
    AGENT: 'M8 3v3M4 10V7h8v3M3 11h2v3H3zm8 0h2v3h-2zM7 1h2v2H7z',
    EDIT: 'M3 10l8-8 3 3-8 8-4 1zM9 4l3 3', WRITE: 'M3 10l8-8 3 3-8 8-4 1zM9 4l3 3',
    TEST: 'M6 2v5l-4 6v1h12v-1l-4-6V2M5 2h6M5 10h6',
    BUILD: 'M8 1.5l6 3.3v6.4L8 14.5l-6-3.3V4.8zM2 4.8L8 8l6-3.2M8 8v6.5',
    GIT: 'M4 4v7m8-7v2c0 3-8 1-8 5M6 2a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6 13a2 2 0 1 1-4 0 2 2 0 0 1 4 0M14 2a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    INSTALL: 'M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3', WAIT: 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0M8 4v4l3 2',
    ASK: 'M2 2h12v9H7l-4 3v-3H2zM6 5c0-2 4-2 4 0 0 1-2 1-2 2m0 2h.01',
    ANSWER: 'M2 2h12v9H7l-4 3v-3H2zM5 5h6M5 8h4',
    IMAGE: 'M2 2h12v12H2zM2 11l4-4 3 3 2-2 3 3M10 5h.01',
    UNKNOWN: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2M6 6c0-2 4-2 4 0 0 1-2 1-2 3m0 2h.01',
  };
  return `<span class="action-symbol" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="${paths[type] ?? 'M3 4h10M3 8h10M3 12h10'}"/></svg></span>`;
}

function disclosureArrow(): string {
  return '<span class="disclosure-arrow" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg></span>';
}
function outputIndicator(): string {
  return '<span class="output-indicator" role="img" aria-label="有返回内容" title="有返回内容"><svg viewBox="0 0 16 16"><path d="M3 3h10v10H3zM5 6h6M5 8h6M5 10h3"/></svg></span>';
}
function renderIoPreview(label: 'IN' | 'OUT', text: string, id?: string): string {
  const preview = text.length > 2000 ? text.slice(0, 1999) + '…' : text;
  return `<div class="io-preview" data-preview="${label.toLowerCase()}"${id ? ` data-observation-key="${escapeHtml(id)}:preview:${label}"` : ''}><span class="io-preview-label">${label}</span><span class="io-preview-text">${escapeHtml(preview)}</span></div>`;
}
export function inlineRevision(items: TimelineItem[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}
function inlineBody(id: string, items: TimelineItem[], preview = ''): string {
  return `<div class="inline-evidence" data-inline-id="${escapeHtml(id)}" data-inline-revision="${inlineRevision(items)}">${preview}<p class="inline-placeholder">展开后读取完整记录…</p></div>`;
}
function fileLabels(items: TimelineItem[], entry: ActionEntry): string {
  const paths = [...new Set(items.flatMap(item => [
    ...presentEvidence(item).calls.flatMap(call => call.contents.flatMap(content => content.kind === 'diff' ? content.files.map(file => file.path) : [])),
    ...(item.kind === 'file-change' ? item.detail?.blocks.filter(block => ['patch', 'code'].includes(block.kind) && !['记录中的调用参数', '当时调用参数'].includes(block.label)).map(block => block.label.replace(/ · 当时(?:新增|删除)内容$/, '')) ?? [] : []),
  ]))];
  const basename = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) || path;
  return paths.map(path => paths.filter(other => basename(other) === basename(path)).length > 1 ? path.replace(/\\/g, '/').split('/').slice(-2).join('/') : basename(path)).join('、') || entry.label || '文件修改';
}
function renderActionRow(id: string, entry: ActionEntry, items: TimelineItem[], count: number, result = false): string {
  const presentation = actionPresentation(entry);
  const file = items.every(item => item.kind === 'file-change') || entry.toolName === 'Write';
  const files = file ? recordedFiles(items, entry) : [];
  if (files.length) {
    const labels = shortFileLabels(files.map(file => file.path));
    const failed = items.some(item => item.status === 'failed');
    return `<li class="file-change-result write-group${files.length === 1 ? ' write-single' : ''}" data-observation-key="${escapeHtml(id)}"><div class="write-heading"><span class="action-type">Write</span>${files.length > 1 ? `<span class="write-count">${files.length} 个文件</span>` : ''}${failed ? '<span class="write-failure">失败</span>' : ''}</div><div class="write-files">${files.map((file, index) => {
      const adds = file.operation === 'write' ? 0 : file.lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
      const removes = file.lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;
      return `<button type="button" class="write-file node-button" data-item-id="${fileEvidenceId(id, index, file.path)}" data-action-type="WRITE" aria-pressed="false" aria-label="查看 ${escapeHtml(labels[index])} 的文件记录" title="${escapeHtml(file.path)}"><span class="write-name">${escapeHtml(labels[index])}${file.moveTo ? `<span class="write-operation"> → ${escapeHtml(file.moveTo.split('/').at(-1) || file.moveTo)}</span>` : ''}</span>${['add', 'delete'].includes(file.operation) ? `<span class="write-operation">${file.operation === 'add' ? '新增' : '删除'}</span>` : ''}${file.operation === 'write' ? `<span class="write-count">${file.lines.length} 行</span>` : `<span class="write-added">+${adds}</span>${removes ? `<span class="write-removed">−${removes}</span>` : ''}`}<span class="detail-arrow" aria-hidden="true">↗</span></button>`;
    }).join('')}</div></li>`;
  }
  const toolName = file ? 'Write' : entry.toolName === 'Web 来源' ? presentation.type : entry.toolName || presentation.type;
  const type = file ? 'WRITE' : presentation.type;
  const readable = items.some(canOpen);
  const states = items.some(item => item.commandInput) ? items.filter(item => item.commandInput) : items;
  const status = states.some(item => item.status === 'failed') ? 'failed' : states.some(item => item.status === 'running') ? 'running' : 'info';
  const state = status === 'failed' ? '失败' : status === 'running' ? '进行中' : '';
  const label = (file ? fileLabels(items, entry) : entry.toolName === 'Web 来源' ? entry.label.replace(/^Web · /, '') : (entry.toolName ? entry.label : presentation.label) || entry.label).replace(/\s+/g, ' ').trim();
  const hasOutput = items.some(item => presentEvidence(item).outputs.length > 0);
  const ownOutput = items.some(item => item.commandInput) || items.length === 1 && presentEvidence(items[0]).calls.length === 1;
  const disclosureKey = 'tool:' + createHash('sha256').update(JSON.stringify([items.filter(item => !item.commandInput && !item.patchInput).map(item => item.id), entry.key])).digest('hex');
  const attributes = `class="action-row" data-action-type="${type}" data-status="${status}"${result ? ' data-result-entry="true"' : ''} title="${escapeHtml([toolName, label, readable ? '展开记录' : unavailableReason(items)].filter(Boolean).join(' · '))}"`;
  const content = `<span class="action-copy"><span class="action-type">${escapeHtml(toolName)}</span>${state ? `<span class="action-state">${state}</span>` : ''}<span class="action-purpose"><span class="action-purpose-text">${escapeHtml(label)}${count > 1 ? ` <span class="action-count">×${count}</span>` : ''}</span></span></span>`;
  const classes = `${toolName === 'Bash' ? 'bash-step ' : ''}${file ? 'file-change-result ' : ''}tool-step`;
  if (!readable) return `<li class="${classes}" data-observation-key="${escapeHtml(id)}"><div ${attributes} role="group" aria-label="${escapeHtml([toolName, label, unavailableReason(items), state].filter(Boolean).join(' · '))}">${content}<span></span></div></li>`;
  let preview = '';
  if (toolName === 'Bash' && entry.key.startsWith('["invocation",')) {
    let args: Record<string, unknown> = {}; try { args = JSON.parse(entry.key)[2] ?? {}; } catch { /* Keep readable source. */ }
    const command = typeof args.cmd === 'string' ? args.cmd : typeof args.command === 'string' ? args.command : label;
    preview = renderIoPreview('IN', command, id);
  }
  return `<li class="${classes}" data-observation-key="${escapeHtml(id)}"><details class="tool-disclosure${toolName === 'Bash' ? ' bash-disclosure' : ''}" data-action-group="${disclosureKey}"><summary ${attributes} data-action-group="${disclosureKey}">${content}<span class="action-affordance">${ownOutput && hasOutput && toolName !== 'Read' ? outputIndicator() : ''}${disclosureArrow()}</span></summary>${inlineBody(id, items, preview)}</details></li>`;
}

function renderAttachments(item: TimelineItem): string {
  const extras = item.detail?.blocks.filter(block => !(block.kind === 'text' && publicBodyLabels.has(block.label))) ?? [];
  const label = extras.every(block => block.kind === 'image') ? `附图 ${extras.length} 张` : '附带记录';
  return extras.length ? `<details class="narrative-attachments" data-action-group="attachments:${escapeHtml(item.id)}"><summary>${label} ${disclosureArrow()}</summary>${extras.map(block => renderBlock(block, item)).join('')}</details>` : '';
}

/**
 * The card keeps six lines; 展开全文 reads the whole request in the editor area,
 * where pasted images keep their size. A request with images or attached
 * records always offers it, even when its words fit.
 */
function renderRequest(item: TimelineItem): string {
  const extras = item.detail?.blocks.some(block => !(block.kind === 'text' && publicBodyLabels.has(block.label)));
  const more = canOpen(item)
    ? `<button type="button" class="question-more" data-item-id="${escapeHtml(item.id)}" data-open-text${extras ? ' data-always' : ''} aria-pressed="false"${extras ? '' : ' hidden'}>展开全文</button>`
    : '<button type="button" class="question-more" data-toggle-text aria-expanded="false" hidden>展开全文</button>';
  return `<section class="turn-question" data-text-id="${escapeHtml(item.id)}" aria-label="用户问题"><div class="question-text">${renderUserText(publicBody(item))}</div><div class="question-foot">${more}</div></section>`;
}

function renderTurn(group: TurnGroup, locale?: string, latest = false, provider?: Provider): string {
  const keyed = (html: string, id: string) => html.slice(0, html.indexOf('>')).includes('data-observation-key=') ? html
    : html.replace(/^<(li|section)/, `<$1 data-observation-key="${escapeHtml(id)}"`);
  return renderChapterTurn(group, {
    publicBody,
    request: item => keyed(renderRequest(item), item.id),
    record: item => keyed(renderItem(item, locale), item.id),
    answer: renderNarrative,
    attachments: renderAttachments,
    unavailable: unavailableReason,
  }, latest, provider);
}

function toolbarIcon(action: string, label: string, path: string): string {
  return `<button type="button" class="icon-button" data-action="${action}" aria-label="${label}" title="${label}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg></button>`;
}

function requestFirstSentence(group: TurnGroup): string {
  // These are source words, never a generated title or inferred task summary.
  const request = plainPasted(group.request).trim();
  const sentence = request.match(/^[\s\S]*?(?:[。！？!?]|\.(?=\s|$)|\n|$)/)?.[0].trim() ?? request;
  return sentence || '未取得本轮问题';
}

export function projectSidecar({ projectName, session, locale }: Pick<SidecarRenderOptions, 'projectName' | 'session' | 'locale'>, cache?: TurnRenderCache): SidecarProjection {
  // Reverse only the turn groups; events inside each turn keep source order.
  const groups = session ? visibleTurnGroups(session).reverse() : [];
  const turns = groups.filter(group => group.turnId);
  const selected = groups[0];
  const map = groups.map(group => {
    const actionCount = group.items.filter(item => ['tool', 'file-change', 'subagent'].includes(item.kind)).length;
    const weight = actionCount < 3 ? 1 : actionCount < 10 ? 2 : actionCount < 30 ? 3 : 4;
    const label = group.turnId ? `第 ${group.ordinal} 轮` : '未归属回合的记录';
    const title = `${label}${group.request ? ' · ' + plainPasted(group.request) : ''}`;
    return `<button type="button" class="turn-mark" data-turn-id="${escapeHtml(group.key)}" data-weight="${weight}" aria-label="${escapeHtml(title)}" aria-controls="turn-lens" aria-expanded="false" aria-pressed="${group === selected}"><span class="turn-tick" aria-hidden="true"></span></button>`;
  }).join('');
  const lens = groups.map(group => {
    const label = group.turnId ? `第 ${group.ordinal} 轮` : '未归属';
    const requestItem = group.items.find(item => item.kind === 'request');
    const request = plainPasted(requestItem ? publicBody(requestItem) : group.request).slice(0, 2000) || '未取得本轮问题';
    const title = requestFirstSentence(group);
    return `<button type="button" data-lens-turn-id="${escapeHtml(group.key)}" aria-label="${escapeHtml(`${label} · ${title}`)}" aria-pressed="${group === selected}"><span class="turn-lens-number">${label}</span><span class="turn-lens-request">${escapeHtml(request)}</span></button>`;
  }).join('');
  const warnings = session?.warnings.map(warning => `<p class="notice session-warning">${escapeHtml(warning)}</p>`).join('') ?? '';
  const name = session?.title.trim() || (session ? `${providerName(session.provider)} · ${session.id.slice(0, 8)}` : '选择会话');
  const nameSource = session?.titleSource === 'codex-index' ? '名称来自 Codex 会话索引，刷新时重新读取。'
    : session?.titleSource === 'claude-ai-title' ? '名称来自 Claude 会话记录，刷新时重新读取。'
    : '当前以首条请求作为会话名称；未取得单独保存的名称。';
  const identity = session ? `${name}\n${providerName(session.provider)} · ${session.id}\n${projectName} · ${turns.length} 轮\n${nameSource}` : projectName;
  const empty = session ? groups.length ? '' : '<div class="empty"><h2>暂没有可展示的过程</h2><p>可在覆盖记录中查看来源与未支持项。</p></div>'
    : '<div class="empty"><h2>选择要观察的会话</h2><p>从最新回合向下阅读，左侧目录可定位到任意回合。</p></div>';
  const keys = new Set(groups.map(group => group.key));
  if (cache) for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
  return { sessionKey: session ? `${session.provider}:${session.id}` : '', name, identity, map, lens, warnings, empty,
    turns: groups.map(group => {
      // Exact public model invalidation, including late output to an old turn.
      // Retain only a digest, not another copy of all evidence bodies.
      const latest = group === groups[0];
      const digest = cache ? createHash('sha256').update(JSON.stringify([locale, latest, group])).digest('hex') : '';
      const previous = cache?.get(group.key);
      const html = previous?.digest === digest ? previous.html : renderTurn(group, locale, latest, session?.provider);
      cache?.set(group.key, { digest, html });
      return { key: group.key, html };
    }) };
}

export function renderSidecar({ projectName, session, nonce, streamId = '', locale }: SidecarRenderOptions, projection?: SidecarProjection): string {
  const p = projection ?? projectSidecar({ projectName, session, locale });
  const body = `<main class="sidecar" data-observation-stream="${escapeHtml(streamId)}" aria-label="Sidecar 过程观察">
    <header class="toolbar"><h1 class="session-title" title="${escapeHtml(p.identity)}">${escapeHtml(p.name)}</h1><span class="observation-status" title="按会话记录推断：最新一轮未结束且仍有新记录时显示运行中" ${streamId ? '' : 'hidden'}></span><div class="controls">${streamId ? '<button type="button" class="follow-button" data-follow-toggle aria-pressed="true">跟随 ↓</button>' : ''}${toolbarIcon('chooseSession', '切换会话', 'M3 4.5h10m-3-3 3 3-3 3M13 11.5H3m3-3-3 3 3 3')}${toolbarIcon('refresh', '刷新', 'M12.5 5A5 5 0 1 0 13 9M12.5 1.5V5H9')}${toolbarIcon('coverage', '覆盖记录', 'M3 2.5h10v11H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3')}</div></header>
    <div class="observation-problem" hidden></div><div class="reading-layout"><nav class="turn-map" aria-label="回合目录（从新到旧）">${p.map}</nav><nav id="turn-lens" class="turn-lens" aria-label="对应回合的问题预览" hidden>${p.lens}</nav><section class="timeline" tabindex="0" aria-label="完整会话过程（从新到旧）"><div data-live-warnings>${p.warnings}</div><div data-live-empty>${p.empty}</div>${p.turns.map(turn => turn.html).join('')}</section></div></main>`;
  return documentHtml('Agent Sidecar', body, nonce, p.sessionKey, locale);
}

/** Workspaces the Sidecar cannot map to one local project directory. */
export type WorkspaceGap = 'untrusted' | 'empty' | 'multi' | 'remote';
export const workspaceGaps: Readonly<Record<WorkspaceGap, { title: string; body: string; openFolder?: boolean }>> = {
  empty: { title: '打开一个项目文件夹', body: 'Sidecar 按项目目录查找 Claude Code 和 Codex 的会话记录；当前窗口还没有打开文件夹。', openFolder: true },
  multi: { title: '暂不支持多文件夹工作区', body: 'Sidecar 按单个项目目录匹配会话。请在单独的窗口里打开要观察的项目文件夹。' },
  remote: { title: '暂不支持远程工作区', body: 'Sidecar 目前只读取本机的会话记录，远程工作区的记录在远程机器上。' },
  untrusted: { title: '需要先信任此工作区', body: '信任后 Sidecar 才读取这个项目的本地会话记录。' },
};

export function renderWorkspaceGap(gap: WorkspaceGap, nonce: string, locale?: string): string {
  const copy = workspaceGaps[gap];
  const body = `<main class="workspace-gap" data-workspace-gap="${gap}"><div class="empty"><h2>${escapeHtml(copy.title)}</h2><p>${escapeHtml(copy.body)}</p>${copy.openFolder ? '<button type="button" class="gap-action" data-action="openFolder">打开文件夹…</button>' : ''}</div></main>`;
  return documentHtml('Agent Sidecar', body, nonce, '', locale);
}

function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
}

function renderQuestionJson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.questions) && !('answers' in data) && !('annotations' in data)) return undefined;
  let result = '';
  if (Array.isArray(data.questions)) {
    result += data.questions.map((question, index) => {
      if (!question || typeof question !== 'object' || Array.isArray(question)) return `<div class="question-record"><h3>问题 ${index + 1}</h3><p>${escapeHtml(displayValue(question))}</p></div>`;
      const record = question as Record<string, unknown>;
      const options = Array.isArray(record.options) ? `<ul class="question-options">${record.options.map(option => {
        if (!option || typeof option !== 'object' || Array.isArray(option)) return `<li>${escapeHtml(displayValue(option))}</li>`;
        const entry = option as Record<string, unknown>;
        return `<li>${escapeHtml(displayValue(entry.label ?? entry))}${entry.description ? `<span>${escapeHtml(displayValue(entry.description))}</span>` : ''}</li>`;
      }).join('')}</ul>` : '';
      return `<div class="question-record"><h3>${escapeHtml(displayValue(record.header ?? `问题 ${index + 1}`))}</h3><p>${escapeHtml(displayValue(record.question ?? record))}</p>${options}</div>`;
    }).join('');
  }
  for (const [key, label] of [['answers', '记录的回答'], ['annotations', '附加说明']] as const) {
    if (!(key in data)) continue;
    const entry = data[key];
    result += `<h3>${label}</h3>`;
    result += entry && typeof entry === 'object' && !Array.isArray(entry)
      ? `<dl class="answers">${Object.entries(entry as Record<string, unknown>).map(([name, answer]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(displayValue(answer))}</dd>`).join('')}</dl>`
      : `<p class="plain-text">${escapeHtml(displayValue(entry))}</p>`;
  }
  // The raw structured record preserves optional fields that the reading view does not interpret.
  return `${result}<details><summary>原始结构字段</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`;
}

// These exact labels are authored by the current adapters. Unknown labels,
// filenames and source titles remain untouched; block kind does not imply IN/OUT.
const detailBlockLabels: Readonly<Record<string, string>> = {
  '记录中的调用参数': '调用输入', '当时调用参数': '调用输入', '当时命令': '命令输入',
  '后续读取调用': '后续读取输入', '同一调用 ID 的另一组记录参数': '输入版本（同一调用）',
  '当时返回的内容': '返回', 'MCP 当时返回的内容': '返回', '当时返回': '返回',
  '记录的 stdout': 'stdout', '记录的 stderr（不单独判定失败）': 'stderr（不等于失败）',
  'MCP 返回错误': '协议错误', '当时异步启动状态': '启动状态', '父会话收到的通知': '主会话通知',
  '子 Agent 返回': '子任务返回', '子 Agent 状态': '子任务状态',
  'ToolSearch 返回的工具引用（不代表调用）': '工具引用（非调用）',
  '问题及记录的回答': '历史问答', '随请求附带的 IDE 背景': '附带背景', '当时记录的片段': '历史片段',
};

function renderBlock(block: EvidenceBlock, item: TimelineItem): string {
  if (isCompaction(item) && block.kind === 'text' && block.label === '压缩摘要') {
    return `<section class="evidence-block" data-evidence-kind="text">${renderMarkdown(block.text ?? '')}</section>`;
  }
  let content: string;
  if (block.kind === 'image') {
    const src = safeImage(block);
    content = src ? `<figure><img src="${src}" alt="${escapeHtml(block.label)}"></figure>` : '<p>图像不可用</p>';
  } else if (block.kind === 'patch') {
    const files = parsePatch(block.text ?? '');
    content = files ? renderInputContent({ kind: 'diff', files }) : `<pre class="patch" aria-label="记录中的 patch">${(block.text ?? '').split('\n').map(line => {
      const className = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') ? 'patch-header' : line.startsWith('+') ? 'patch-added' : line.startsWith('-') ? 'patch-removed' : '';
      return `<span class="patch-line ${className}">${escapeHtml(line)}</span>`;
    }).join('')}</pre>`;
  } else if (block.kind === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(block.text ?? ''); } catch { /* Preserve a malformed or partial source as text. */ }
    const questions = item.kind === 'question' ? renderQuestionJson(parsed) : undefined;
    content = questions ?? `<pre>${escapeHtml(parsed === undefined ? block.text ?? '' : JSON.stringify(parsed, null, 2))}</pre>`;
  } else if (block.kind === 'code') {
    content = renderCode(block.text ?? '');
  } else {
    content = publicLabels.has(block.label) && ['request', 'message', 'answer', 'subagent'].includes(item.kind) ? (item.kind === 'request' ? renderUserText : renderMarkdown)(block.text ?? '') : `<div class="plain-text">${escapeHtml(block.text ?? '')}</div>`;
  }
  // Patch filenames and Web result titles come from source content, not adapter
  // UI labels. Even an exact collision with a known label must stay verbatim.
  const authoredLabel = block.kind !== 'patch' && block.kind !== 'image' && item.title !== 'Web 来源';
  const label = authoredLabel && Object.hasOwn(detailBlockLabels, block.label) ? detailBlockLabels[block.label] : block.label;
  const prose = publicLabels.has(block.label) && ['request', 'message', 'answer', 'subagent'].includes(item.kind);
  return `<section class="evidence-block" data-evidence-kind="${block.kind}">${prose ? '' : `<h3 title="${escapeHtml(block.label)}">${escapeHtml(label)}</h3>`}${content}</section>`;
}

function renderInputContent(content: InputContent): string {
  if (content.kind === 'fields') return `<dl class="tool-fields">${content.rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>`;
  if (content.kind === 'code') {
    const code = renderCode(content.text, content.language);
    return content.label ? `<details><summary>${escapeHtml(content.label)}</summary>${code}</details>` : code;
  }
  return content.files.map(file => `<section class="patch-file"><h3>${escapeHtml(file.path)}${file.moveTo ? ` → ${escapeHtml(file.moveTo)}` : ''}<span>${({ add: '新增', update: '修改', delete: '删除', write: '当时写入内容' })[file.operation]}</span></h3><pre class="patch">${file.lines.map(line => `<span class="patch-line ${file.operation === 'write' ? '' : line.startsWith('+') ? 'patch-added' : line.startsWith('-') ? 'patch-removed' : line.startsWith('@@') ? 'patch-header' : ''}">${escapeHtml(line)}</span>`).join('')}</pre></section>`).join('');
}

function detailState(item: TimelineItem, includeStatus = true): string {
  const status = includeStatus ? statusNames[item.status] : '';
  const result = item.result === 'not-observed' ? '尚未取得返回' : item.result === 'empty' ? '已取得空返回'
    : item.result === 'unreadable' ? '返回尚不可读' : item.result === 'partial' ? '返回仅部分可读' : '';
  const availability = item.availability === 'partial' && item.result !== 'partial' ? '部分内容' : item.availability === 'unavailable' ? '内容不可用' : '';
  if (!status && !result && !availability) return '';
  return `<div class="detail-state-line">${status ? `<span class="detail-state" data-status="${item.status}">${escapeHtml(status)}</span>` : ''}${result ? `<span>${escapeHtml(result)}</span>` : ''}${availability ? `<span>${availability}</span>` : ''}</div>`;
}

function evidenceSources(item: TimelineItem, includeOutput = false): string {
  const detail = item.detail;
  const metadata: Array<[string, string]> = [['会话', item.sessionId], ...(item.turnId ? [['回合', item.turnId] as [string, string]] : []),
    ['观察记录', item.id], ['状态', statusNames[item.status]], ['原始名称', item.title], ...(detail?.title && detail.title !== item.title ? [['详情名称', detail.title] as [string, string]] : [])];
  const sources = item.sources.map(source => `<li><span class="source-path">${escapeHtml(source.file)}:${escapeHtml(source.line)}</span>${source.recordId ? `<br>记录 ${escapeHtml(source.recordId)}` : ''}${source.block !== undefined ? ` · 内容块 ${escapeHtml(source.block)}` : ''}</li>`).join('');
  const notes = [detail?.provenance, detail?.notice].filter(Boolean).map(note => `<p class="render-note">${escapeHtml(note)}</p>`).join('');
  const rawInputs = detail?.blocks.filter(block => ['记录中的调用参数', '当时调用参数', '当时命令', '原始执行 argv'].includes(block.label) && ['code', 'json'].includes(block.kind)).map(block => renderCode(block.text ?? '')).join('');
  const related = includeOutput || item.id.startsWith('write-file:') ? presentEvidence(item).outputs.map(block => renderCode(block.text ?? '')).join('') : '';
  return `<details class="sources" data-evidence-source><summary>来源与记录信息 · ${item.sources.length} 处</summary><dl class="source-metadata">${metadata.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>${notes}<ul class="source-list">${sources || '<li>尚无可核对的来源位置。</li>'}</ul>${rawInputs ? `<h3>原始输入</h3>${rawInputs}` : ''}${related ? `<h3>关联调用返回（可能包含其它操作）</h3>${related}` : ''}</details>`;
}

function evidenceContent(item: TimelineItem): string {
  const presentation = presentEvidence(item);
  const input = presentation.calls.some(call => call.contents.length) ? `<section class="io-section" data-io="input"><h2>Input</h2>${presentation.calls.map(call => `<div class="invocation-input">${presentation.calls.length > 1 ? `<h3>${escapeHtml(call.name)}</h3>` : ''}${call.contents.map(renderInputContent).join('')}</div>`).join('')}</section>` : '';
  const output = !item.id.startsWith('write-file:') && presentation.outputs.length ? `<section class="io-section" data-io="output"><h2>Output</h2>${presentation.outputs.flatMap(block => toolOutputContents(item, block.text ?? '')).map(renderInputContent).join('')}</section>` : '';
  return `${input}${output}${presentation.other.map(block => renderBlock(block, item)).join('')}${evidenceSources(item)}`;
}

/** Full public evidence, loaded only for an expanded row in the process rail. */
export function renderInlineEvidence({ item, items, entry, role }: OutlineEvidence): string {
  const records = items ?? [item];
  const linked = records.filter(record => record.commandInput && records.some(parent => parent.id === record.commandInput!.itemId));
  if (role !== 'output' && linked.length > 1) {
    // Repeated reads can share a directory row. Each occurrence still owns its
    // own native result; never show only the first occurrence's evidence.
    return records.filter(record => !linked.includes(record)).map(parent => renderInlineEvidence({
      item: parent, items: [parent, ...linked.filter(record => record.commandInput!.itemId === parent.id)], entry, role,
    })).join('');
  }
  const native = records.find(record => record.commandInput);
  if (native && role !== 'output') {
    const parent = records.find(record => record.id === native.commandInput!.itemId);
    const call = parent && recordedToolInputs(parent)[native.commandInput!.callIndex];
    if (call && parent) {
      const output = presentEvidence(native).outputs;
      const sources: TimelineItem = { ...parent, status: native.status, sources: [...parent.sources, ...native.sources], detail: {
        title: parent.detail?.title ?? parent.title,
        blocks: [...parent.detail?.blocks ?? [], ...native.detail?.blocks ?? []],
        notice: [parent.detail?.notice, native.detail?.notice].filter(Boolean).join('\n'),
        provenance: [parent.detail?.provenance, native.detail?.provenance].filter(Boolean).join('\n'),
      } };
      return `<section class="io-section" data-io="input">${invocationInput(call.name, call.input).map(renderInputContent).join('')}</section>${output.length ? `<details class="inline-return" data-inline-section="return"><summary><span>OUT</span>${disclosureArrow()}</summary><div data-io="output">${output.flatMap(block => toolOutputContents(native, block.text ?? '')).map(renderInputContent).join('')}</div></details>` : ''}${native.result === 'partial' || native.result === 'unreadable' ? '<p class="render-note">返回内容未完整取得。</p>' : ''}${evidenceSources(sources, true)}`;
    }
  }
  return records.map(record => {
    const evidence = presentEvidence(record);
    const state = detailState(record, false);
    if (role === 'output') return `${state}<section class="io-section" data-io="output"><h3>OUT</h3>${evidence.outputs.flatMap(block => toolOutputContents(record, block.text ?? '')).map(renderInputContent).join('')}</section>${evidenceSources(record)}`;
    if (entry?.key.startsWith('["invocation",') && evidence.calls.length > 1) {
      let args: unknown, index = 0; try { [, , args, index] = JSON.parse(entry.key); } catch { /* Keep the record below. */ }
      const call = recordedToolInputs(record)[index];
      if (call && JSON.stringify(call.input) === JSON.stringify(args)) return `${state}<section class="io-section" data-io="input">${invocationInput(call.name, call.input).map(renderInputContent).join('')}</section>${evidenceSources(record)}`;
    }
    const input = evidence.calls.map(call => `<section class="io-section" data-io="input"><h3>${escapeHtml(call.name)} · 原始调用</h3>${call.contents.map(renderInputContent).join('')}</section>`).join('');
    const output = evidence.outputs.length ? `<details class="inline-return" data-inline-section="return"><summary><span>OUT</span>${disclosureArrow()}</summary><div data-io="output">${evidence.outputs.flatMap(block => toolOutputContents(record, block.text ?? '')).map(renderInputContent).join('')}</div></details>` : '';
    return `${state}${input}${output}${evidence.other.filter(block => block.label !== '原始执行 argv').map(block => renderBlock(block, record)).join('')}${evidenceSources(record)}`;
  }).join('');
}

/** A read of one file opens as that file; the command and sources stay folded below. */
function renderFileReading(reading: FileReading, records: TimelineItem[]): string {
  const end = reading.start === undefined ? undefined : reading.start + reading.lines.length - 1;
  return `<section class="file-reading"><p class="file-meta"><span class="file-path">${escapeHtml(reading.path)}</span>${end !== undefined ? `<span>第 ${reading.start}–${end} 行</span>` : ''}<span>会话当时读到的内容，不是当前文件</span></p>`
    + `${renderFile(reading.lines, reading.start, reading.language)}</section>${records.map(record => evidenceSources(record)).join('')}`;
}

export function renderDetail({ item, items, provider, kept, nonce, locale }: DetailRenderOptions): string {
  const records = items?.length ? items : undefined;
  // Each read keeps its own output. A call and its native execution record are one
  // read, and the native record carries the clean output.
  const all = records ?? [item];
  const reads = all.filter(record => !record.commandInput || !all.some(parent => parent.id === record.commandInput!.itemId)).map(parent => {
    const native = all.find(record => record.commandInput?.itemId === parent.id);
    return { reading: (native && fileReading(native)) || fileReading(parent), sources: native ? [parent, native] : [parent] };
  });
  const reading = reads.length && reads.every(read => read.reading) ? reads[0].reading : undefined;
  const multiple = Boolean(records && records.length > 1);
  // Synthetic action headers already carry the selected semantic row name.
  // Original records with a purposeful detail title keep it; otherwise name
  // actual action inputs without replacing the original name in the source view.
  const callNames = presentEvidence(records?.length === 1 ? records[0] : item).calls.map(call => call.name);
  const title = isCompaction(item) ? uiLabel('compactionSummary', locale) : callNames.length > 1 ? [...new Set(callNames)].map(name => `${name}${callNames.filter(value => value === name).length > 1 ? ` × ${callNames.filter(value => value === name).length}` : ''}`).join(' · ')
    : !records && ['tool', 'file-change', 'subagent'].includes(item.kind) && (!item.detail?.title || item.detail.title === item.title)
    ? describeDisplayAction(item).label : item.detail?.title ?? item.title;
  // A short request keeps its words in the summary; its detail still leads with them.
  const words = !records && item.kind === 'request' && !item.detail?.blocks.some(block => block.kind === 'text' && publicLabels.has(block.label))
    ? `<section class="evidence-block" data-evidence-kind="text">${renderUserText(item.summary)}</section>` : '';
  const content = words + (reading ? reads.length === 1 ? renderFileReading(reading, reads[0].sources)
    : reads.map((read, index) => `<section class="evidence-record"><header class="evidence-record-heading"><h2>第 ${index + 1} 次读取</h2></header>${renderFileReading(read.reading!, read.sources)}</section>`).join('')
    : records
    ? `${records.map((record) => `<section class="evidence-record" data-source-item-id="${escapeHtml(record.id)}">${multiple ? `<header class="evidence-record-heading"><h2>${escapeHtml(describeDisplayAction(record).label)}</h2>${detailState(record)}</header>` : ''}${evidenceContent(record)}</section>`).join('')}`
    : evidenceContent(item));
  const body = `<main class="detail" aria-label="过程证据详情"><header class="toolbar"><span class="detail-identity">${providerName(provider)}<span aria-hidden="true">·</span><span data-keep-status>${kept ? '已保留' : '临时预览'}</span></span><button type="button" class="quiet-button" data-action="keep"${kept ? ' disabled' : ''}>${kept ? '已保留' : '保留此页'}</button></header><section class="detail-heading"><h1>${escapeHtml(reading ? reading.path.replace(/\\/g, '/').split('/').at(-1) || reading.path : title)}</h1>${multiple ? '' : detailState(records?.[0] ?? item)}</section><div class="detail-content">${content}</div></main>`;
  return documentHtml(title, body, nonce, item.sessionId, locale);
}
