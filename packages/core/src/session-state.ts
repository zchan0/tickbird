import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from './model';

/**
 * What the integration hooks say about a live session: which window it belongs
 * to, whether the agent waits for an approval, and text already on screen but
 * not yet in the transcript. The transcript stays the only source of content.
 * The file format is described in docs/SESSION_STATE.md.
 */
export type SessionPhase = 'idle' | 'working' | 'waiting' | 'ended';
export interface SessionCall { tool: string; input: Record<string, string>; at: number }

export interface SessionState {
  provider: Provider;
  session: string;
  transcript?: string;
  cwd: string;
  /** The claude process, or the Codex app-server. */
  agentPid: number;
  /** The agent's parent: in VS Code, the extension host of the window it runs in. */
  hostPid: number;
  kitty?: { window: string; socket: string };
  startedAt: number;
  activeAt: number;
  phase: SessionPhase;
  approval?: { tool: string; summary: string; at: number };
  /** Calls the agent showed as about to run, newest last; the transcript may not have them yet. */
  calls?: SessionCall[];
  /** Text the agent is showing now, assembled from its display parts in order. */
  draft?: { message: string; text: string; final: boolean; at: number };
}

export const sessionStateDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'tickbird', 'sessions');

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

interface Line { v: number; t: number; e: string; order: number; [key: string]: unknown }

const str = (value: unknown): string => typeof value === 'string' ? value : '';
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * Folds a state file into the session's current state. Background hooks may
 * append out of order, so lines are taken by their own time; a line still
 * being written, or one from a newer format, is skipped.
 *
 * The hooks write start, approval and display. Files from 0.2 and 0.3 also
 * hold prompt, stop and end; they still fold, but nothing relies on them:
 * when a turn starts or ends comes from the transcript, and a session ends
 * when its agent's process does.
 */
export function foldSessionState(text: string, isAlive: (pid: number) => boolean = alive): SessionState | undefined {
  const lines = text.split('\n').flatMap((raw, order): Line[] => {
    try {
      const value = JSON.parse(raw) as Line;
      return value && value.v === 1 && typeof value.e === 'string' && typeof value.t === 'number' ? [{ ...value, order }] : [];
    } catch { return []; }
  }).sort((a, b) => a.t - b.t || a.order - b.order);
  let state: SessionState | undefined;
  let parts = new Map<number, string>();
  for (const line of lines) {
    if (line.e === 'start') {
      const provider: Provider = line.provider === 'codex' ? 'codex' : 'claude';
      const kitty = line.kitty as { window?: unknown; socket?: unknown } | undefined;
      // A compaction restarts the session mid-turn; a resume starts it idle.
      const phase: SessionPhase = state && line.source === 'compact' && state.phase !== 'ended' ? state.phase : 'idle';
      state = {
        provider, session: str(line.session), ...(str(line.transcript) ? { transcript: str(line.transcript) } : {}),
        cwd: str(line.cwd), agentPid: num(line.agentPid), hostPid: num(line.hostPid),
        ...(kitty && typeof kitty.window === 'string' && typeof kitty.socket === 'string' ? { kitty: { window: kitty.window, socket: kitty.socket } } : {}),
        startedAt: state?.startedAt ?? line.t, activeAt: line.t, phase,
        ...(phase !== 'idle' && state?.approval ? { approval: state.approval } : {}),
        ...(phase !== 'idle' && state?.draft ? { draft: state.draft } : {}),
      };
      continue;
    }
    if (!state) continue;
    if (line.e === 'end') { state.phase = 'ended'; delete state.approval; delete state.draft; delete state.calls; continue; }
    state.activeAt = line.t;
    if (line.e === 'prompt' || line.e === 'stop') {
      state.phase = line.e === 'prompt' ? 'working' : 'idle';
      delete state.approval; delete state.draft; delete state.calls; parts = new Map();
    } else if (line.e === 'call') {
      const input = line.input && typeof line.input === 'object' ? Object.fromEntries(Object.entries(line.input as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {};
      state.calls = [...(state.calls ?? []), { tool: str(line.tool), input, at: line.t }].slice(-CALLS_KEPT);
    } else if (line.e === 'approval') {
      state.phase = 'waiting';
      state.approval = { tool: str(line.tool), summary: str(line.summary), at: line.t };
    } else if (line.e === 'display') {
      // Display never ends a wait: a background hook's clock can land before the
      // approval it followed. Only the transcript says the agent moved on, and
      // only the transcript retires a draft (see pendingDraft).
      const message = str(line.message);
      if (state.draft?.message !== message) parts = new Map();
      parts.set(num(line.index), str(line.text));
      state.draft = { message, text: [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join(''),
        final: Boolean(line.final), at: line.t };
    }
  }
  if (state && state.phase !== 'ended' && state.agentPid && !isAlive(state.agentPid)) {
    state.phase = 'ended'; delete state.approval; delete state.draft; delete state.calls;
  }
  return state;
}

/**
 * Neither agent announces that an approval was answered. A transcript record
 * written after the request means it was: the call's result, or a refusal.
 * Use this, not `phase` alone, to show "waiting for you".
 */
export function awaitingApproval(state: SessionState | undefined, transcriptLastAt?: number): boolean {
  if (!state?.approval || state.phase !== 'waiting') return false;
  return transcriptLastAt === undefined || transcriptLastAt <= state.approval.at;
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A transcript record this much newer than a draft's last part means the agent moved on. */
export const DRAFT_SUPERSEDED_MS = 1000;

/** How many announced calls the state keeps, and how long one waits for its record before it is let go. */
const CALLS_KEPT = 8;
export const CALL_PENDING_MS = 30_000;

/** The field a call is told apart by: the command it runs, the file, pattern or page it works on. */
const callKey = (tool: string, input: Record<string, unknown>): string => {
  const value = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'skill', 'description'].map(key => input[key]).find(field => typeof field === 'string' && field.trim());
  return `${tool}\u0000${typeof value === 'string' ? squash(value).slice(0, 120) : ''}`;
};

/**
 * Calls the agent shows as running that its transcript does not have yet:
 * Claude Code can write a call seconds after showing it. A call goes once the
 * transcript has one of the same tool on the same command or file (as many
 * as were announced), or when it has waited long enough that the record must
 * have come another way.
 */
export function pendingCalls(state: SessionState | undefined, recorded: Array<{ name: string; input: unknown }>, now: number): SessionCall[] {
  if (!state?.calls?.length || state.phase === 'ended') return [];
  const seen = new Map<string, number>();
  for (const call of recorded) {
    const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {};
    const key = callKey(call.name, input);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  // The newest announcements are the ones still out: match from the oldest, so the recorded ones use them up first.
  return state.calls.filter(call => {
    const key = callKey(call.tool, call.input), left = seen.get(key) ?? 0;
    if (left) { seen.set(key, left - 1); return false; }
    return now - call.at < CALL_PENDING_MS;
  });
}

/**
 * The text still worth showing early: none once the transcript holds the same
 * words, and none once the transcript has moved past it (the turn was
 * interrupted, or the next one began). Display ids do not match transcript
 * ids, so the words decide.
 */
export function pendingDraft(state: SessionState | undefined, transcriptTexts: string[], transcriptLastAt?: number): string | undefined {
  const draft = state?.draft?.text;
  if (!draft || state.phase === 'ended') return undefined;
  if (transcriptLastAt !== undefined && transcriptLastAt > state.draft!.at + DRAFT_SUPERSEDED_MS) return undefined;
  const head = squash(draft).slice(0, 40);
  if (!head) return undefined;
  return transcriptTexts.some(text => squash(text).startsWith(head)) ? undefined : draft;
}

const FILE = /^(claude|codex)-[A-Za-z0-9-]{1,80}\.jsonl$/;

/** Folded files keyed by name, reused while the file's size and time stay the same. */
export type SessionStateCache = Map<string, { mtimeMs: number; size: number; state?: SessionState }>;

/**
 * Every session the integration has recorded. With a cache, an unchanged file
 * is not read again; whether its agent is still alive is checked every time.
 */
export async function readSessionStates(directory = sessionStateDirectory(), isAlive: (pid: number) => boolean = alive, cache?: SessionStateCache): Promise<SessionState[]> {
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => FILE.test(name));
  if (cache) for (const name of cache.keys()) if (!names.includes(name)) cache.delete(name);
  const states = await Promise.all(names.map(async name => {
    const file = join(directory, name);
    try {
      const info = await stat(file);
      let cached = cache?.get(name);
      if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
        cached = { mtimeMs: info.mtimeMs, size: info.size, state: foldSessionState(await readFile(file, 'utf8'), () => true) };
        cache?.set(name, cached);
      }
      const folded = cached.state;
      if (!folded) return undefined;
      // Copies: a cached fold is never changed in place.
      const state: SessionState = { ...folded };
      // The transcript's last write is the session's latest activity: the hooks no longer report turns.
      if (state.transcript) {
        const written = await stat(state.transcript).then(info => info.mtimeMs, () => 0);
        if (written > state.activeAt) state.activeAt = written;
      }
      if (state.phase !== 'ended' && state.agentPid && !isAlive(state.agentPid)) {
        state.phase = 'ended'; delete state.approval; delete state.draft;
      }
      return state;
    } catch { return undefined; }
  }));
  return states.filter((state): state is SessionState => Boolean(state));
}

/** The session this window follows: its own, not ended, most recently active. */
export function currentSession(states: SessionState[], hostPid: number): SessionState | undefined {
  return states.filter(state => state.hostPid === hostPid && state.phase !== 'ended')
    .sort((a, b) => b.activeAt - a.activeAt)[0];
}
