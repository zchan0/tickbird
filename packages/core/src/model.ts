/** Read-only normalized observations. Raw records never cross into a webview. */
export type Provider = 'codex' | 'claude';
export interface SourceRef { file: string; line: number; recordId?: string; block?: number }
export type ItemKind = 'request' | 'message' | 'tool' | 'answer' | 'context' | 'notice' | 'question' | 'subagent' | 'file-change';
export type ItemStatus = 'info' | 'running' | 'completed' | 'failed' | 'unknown';
export interface EvidenceBlock {
  kind: 'text' | 'code' | 'patch' | 'json' | 'image';
  label: string;
  text?: string;
  mime?: string;
  data?: string;
}
export interface EvidenceDetail { title: string; blocks: EvidenceBlock[]; notice?: string; provenance?: string }
export interface TimelineItem {
  id: string;
  sessionId: string;
  turnId?: string;
  timestamp?: string;
  kind: ItemKind;
  noticeType?: 'context-compacted' | 'task-notification';
  /** For a task notification: the tool that ran the task (Bash, Agent, Artifact…). */
  taskTool?: string;
  /** The agent's own id for a call (Claude Code's tool_use id): how a subagent's own record names the call that started it. */
  callId?: string;
  /** A call that started a task in the background: whether it has reported back, or was stopped, as the record says. */
  backgroundTask?: { id: string; state: 'running' | 'returned' | 'stopped' };
  /** A native file event matched one unique static patch input; sources remain separate. */
  patchInput?: { itemId: string; callIndex: number };
  /** Native shell execution matched to one exact, pending public invocation. */
  commandInput?: { itemId: string; callIndex: number };
  /** What the harness says a file write did: made the file, or replaced one that was there. */
  fileOperation?: 'create' | 'update';
  title: string;
  summary: string;
  status: ItemStatus;
  /**
   * Adapter-observed returned content, independent of status or input details.
   * Empty means an explicit supported empty return, not a missing return body.
   * Partial means readable + unreadable content or explicit source truncation.
   * This belongs to the source call; shared wrapper output is not per-atom proof.
   */
  result?: 'not-observed' | 'empty' | 'readable' | 'unreadable' | 'partial';
  /** Exit code exactly as the source recorded it; never inferred from text. */
  exitCode?: number;
  /** Claude `toolDenialKind`: the call was refused, not run and failed. */
  denial?: string;
  /** The source marked the call as interrupted. */
  interrupted?: boolean;
  /** A turn-end record's own measured duration (Claude `turn_duration`). */
  durationMs?: number;
  sources: SourceRef[];
  availability: 'none' | 'available' | 'partial' | 'unavailable';
  detail?: EvidenceDetail;
}
export interface CoverageRecord {
  source: SourceRef;
  kind: string;
  disposition: 'displayed' | 'merged' | 'original-chat' | 'excluded' | 'unsupported';
  reason: string;
  itemId?: string;
}
export interface SessionData {
  id: string;
  provider: Provider;
  projectPath: string;
  title: string;
  /** Provenance of the visible session name; absent means the legacy request fallback. */
  titleSource?: 'request' | 'claude-ai-title' | 'codex-index';
  items: TimelineItem[];
  coverage: CoverageRecord[];
  warnings: string[];
}
export interface ParseInput { text: string; file: string; projectPath: string }
export interface SessionCandidate {
  id: string;
  provider: Provider;
  file: string;
  projectPath: string;
  updatedAt: number;
  /** File mtime is not proof of an active agent. */
  activity: 'unverified';
}
