import type { ChapterRow } from './chapters';
import type { SessionData, TimelineItem } from './model';
import { elapsed } from './turn-view';
import { callText, callTool } from './call-line';

/**
 * An Agent call, as both products set it (design v10): a dot whose colour is
 * the subagent's state, its description, and under it what the run came to.
 * A run of Agent calls whose descriptions share a lead ("Name brainstorm: …")
 * says the lead once, beside the tool's name.
 */
export type AgentState = 'running' | 'done' | 'failed' | 'stopped';

/** The call's own record: the subagent for an Agent call, the call itself for a workflow. */
const agentOf = (row: ChapterRow): TimelineItem | undefined => row.items.find(item => item.kind === 'subagent') ?? row.items[0];

export function agentState(row: ChapterRow): AgentState {
  const item = agentOf(row);
  // Announced by the hook, not yet in the record: it has just set off.
  if (!item) return row.pending || row.running ? 'running' : 'done';
  if (item.backgroundTask?.state === 'stopped' || item.interrupted) return 'stopped';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'running' || (item.backgroundTask?.state === 'running')) return 'running';
  return 'done';
}

const tokens = (count: number): string => count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M tokens` : count >= 1000 ? `${(count / 1000).toFixed(1)}k tokens` : `${count} tokens`;

/**
 * What the run came to: in the background or not, how long, its tokens and its
 * calls. The notification's own figures when it has finished; while it runs,
 * the time since it started and the calls in its own record so far.
 */
export function agentFacts(row: ChapterRow, now: number, subagent?: SessionData): string {
  const item = agentOf(row);
  if (!item) return '';
  const usage = item.agentUsage;
  const started = item.timestamp ? Date.parse(item.timestamp) : NaN;
  const running = agentState(row) === 'running';
  const lastAt = subagent?.items.reduce((latest, entry) => Math.max(latest, entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0), 0) ?? 0;
  const duration = usage?.durationMs ?? (Number.isFinite(started) ? (running ? now : lastAt || NaN) - started : NaN);
  const calls = usage?.toolUses ?? (subagent ? subagent.items.filter(entry => ['tool', 'file-change', 'subagent', 'question'].includes(entry.kind)).length : undefined);
  return [
    item.backgroundTask ? '后台' : '',
    Number.isFinite(duration) && duration >= 0 ? elapsed(duration) : '',
    usage?.tokens !== undefined ? tokens(usage.tokens) : '',
    calls !== undefined ? `${calls} 次调用` : '',
  ].filter(Boolean).join(' · ');
}

/** A lead shared by every description, ended by one of these: said once. */
const SEPARATOR = /(.+?)(?::\s+|：\s*|\s+[-–—·]\s+)/;

export function agentGroup(labels: string[]): { lead?: string; names: string[] } {
  if (labels.length < 2) return { names: labels };
  const match = SEPARATOR.exec(labels[0]);
  if (!match) return { names: labels };
  const head = match[0];
  if (!labels.every(label => label.startsWith(head) && label.length > head.length)) return { names: labels };
  return { lead: match[1].trim(), names: labels.map(label => label.slice(head.length)) };
}

/**
 * Calls that deal with another agent, or take on a way of working (design
 * v14), set as Agent calls are rather than as tools: a mark, what the call is
 * to, and under it in grey what it came to.
 */
export type Partner = 'Agent' | 'SendMessage' | 'Skill' | 'Workflow';

export function partnerOf(row: ChapterRow, session: SessionData): Partner | undefined {
  // A background task reporting back reads as the call it finished, a line on the tree.
  if (row.output || row.items[0]?.kind === 'notice') return undefined;
  if (row.items[0]?.kind === 'subagent') return 'Agent';
  const tool = callTool(row, session);
  // An Agent call the hook announced: drawn as its record will be.
  if (tool === 'Agent' && !row.items.length) return 'Agent';
  return tool === 'SendMessage' || tool === 'Skill' || tool === 'Workflow' ? tool : undefined;
}

export interface PartnerLine {
  /** Before the name: the run's state as a dot (an agent, a workflow), → the agent a message went to, ◆ a skill. */
  mark: 'dot' | '→' | '◆';
  state: AgentState;
  /** In the body colour: the agent's task, the agent written to, the skill, what the workflow does. */
  name: string;
  /** In grey under the name: what the run came to, the message, the skill's arguments. */
  facts: string;
  /** A workflow's phases, in the script's order. */
  phases: string[];
}

export interface PartnerRun {
  /** The tool's name, on the run's first line. */
  tool: string;
  /** Said once beside it: the lead the agents' descriptions share, a workflow's name. */
  lead?: string;
  lines: PartnerLine[];
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** The call's input: the hook's copy for a call announced, else the record's. */
function inputOf(row: ChapterRow): Record<string, unknown> {
  if (row.input) return row.input;
  const block = row.items[0]?.detail?.blocks.find(candidate => candidate.label === '当时调用参数')?.text;
  try { const value = JSON.parse(block ?? ''); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

/** A message goes to an agent by its id: named for the task it was started on, as its own call says it. */
function recipient(to: string, session: SessionData): string {
  const agent = session.items.find(item => item.kind === 'subagent' && item.agentId === to);
  if (!agent) return to;
  const block = agent.detail?.blocks.find(candidate => candidate.label === '当时调用参数')?.text;
  try { const description = text(JSON.parse(block ?? '').description); if (description) return oneLine(description); } catch { /* Named by its id. */ }
  return to;
}

/** The literal after `export const meta =` in a workflow's script, up to its closing brace. */
function metaBlock(script: string): string {
  const start = /\bmeta\s*=\s*\{/.exec(script);
  if (!start) return '';
  let depth = 0, quote = '';
  for (let at = start.index + start[0].length - 1; at < script.length; at++) {
    const ch = script[at];
    if (quote) { if (ch === '\\') at++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return script.slice(start.index, at + 1);
  }
  return '';
}

const field = (block: string, key: string): string[] =>
  [...block.matchAll(new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`, 'g'))].map(match => oneLine(match[2].replace(/\\(.)/g, '$1')));

/** A workflow's name, what it does and its phases, from its script's meta, or the saved workflow it names. */
export function workflowMeta(input: Record<string, unknown>): { name: string; description: string; phases: string[] } {
  const block = metaBlock(text(input.script));
  const phases = /\bphases\s*:\s*\[([\s\S]*)\]/.exec(block)?.[1] ?? '';
  return { name: field(block, 'name')[0] || text(input.name), description: field(block, 'description')[0] || '', phases: field(phases, 'title') };
}

/** A run of one partner tool's calls, as both views set it. `subagent` is a call's own session, when its record is there. */
export function partnerRun(rows: ChapterRow[], session: SessionData, now: number, subagent: (row: ChapterRow) => SessionData | undefined = () => undefined): PartnerRun {
  const kind = partnerOf(rows[0], session);
  const tool = callTool(rows[0], session);
  const repeat = (row: ChapterRow) => row.count > 1 ? ` · ${row.count} 次` : '';
  if (kind === 'SendMessage') return { tool, lines: rows.map(row => {
    const input = inputOf(row);
    const said = callText(row, session).text;
    return { mark: '→', state: agentState(row), name: (text(input.to) ? recipient(text(input.to), session) : said.split(' · ')[0]) + repeat(row),
      facts: oneLine(text(input.summary) || text(input.message).split('\n')[0] || said.split(' · ').slice(1).join(' · ')), phases: [] };
  }) };
  if (kind === 'Skill') return { tool, lines: rows.map(row => {
    const input = inputOf(row);
    const [name, ...rest] = callText(row, session).text.split(' · ');
    return { mark: '◆', state: agentState(row), name: (text(input.skill).replace(/^\//, '') || name) + repeat(row), facts: oneLine(text(input.args)) || rest.join(' · '), phases: [] };
  }) };
  if (kind === 'Workflow') {
    const metas = rows.map(row => workflowMeta(inputOf(row)));
    // One workflow: its name beside the tool's, what it does on its line. Several: each by its name.
    const lead = rows.length === 1 && metas[0].name && metas[0].description ? metas[0].name : undefined;
    return { tool, ...(lead ? { lead } : {}), lines: rows.map((row, index) => ({ mark: 'dot', state: agentState(row),
      name: ((lead ? metas[index].description : metas[index].name || metas[index].description) || callText(row, session).text) + repeat(row),
      facts: agentFacts(row, now), phases: metas[index].phases })) };
  }
  const group = agentGroup(rows.map(row => callText(row, session).text));
  return { tool, ...(group.lead ? { lead: group.lead } : {}), lines: rows.map((row, index) => ({ mark: 'dot', state: agentState(row),
    name: group.names[index] + repeat(row), facts: agentFacts(row, now, subagent(row)), phases: [] })) };
}
