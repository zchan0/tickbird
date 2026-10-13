#!/usr/bin/env node
// Tickbird split hook, shared by Claude Code and Codex.
//   split.mjs <claude|codex> <agent pid>        (the SessionStart hook's JSON arrives on stdin)
//   split.mjs <claude|codex> --open             (/tickbird-split:open: the agent is found above it; says what happened)
//
// Opens the Tickbird pane beside the agent, once per agent process. The pane
// follows that process by itself: after /clear it shows the new session, and
// it exits when the agent does. So nothing here runs at the session's end.
//
// "The agent" is the session's front (see front.mjs): for Codex's shared
// background server, the `codex` in a terminal, with that terminal's
// environment instead of the server's.
//
// As a hook it prints nothing, because a SessionStart hook's stdout becomes the
// model's context; what it decided goes to split.log. It never fails the agent.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { candidates } from './adapters/index.mjs';
import { frontOf } from './front.mjs';
import { run, which } from './run.mjs';

const LOG_LIMIT = 256 * 1024;
/** What the pane needs from the agent's environment: a kitty window starts with kitty's own. */
const PASSED = ['PATH', 'XDG_STATE_HOME', 'VISUAL', 'EDITOR'];

/** The program this plugin carries, built at each version (npm run bundle:plugin), run with this node. */
export const BUNDLED = fileURLToPath(new URL('../program/tickbird.cjs', import.meta.url));
/** A command `npm run install:terminal` wrote: its launcher says so. Another program may be called tickbird. */
const developmentInstall = file => { try { return readFileSync(file, 'utf8').includes('npm run install:terminal'); } catch { return false; } };

/**
 * The pane's program: $TICKBIRD_CLI (a script run with this node, or a
 * program); else a development install's tickbird (on PATH, or where `npm run
 * install:terminal` puts it: a hook's PATH may be another program's, such as
 * Codex's background server), the checkout's latest build; else the program
 * this plugin carries.
 */
export function paneProgram(env, tools = { which }) {
  const named = env.TICKBIRD_CLI;
  if (named) {
    const file = isAbsolute(named) ? named : resolve(named);
    if (!existsSync(file)) return undefined;
    return /\.[cm]?js$/.test(file) ? [process.execPath, file] : [file];
  }
  const found = tools.which('tickbird', env) ?? tools.which('tickbird', { PATH: join(env.HOME || homedir(), '.local', 'bin') });
  if (found && (tools.ours ?? developmentInstall)(found)) return [found];
  const bundled = tools.bundled ?? BUNDLED;
  return existsSync(bundled) ? [process.execPath, bundled] : undefined;
}

/** Print mode and `codex exec` answer once and quit: no pane for them. */
export function interactive(provider, args) {
  const words = args.trim().split(/\s+/);
  if (provider === 'codex') return words[1] !== 'exec' && words[1] !== 'e';
  return !words.some(word => word === '-p' || word === '--print');
}

/** The pane's command line. */
export const paneArgv = (program, agentPid, focus) => [...program, 'watch', '--agent', String(agentPid), '--focus', JSON.stringify(focus)];

/**
 * Decides and acts on one SessionStart. Returns what happened, for the log.
 * `tools` is injected so tests can stand in for ps, kitten and tmux.
 */
export const handle = (provider, hookPid, input, hookEnv = process.env, tools = { run, which }) => decide(provider, hookPid, input, hookEnv, tools)?.text;

/** The command to run the pane by hand, where the terminal cannot open one: shell-quoted, the agent's to follow. */
export const manualCommand = (program, agentPid) => [...program, 'watch', '--agent', String(agentPid)]
  .map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');

/**
 * handle()'s decision, and where the pane could run but this terminal cannot
 * open one (no adapter, or its adapter cannot), the command to run it by hand.
 */
export function decide(provider, hookPid, input, hookEnv = process.env, tools = { run, which }) {
  if (input.hook_event_name !== 'SessionStart') return undefined;
  // A compaction continues the session: the pane, if the reader kept it, is still there.
  if (input.source === 'compact') return { text: '压缩后继续：不开栏' };
  if (!(hookPid > 1)) return { text: '没有 Agent 进程号：不开栏' };
  // tools.platform: tests pin the process table they fake (ps and lsof, or Linux's /proc).
  const front = frontOf(hookPid, input.cwd || process.cwd(), { exec: tools.run, ...(tools.input ? { input: tools.input } : {}), ...(tools.platform ? { platform: tools.platform } : {}) });
  if (front.ambiguous) return { text: `同一目录有 ${front.ambiguous.length} 个 Codex（${front.ambiguous.join(', ')}），都没有明显是刚发出消息的那个：不开栏` };
  if (front.missing) return { text: 'Codex 后台运行这个会话，但找不到它在终端里的前台：不开栏' };
  if (front.server && !front.env) return { text: `读不到 Codex 前台 ${front.pid} 的环境变量：不开栏` };
  // The server's environment belongs to whoever started it: only the front's says where the session shows.
  const env = front.env ?? hookEnv, agentPid = front.pid, info = front.info;
  if (!info?.tty) return { text: 'Agent 不在终端里（例如 VS Code 里的 Agent）：不开栏' };
  if (!interactive(provider, info.args)) return { text: '非交互运行：不开栏' };
  const program = paneProgram(env, tools);
  if (!program) return { text: '找不到 tickbird：不开栏' };
  for (const adapter of candidates(env)) {
    const place = adapter.locate(env, tools);
    if (place.skip) return { text: `${adapter.name}：${place.skip}`, manual: manualCommand(program, agentPid) };
    if (!place.owns(agentPid, info)) continue;
    const open = place.find(agentPid);
    if (open.length) return { text: `${place.name}：Agent ${agentPid} 已有栏 ${open.join(',')}，它会自己改绑` };
    const extra = Object.fromEntries(PASSED.filter(key => env[key]).map(key => [key, env[key]]));
    // The state files are where tickbird-state writes them: it runs beside this hook, in the hook's environment.
    if (hookEnv.XDG_STATE_HOME) extra.XDG_STATE_HOME = hookEnv.XDG_STATE_HOME;
    else if (extra.XDG_STATE_HOME) extra.XDG_STATE_HOME = '';
    const result = place.open({ argv: paneArgv(program, agentPid, place.focus), cwd: input.cwd || process.cwd(), env: extra, tag: agentPid });
    const via = front.server ? `，Codex 前台，后台 ${front.server}` : '';
    return result.error ? { text: `${place.name}：开栏失败：${result.error}`, manual: manualCommand(program, agentPid) } : { text: `${place.name}：在 ${place.pane} 旁开栏 ${result.pane}（Agent ${agentPid}${via}）` };
  }
  return { text: '这个终端不能自动开栏：可以在新的标签页或窗口里手动运行', manual: manualCommand(program, agentPid) };
}

const stateRoot = env => join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'tickbird');
export const logFile = (env = process.env) => join(stateRoot(env), 'split.log');

function log(line, env = process.env) {
  try {
    const file = logFile(env);
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    if (existsSync(file) && statSync(file).size > LOG_LIMIT) renameSync(file, file + '.1');
    appendFileSync(file, line + '\n', { mode: 0o600 });
  } catch { /* Logging must never fail the hook. */ }
}

/** Puts text on the clipboard where a command for it is here; says whether it did. */
function copy(text) {
  for (const [command, args] of [['pbcopy', []], ['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]) {
    const result = spawnSync(command, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

/** The agent above this process: a command the agent ran is its child, a few shells down. */
export function agentAbove(provider, start = process.ppid, exec = run) {
  const name = new RegExp(`(^|/)${provider}$`);
  for (let pid = start, step = 0; pid > 1 && step < 8; step++) {
    const [parent, ...command] = exec('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]).stdout.trim().split(/\s+/);
    if (command.length && name.test(command.join(' '))) return pid;
    pid = Number(parent);
  }
  return undefined;
}

async function main() {
  const [provider, pid] = process.argv.slice(2);
  // Asked by the agent's command: no hook input, and the person reads what happened.
  if (pid === '--open') {
    const agent = agentAbove(provider);
    let outcome;
    let decision;
    try { decision = agent ? decide(provider, agent, { hook_event_name: 'SessionStart', cwd: process.cwd(), source: 'open' }) : { text: `找不到上层的 ${provider} 进程` }; } catch (error) { decision = { text: `出错：${error?.message ?? error}` }; }
    log(`${new Date().toISOString()} ${provider} open · ${decision?.text}`);
    process.stdout.write(`${decision?.text ?? '没有开栏'}\n`);
    if (decision?.manual) process.stdout.write(`手动运行：${decision.manual}\n${copy(decision.manual) ? '（已复制到剪贴板）\n' : ''}`);
    return;
  }
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text || '{}');
  let outcome;
  try { outcome = handle(provider, Number(pid) || 0, input); } catch (error) { outcome = `出错：${error?.message ?? error}`; }
  if (outcome) log(`${new Date().toISOString()} ${provider} ${String(input.session_id ?? '').slice(0, 80)} ${input.source ?? ''} · ${outcome}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => undefined).finally(() => process.exit(0));
}
