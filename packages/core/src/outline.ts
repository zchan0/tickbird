import { createHash } from 'node:crypto';
import type { SessionData, TimelineItem } from './model';
import { groupSessionTurns, type TurnGroup } from './timeline';
import { actionPresentation, describeAction, type ActionDescription, type ActionEntry } from './actions';
import { describeDisplayAction, fileEvidenceId, recordedFiles, shortFileLabels, presentEvidence } from './presentation';
import { recordedToolInputs } from './actions';

export type OutlineNode =
  | { kind: 'narrative'; item: TimelineItem }
  | { kind: 'record'; item: TimelineItem }
  | { kind: 'actions'; key: string; items: TimelineItem[]; entries: Array<{ description: ActionDescription; items: TimelineItem[] }> };
export interface TurnOutline { nodes: OutlineNode[]; background: TimelineItem[]; boundaries: TimelineItem[] }
export interface ActionRow { id: string; description: ActionEntry; items: TimelineItem[]; count: number; role?: 'output' }
export interface ActionRowSection { id: string; kind: 'folded-actions' | 'result' | 'attention' | 'steps'; rows: ActionRow[] }
export interface OutlineEvidence { item: TimelineItem; items?: TimelineItem[]; entry?: ActionEntry; role?: 'output' }

/** Bounded opaque keys contain identity only, never result bodies or UI labels. */
const presentationId = (kind: string, identity: unknown[]): string => `${kind}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;

/** Semantic input occurrences, not a claim that each nested operation executed. */
export function actionRows(group: Extract<OutlineNode, { kind: 'actions' }>): ActionRow[] {
  const descriptions = new Map<TimelineItem, ActionDescription>();
  for (const entry of group.entries) for (const item of entry.items) descriptions.set(item, entry.description);
  const rows: ActionRow[] = [];
  const byKey = new Map<string, ActionRow>();
  for (const item of group.items) {
    const description = descriptions.get(item) ?? describeAction(item);
    // A source-result event is still evidence even if its description contains
    // no decoded invocation atoms. Never discard it from the reading surface.
    const atoms = description.entries.length ? description.entries : [{
      label: item.title === 'Web 来源' ? 'Web · 来源结果' : description.label || item.title,
      key: item.title === 'Web 来源' ? 'source:web-result' : `source:${description.key}`,
      count: 1,
    }];
    atoms.forEach((atom, atomIndex) => {
      let row = byKey.get(atom.key);
      if (!row) {
        row = { id: `action-row:${JSON.stringify([group.key, item.id, atomIndex])}`,
          description: { ...atom, ...(atom.targets ? { targets: [...atom.targets] } : {}) }, items: [], count: 0 };
        byKey.set(atom.key, row); rows.push(row);
      }
      if (!row.items.includes(item)) row.items.push(item);
      row.count += atom.count;
      row.description.count = row.count;
    });
  }
  return rows;
}

function actionSectionKind(item: TimelineItem, description: ActionDescription): ActionRowSection['kind'] {
  if (!item.result || description.unresolved || ['failed', 'running'].includes(item.status) || ['partial', 'unavailable'].includes(item.availability)
    || item.result === 'partial' || item.result === 'unreadable') return 'attention';
  // Input details are independently readable. Only the adapter can attest that
  // a return was observed, so block count/availability never implies a result.
  if (item.result === 'readable') return hasReadableEvidence(item) ? 'result' : 'attention';
  return 'folded-actions';
}

/** Source-ordered runs for the folding trial; never assigns shared output to atoms. */
export function actionRowSections(group: Extract<OutlineNode, { kind: 'actions' }>): ActionRowSection[] {
  const sections: ActionRowSection[] = [];
  let ordinary: TimelineItem[] = [];
  const descriptions = new Map<TimelineItem, ActionDescription>();
  for (const item of group.items) descriptions.set(item, describeDisplayAction(item));
  const descriptionFor = (item: TimelineItem) => descriptions.get(item) ?? describeDisplayAction(item);
  const needsSharedOutput = (item: TimelineItem): boolean => {
    const calls = recordedToolInputs(item);
    const native = calls.map((_, index) => group.items.find(record => record.commandInput?.itemId === item.id && record.commandInput.callIndex === index));
    if (!native.length || native.some(record => !record || record.result !== 'readable' && record.result !== 'empty')) return true;
    const output = (record: TimelineItem) => presentEvidence(record).outputs.map(block => block.text ?? '').join('\n').trim();
    // Elide only an exact duplicate body. Wrapper logs or transformed output
    // remain independently expandable; the complete wrapper is always retained.
    return output(item) !== native.map(record => output(record!)).filter(Boolean).join('\n');
  };
  const toolSignature = (description: ActionDescription) => JSON.stringify(description.entries.map(entry => entry.toolName || actionPresentation(entry).type));
  // The trial splits aggregate groups at result/attention boundaries. Identify
  // the semantic action and exact source membership, not its mutable run key:
  // an unrelated earlier failure must not rename this row, and a true subset
  // must not silently inherit an aggregate's identity. Legacy IDs stay separate.
  const rowsFor = (items: TimelineItem[]) => actionRows({ ...group, items, entries: items.map(item => ({ description: descriptionFor(item), items: [item] })) })
    .map(row => {
      const index = row.description.key.startsWith('["invocation",') ? JSON.parse(row.description.key)[3] ?? 0 : -1;
      const mirrors = group.items.filter(item => {
        const input = item.patchInput ?? item.commandInput;
        return input !== undefined && input.callIndex === index && row.items.some(source => source.id === input.itemId);
      });
      return { ...row, id: presentationId('display-action-row', [row.description.key, row.items.map(item => item.id)]), items: [...row.items, ...mirrors] };
    });
  const append = (kind: ActionRowSection['kind'], items: TimelineItem[], rows = rowsFor(items)) => {
    sections.push({ id: presentationId('action-section', [items[0].id, kind]), kind, rows });
  };
  const flush = () => { if (ordinary.length) { append('folded-actions', ordinary); ordinary = []; } };
  for (const item of group.items) {
    const input = item.patchInput ?? item.commandInput;
    if (input && group.items.some(parent => parent.id === input.itemId)) continue;
    const description = descriptionFor(item);
    const kind = actionSectionKind(item, description);
    if (description.entries.some(entry => entry.toolName === 'Bash' || entry.toolName === 'Write')) {
      // Preserve each shell occurrence and source order, including A / B / A.
      // Nested calls share their parent output; never pair by position.
      flush();
      append('steps', [item]);
      if (description.entries.reduce((sum, entry) => sum + entry.count, 0) > 1 && ['readable', 'partial'].includes(item.result ?? '') && needsSharedOutput(item)) {
        append('result', [item], [{ id: presentationId('action-result', [item.id]),
          description: { label: 'Output', key: `source-result:${description.key}`, count: 1 }, items: [item], count: 1, role: 'output' }]);
      }
      continue;
    }
    if (kind === 'folded-actions') {
      // Different operations must not become one generic collapsed action.
      if (ordinary.length && toolSignature(descriptionFor(ordinary[0])) !== toolSignature(description)) flush();
      ordinary.push(item); continue;
    }
    const rows = rowsFor([item]);
    const multipleInputs = description.entries.reduce((count, entry) => count + entry.count, 0) > 1;
    if (multipleInputs) {
      // The input directory keeps its original IDs when an asynchronous return
      // arrives. Its one shared result has an independent source-record ID.
      flush();
      if (kind === 'result') ordinary.push(item);
      else append(kind, [item], rows);
    }
    flush();
    if (multipleInputs && (item.result === 'readable' || item.result === 'partial') && needsSharedOutput(item)) {
      append(kind, [item], [{
        id: presentationId('action-result', [item.id]),
        description: { label: 'Output', key: `source-result:${description.key}`, count: 1 },
        items: [item], count: 1, role: 'output',
      }]);
    } else if (!multipleInputs) append(kind, [item], rows);
  }
  flush();
  return sections;
}

function isLifecycleMetadata(item: TimelineItem): boolean {
  return item.kind === 'notice' && ['回合开始', '回合结束'].includes(item.title) && item.status !== 'failed' && item.availability === 'none' && !item.detail;
}

function isActivityMetadata(item: TimelineItem): boolean {
  return item.kind === 'subagent' && item.status === 'info' && item.availability === 'none' && !item.detail && item.summary === '已记录活动：interacted。';
}

/** Display-only omission. A quiet, ended shell is not substantive turn content. */
function isEmptyDisplayTurn(turn: TurnGroup): boolean {
  if (turn.items.some(item => item.kind !== 'context' && !isLifecycleMetadata(item) && !isActivityMetadata(item))) return false;
  if (turn.items.some(item => item.status === 'failed' || item.status === 'unknown'
    || ['partial', 'unavailable'].includes(item.availability) || ['partial', 'unreadable'].includes(item.result ?? ''))) return false;
  for (const [index, item] of turn.items.entries()) {
    if (item.status !== 'running') continue;
    // A begin marker is not an active turn once its later explicit end exists.
    if (item.kind !== 'notice' || item.title !== '回合开始' || !turn.items.slice(index + 1).some(next =>
      next.kind === 'notice' && next.title === '回合结束' && next.status === 'completed' && next.availability === 'none')) return false;
  }
  return true;
}

/** Use the same filtered groups for body, map and lens; ordinals are never renumbered. */
export function visibleTurnGroups(session: SessionData): TurnGroup[] {
  const unsupported = new Set(session.coverage.filter(entry => entry.disposition === 'unsupported').map(entry => entry.itemId).filter(Boolean));
  return groupSessionTurns(session).filter(turn => !isEmptyDisplayTurn(turn) || turn.items.some(item => unsupported.has(item.id)));
}

/** Same bounded readable-content policy used for opening either original or aggregate evidence. */
export function hasReadableEvidence(item: TimelineItem): boolean {
  if (!['available', 'partial'].includes(item.availability)) return false;
  return Boolean(item.detail?.blocks.some(block => block.kind === 'image'
    ? /^image\/(png|jpeg|gif|webp)$/.test(block.mime ?? '') && Boolean(block.data) && block.data!.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(block.data!)
    : Boolean(block.text?.trim())));
}

/** Resolve presentation IDs without replacing or rewriting any source observation. */
/**
 * The evidence behind a displayed id. `near`, one of the row's own records,
 * says which turn to look in: describing every turn of a long session for one
 * row took most of a second.
 */
export function resolveOutlineEvidence(session: SessionData, id: string, near?: TimelineItem): OutlineEvidence | undefined {
  // A hint that names no turn of this session finds nothing: look everywhere then.
  const found = findEvidence(session, id, near);
  return (found === undefined && near ? findEvidence(session, id) : found) ?? undefined;
}

/** The evidence; null when the id was found but shows nothing; undefined when it was not found. */
function findEvidence(session: SessionData, id: string, near?: TimelineItem): OutlineEvidence | null | undefined {
  const original = session.items.find(item => item.id === id);
  if (original) return original.sessionId === session.id ? { item: original } : null;
  for (const turn of groupSessionTurns(session)) {
    if (near && !turn.items.some(item => item.id === near.id)) continue;
    for (const node of outlineTurn(turn).nodes) {
      if (node.kind !== 'actions') continue;
      if (id.startsWith('write-file:')) {
        for (const row of actionRowSections(node).flatMap(section => section.rows)) {
          const files = recordedFiles(row.items, row.description);
          const index = files.findIndex((file, index) => fileEvidenceId(row.id, index, file.path) === id);
          if (index < 0) continue;
          const file = files[index], source = row.items[0];
          return { item: { ...source, id, kind: 'file-change', title: shortFileLabels(files.map(f => f.path))[index],
            summary: file.path, status: row.items.some(item => item.status === 'failed') ? 'failed' : source.status, sources: row.items.flatMap(item => item.sources), availability: 'available',
            detail: { title: shortFileLabels(files.map(f => f.path))[index], notice: source.detail?.notice, provenance: '所选文件的历史修改记录；不是当前工作区或最终聚合 diff。', blocks: [
              { kind: 'patch', label: file.path, text: file.operation === 'write' ? file.lines.map(line => ' ' + line).join('\n') : file.lines.join('\n') },
              ...(file.moveTo ? [{ kind: 'text' as const, label: '记录中的目标路径', text: file.moveTo }] : []),
              ...row.items.flatMap(item => [...presentEvidence(item).outputs, ...(item.detail?.blocks.filter(block => block.label === '修改返回错误') ?? [])]),
            ] } } };
        }
      }
      const row = actionRowSections(node).flatMap(section => section.rows).find(candidate => candidate.id === id)
        // Legacy row IDs remain resolvable across a live result/status change.
        ?? actionRows(node).find(candidate => candidate.id === id);
      if (!row) continue;
      if (!row.items.some(hasReadableEvidence)) return null;
      const statuses = new Set(row.items.map(item => item.status));
      const status = statuses.has('failed') ? 'failed' : statuses.has('running') ? 'running' : statuses.has('unknown') ? 'unknown'
        : statuses.size === 1 && statuses.has('completed') ? 'completed' : 'info';
      const complete = row.items.every(item => item.availability === 'available' && hasReadableEvidence(item));
      const item: TimelineItem = {
        id: row.id, sessionId: session.id, ...(turn.turnId ? { turnId: turn.turnId } : {}),
        kind: row.items.every(item => item.kind === 'file-change') ? 'file-change' : 'tool',
        title: row.description.label, summary: `${row.items.length} 条来源记录；分别保留原始状态与证据。`, status,
        availability: complete ? 'available' : 'partial', sources: row.items.flatMap(item => item.sources),
        detail: { title: row.role === 'output' ? 'exec' : [row.description.toolName, row.description.label].filter(Boolean).join(' · '), blocks: [] },
      };
      return { item, items: row.items, entry: row.description, role: row.role };
    }
  }
  return undefined;
}

/** Complements parser coverage: recognition is distinct from the default reading surface. */
export function outlineCoverage(session: SessionData): Array<{ itemId: string; turnKey: string; surface: string; groupKey?: string; rowIds?: string[] }> {
  const visibleKeys = new Set(visibleTurnGroups(session).map(turn => turn.key));
  return groupSessionTurns(session).flatMap(turn => {
    if (!visibleKeys.has(turn.key)) return turn.items.map(item => ({ itemId: item.id, turnKey: turn.key, surface: 'empty-turn-metadata' }));
    const outline = outlineTurn(turn);
    return [
      ...outline.background.map(item => ({ itemId: item.id, turnKey: turn.key, surface: item.kind === 'request' ? 'turn-request' : 'ledger-only' })),
      ...outline.boundaries.map(item => ({ itemId: item.id, turnKey: turn.key, surface: item.kind === 'subagent' ? 'activity-metadata' : 'turn-boundary-metadata' })),
      ...outline.nodes.flatMap(node => {
        if (node.kind === 'actions') {
          const rows = actionRowSections(node).flatMap(section => section.rows);
          return node.items.map(item => ({ itemId: item.id, turnKey: turn.key, surface: 'action-detail', groupKey: node.key,
            rowIds: rows.filter(row => row.items.includes(item)).map(row => row.id) }));
        }
        const action = node.item.kind === 'tool' || node.item.kind === 'file-change';
        return [{ itemId: node.item.id, turnKey: turn.key, surface: node.kind === 'narrative' ? 'public-narrative' : action ? 'action-detail' : 'evidence-or-notice',
          ...(action ? { rowIds: [node.item.id] } : {}) }];
      }),
    ];
  });
}

/** A presentation projection only. Source items and the coverage ledger stay intact. */
export function outlineTurn(turn: TurnGroup): TurnOutline {
  const result: TurnOutline = { nodes: [], background: [], boundaries: [] };
  let actions: Extract<OutlineNode, { kind: 'actions' }> | undefined;
  for (const item of turn.items) {
    if (item.kind === 'notice' && item.title === '思考' && !item.detail && item.status === 'info' && item.availability === 'none') {
      // An empty phase marker carries no public work to read. Retain its source
      // in the background and keep the phase boundary between action runs.
      result.background.push(item); actions = undefined; continue;
    }
    if (item.kind === 'request' || item.kind === 'context') {
      result.background.push(item); actions = undefined; continue;
    }
    if (isLifecycleMetadata(item)) {
      result.boundaries.push(item); actions = undefined; continue;
    }
    if (isActivityMetadata(item)) {
      // This marker says only that interaction occurred; actual calls/returns
      // remain separate. Do not infer a child identity or combine branch states.
      result.boundaries.push(item); actions = undefined; continue;
    }
    // Errors and meaningful boundaries are never buried among successful calls.
    if (item.kind === 'tool' || item.kind === 'file-change') {
      // This is an action list, not an aggregate success state. Every constituent
      // status survives; the renderer exposes pending/running presence and keeps
      // failures outside the group. Inconsistent provider status granularity must
      // not turn a continuous sequence back into one disclosure per log event.
      if (!actions) {
        actions = { kind: 'actions', key: `actions:${item.id}`, items: [], entries: [] };
        result.nodes.push(actions);
      }
      const description = describeAction(item);
      actions.items.push(item);
      const same = actions.entries.find(entry => entry.description.key === description.key);
      if (same) same.items.push(item);
      else actions.entries.push({ description, items: [item] });
    } else {
      actions = undefined;
      result.nodes.push({ kind: item.kind === 'message' ? 'narrative' : 'record', item });
    }
  }
  return result;
}
