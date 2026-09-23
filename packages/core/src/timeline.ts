import type { SessionData, TimelineItem } from './model';

/** A reading hierarchy, not a new session or an inferred execution state. */
export interface TurnGroup {
  key: string;
  turnId?: string;
  ordinal?: number;
  timestamp?: string;
  request: string;
  items: TimelineItem[];
}

export function groupSessionTurns(session: SessionData): TurnGroup[] {
  const groups: TurnGroup[] = [];
  const turns = new Map<string, TurnGroup>();
  let unassigned: TurnGroup | undefined;
  for (const item of session.items) {
    // Do not silently relabel content from a different session as part of this one.
    if (item.sessionId !== session.id) throw new Error('过程记录不属于当前 session。');
    let group: TurnGroup;
    if (item.turnId) {
      unassigned = undefined;
      const existing = turns.get(item.turnId);
      group = existing ?? { key: `turn:${item.turnId}`, turnId: item.turnId, ordinal: turns.size + 1, request: '', items: [] };
      if (!existing) { turns.set(item.turnId, group); groups.push(group); }
    } else {
      // Keep separate unknown spans in source order; no guessed request boundaries.
      group = unassigned ?? { key: `unassigned:${item.id}`, request: '', items: [] };
      if (!unassigned) { groups.push(group); unassigned = group; }
    }
    group.items.push(item);
    if (!group.timestamp && item.timestamp) group.timestamp = item.timestamp;
    if (!group.request && item.kind === 'request') group.request = item.summary || item.title;
  }
  return groups;
}
