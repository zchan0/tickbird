#!/usr/bin/env node
// Agent Sidecar integration hook, shared by Claude Code and Codex.
//   hook.mjs <claude|codex> <agent pid>        (the hook's JSON arrives on stdin)
//
// Appends one line per event to the session's state file; see SESSION_STATE.md.
// It prints nothing, because a SessionStart hook's stdout becomes the model's
// context, and it never fails: a broken Sidecar must not get in the agent's way.
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = 1;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const TEXT_LIMIT = 3000;

export function stateDirectory(env = process.env) {
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-sidecar', 'sessions');
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const parentOf = pid => {
  try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim()) || undefined; }
  catch { return undefined; }
};
const oneLine = (value, limit) => String(value).replace(/\s+/g, ' ').trim().slice(0, limit);

/** What the call touches, in one line: never the whole input. */
function summary(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'cmd', 'file_path', 'path', 'url', 'pattern', 'query', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value, 200);
    if (Array.isArray(value) && value.length) return oneLine(value.join(' '), 200);
  }
  return '';
}

/** Turns one hook input into the record to append, or nothing. */
export function record(provider, agentPid, input, now = Date.now(), env = process.env) {
  const base = { v: VERSION, t: now };
  switch (input.hook_event_name) {
    case 'SessionStart': {
      const kitty = env.KITTY_WINDOW_ID && env.KITTY_LISTEN_ON ? { window: env.KITTY_WINDOW_ID, socket: env.KITTY_LISTEN_ON } : undefined;
      return { ...base, e: 'start', provider, session: input.session_id, transcript: input.transcript_path ?? null,
        cwd: input.cwd ?? '', agentPid, hostPid: parentOf(agentPid) ?? 0, source: input.source ?? '', ...(kitty ? { kitty } : {}) };
    }
    case 'UserPromptSubmit': return { ...base, e: 'prompt' };
    case 'PermissionRequest': return { ...base, e: 'approval', tool: oneLine(input.tool_name ?? '', 80), summary: summary(input.tool_input) };
    case 'MessageDisplay': return { ...base, e: 'display', message: String(input.message_id ?? ''), index: Number(input.index) || 0,
      final: Boolean(input.final), text: String(input.delta ?? '').slice(0, TEXT_LIMIT) };
    case 'Stop': return { ...base, e: 'stop' };
    case 'StopFailure': return { ...base, e: 'stop', reason: 'failure' };
    case 'Interrupt': return { ...base, e: 'stop', reason: 'interrupt' };
    case 'SessionEnd': return { ...base, e: 'end', reason: oneLine(input.reason ?? '', 40) };
    default: return undefined;
  }
}

/** Old files of sessions whose agent is gone. A live session is never removed. */
function prune(directory, now) {
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(directory, name);
    try {
      if (now - statSync(file).mtimeMs < KEEP_MS) continue;
      const fd = openSync(file, 'r'), buffer = Buffer.alloc(4096);
      const read = readSync(fd, buffer, 0, buffer.length, 0); closeSync(fd);
      const start = JSON.parse(buffer.subarray(0, read).toString('utf8').split('\n')[0]);
      if (!start.agentPid || !alive(start.agentPid)) unlinkSync(file);
    } catch { /* A file another process is writing or removing is left alone. */ }
  }
}

export function handle(provider, agentPid, input, env = process.env, now = Date.now()) {
  if (provider !== 'claude' && provider !== 'codex') return;
  const session = input.session_id;
  if (typeof session !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(session)) return;
  const line = record(provider, agentPid, input, now, env);
  if (!line) return;
  const directory = stateDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // One short line per append: concurrent hooks never interleave inside a line.
  appendFileSync(join(directory, `${provider}-${session}.jsonl`), JSON.stringify(line) + '\n', { mode: 0o600 });
  if (line.e === 'start') prune(directory, now);
}

async function main() {
  const [provider, pid] = process.argv.slice(2);
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  handle(provider, Number(pid) || 0, JSON.parse(text || '{}'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => undefined).finally(() => process.exit(0));
}
