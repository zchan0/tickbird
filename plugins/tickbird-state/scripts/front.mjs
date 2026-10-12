// Which process shows a session to the reader: its front.
//
// Usually that is the agent that ran the hook. Codex's shared background
// server (0.157+) is the exception: it runs the hooks of every Codex on the
// machine, in the environment of whoever started it, while the session shows
// in a `codex` front in some terminal. That front is found by its directory;
// among several there, by the terminal that just took input: Codex starts a
// session when its first message is sent.
//
// This file is the same in tickbird-state and tickbird-split (a test checks):
// each plugin is installed on its own and cannot import the other.
import { spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';

export function run(command, args, timeout = 2000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  return { status: result.error ? 127 : result.status ?? 1, stdout: result.stdout ?? '' };
}

const words = text => text.trim().split(/\s+/);

/** The terminal and command line of a process. A process without a terminal has tty "??" (macOS) or "?" (Linux). */
export function processInfo(pid, exec = run) {
  const match = /^\s*(\S+)\s+(.*)$/.exec(exec('ps', ['-o', 'tty=', '-o', 'args=', '-p', String(pid)]).stdout.trim());
  if (!match) return undefined;
  return { tty: /^\?+$/.test(match[1]) ? undefined : match[1].replace(/^\/dev\//, ''), args: match[2] };
}

/** Codex's managed background server: `codex app-server … --managed-daemon`. */
export const isCodexServer = args => basename(words(args)[0]) === 'codex' && words(args).includes('app-server') && words(args).includes('--managed-daemon');

/** A Codex front: `codex` on a terminal, not one of its non-interactive commands. */
const FRONT_SKIP = new Set(['app-server', 'exec', 'e', 'mcp-server', 'login', 'logout', 'plugin', 'features', 'agents', 'remote-control']);
const isCodexFront = args => basename(words(args)[0]) === 'codex' && !FRONT_SKIP.has(words(args)[1]);

/**
 * A process's environment. Linux has it exactly in /proc; macOS `ps -E`
 * prints it after the command line, space separated, so a value runs until
 * the next NAME=.
 */
export function environmentOf(pid, args, exec = run, platform = process.platform) {
  if (platform === 'linux') {
    try { return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)])); }
    catch { return undefined; }
  }
  const text = exec('ps', ['-E', '-o', 'command=', '-p', String(pid)]).stdout.replace(/\n$/, '');
  if (!text.startsWith(args)) return undefined;
  const env = {};
  const pattern = / ([A-Za-z_][A-Za-z0-9_]*)=/g;
  const rest = text.slice(args.length), marks = [...rest.matchAll(pattern)];
  marks.forEach((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].index : rest.length;
    env[mark[1]] = rest.slice(mark.index + mark[0].length, end);
  });
  return env;
}

/** Working directories of processes: Linux from /proc, macOS from one lsof call. */
function directories(pids, exec, platform) {
  const dirs = new Map();
  if (platform === 'linux') {
    for (const pid of pids) { try { dirs.set(pid, readlinkSync(`/proc/${pid}/cwd`)); } catch { /* gone */ } }
    return dirs;
  }
  let current;
  for (const line of exec('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']).stdout.split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1));
    else if (line.startsWith('n') && current) dirs.set(current, line.slice(1));
  }
  return dirs;
}

const real = path => { try { return realpathSync(path); } catch { return path; } };

/** When a terminal last took input: its device's access time, as `w` shows idle time. */
export const lastInput = tty => { try { return statSync(`/dev/${tty}`).atimeMs; } catch { return 0; } };

/** The input that started the session is this recent, and this far ahead of any other front's. */
export const INPUT_RECENT_MS = 30_000, INPUT_MARGIN_MS = 2_000;

/**
 * The session's front: { pid, info, env, server } (env only when it is not
 * the hook's own), or { ambiguous: [pids] }, or { missing: true } when the
 * server runs it and no front is found.
 */
export function frontOf(agentPid, cwd, { exec = run, input = lastInput, now = Date.now(), platform = process.platform } = {}) {
  const info = processInfo(agentPid, exec);
  if (!info || info.tty || !isCodexServer(info.args)) return { pid: agentPid, info };
  const listing = exec('ps', ['-A', '-o', 'pid=', '-o', 'tty=', '-o', 'args=']).stdout.split('\n');
  const fronts = listing.map(line => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)).filter(Boolean)
    .filter(([, , tty, args]) => !/^\?+$/.test(tty) && isCodexFront(args))
    .map(([, pid, tty, args]) => ({ pid: Number(pid), info: { tty: tty.replace(/^\/dev\//, ''), args } }));
  if (!fronts.length) return { missing: true };
  const dirs = directories(fronts.map(front => front.pid), exec, platform);
  const want = real(cwd);
  const here = fronts.filter(front => dirs.get(front.pid) === want);
  if (!here.length) return { missing: true };
  let front = here[0];
  if (here.length > 1) {
    // Several in one directory: the one whose terminal just took the message, if that is clear.
    const byInput = here.map(item => ({ ...item, at: input(item.info.tty) })).sort((a, b) => b.at - a.at);
    if (now - byInput[0].at > INPUT_RECENT_MS || byInput[0].at - byInput[1].at < INPUT_MARGIN_MS) return { ambiguous: here.map(item => item.pid) };
    front = byInput[0];
  }
  const env = environmentOf(front.pid, front.info.args, exec, platform);
  return { pid: front.pid, info: front.info, ...(env ? { env } : {}), server: agentPid };
}
