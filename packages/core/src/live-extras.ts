import type { SessionData } from './model';
import { visibleTurnGroups } from './outline';
import { awaitingApproval, pendingDraft, type SessionState } from './session-state';
import { publicBody } from './turn-view';

/**
 * What the integration hooks add to the newest turn: the approval the agent is
 * waiting for, and text already on screen but not yet in the transcript.
 */
export interface LiveExtras { approval?: { tool: string; summary: string }; draft?: string }

/** Latest source time in the session, for "has the agent moved on since". */
export function lastRecordAt(session: SessionData): number | undefined {
  let latest: number | undefined;
  for (const item of session.items) {
    const at = item.timestamp ? Date.parse(item.timestamp) : NaN;
    if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

/** The extras for `session` from its state file, when the integration reports one. */
export function liveExtras(session: SessionData | undefined, state: SessionState | undefined): LiveExtras {
  if (!session || !state) return {};
  const last = lastRecordAt(session);
  const approval = awaitingApproval(state, last) ? state.approval : undefined;
  // Turn grouping costs a pass over the session: only when there is a draft to check.
  const latest = state.draft ? visibleTurnGroups(session).at(-1) : undefined;
  const draft = latest && pendingDraft(state, latest.items.filter(item => item.kind === 'message' || item.kind === 'answer').map(publicBody), last);
  return { ...(approval ? { approval: { tool: approval.tool, summary: approval.summary } } : {}), ...(draft ? { draft } : {}) };
}
