import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from './model';

/**
 * What the integration hooks say about a live session: which window it belongs
 * to, whether the agent waits for an approval, and text already on screen but
 * not yet in the transcript. The transcript stays the only source of content.
 * The file format is described in SESSION_STATE.md.
 */
export type SessionPhase = 'idle' | 'working' | 'waiting' | 'ended';
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
  /** Text the agent is showing now, assembled from its display parts in order. */
  draft?: { message: string; text: string; final: boolean; at: number };
}

export const sessionStateDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-sidecar', 'sessions');

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
    if (line.e === 'end') { state.phase = 'ended'; delete state.approval; delete state.draft; continue; }
    state.activeAt = line.t;
    if (line.e === 'prompt' || line.e === 'stop') {
      state.phase = line.e === 'prompt' ? 'working' : 'idle';
      delete state.approval; delete state.draft; parts = new Map();
    } else if (line.e === 'approval') {
      state.phase = 'waiting';
      state.approval = { tool: str(line.tool), summary: str(line.summary), at: line.t };
    } else if (line.e === 'display') {
      // Display never ends a wait: a background hook's clock can land before the
      // approval it followed. Only the transcript says the agent moved on. For the
      // same reason the last part can land after the turn's stop: by then the
      // text is in the transcript, so an idle session keeps no draft.
      if (state.phase === 'idle') continue;
      const message = str(line.message);
      if (state.draft?.message !== message) parts = new Map();
      parts.set(num(line.index), str(line.text));
      state.draft = { message, text: [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join(''),
        final: Boolean(line.final), at: line.t };
    }
  }
  if (state && state.phase !== 'ended' && state.agentPid && !isAlive(state.agentPid)) {
    state.phase = 'ended'; delete state.approval; delete state.draft;
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

const FILE = /^(claude|codex)-[A-Za-z0-9-]{1,80}\.jsonl$/;

/** Every session the integration has recorded, read from disk once. */
export async function readSessionStates(directory = sessionStateDirectory(), isAlive: (pid: number) => boolean = alive): Promise<SessionState[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const states = await Promise.all(names.filter(name => FILE.test(name)).map(name =>
    readFile(join(directory, name), 'utf8').then(text => foldSessionState(text, isAlive), () => undefined)));
  return states.filter((state): state is SessionState => Boolean(state));
}

/** The session this window follows: its own, not ended, most recently active. */
export function currentSession(states: SessionState[], hostPid: number): SessionState | undefined {
  return states.filter(state => state.hostPid === hostPid && state.phase !== 'ended')
    .sort((a, b) => b.activeAt - a.activeAt)[0];
}
