#!/usr/bin/env node
// Agent Sidecar split hook, shared by Claude Code and Codex.
//   split.mjs <claude|codex> <agent pid>        (the SessionStart hook's JSON arrives on stdin)
//
// Opens the Sidecar pane beside the agent, once per agent process. The pane
// follows that process by itself: after /clear it shows the new session, and
// it exits when the agent does. So nothing here runs at the session's end.
//
// "The agent" is the session's front (see front.mjs): for Codex's shared
// background server, the `codex` in a terminal, with that terminal's
// environment instead of the server's.
//
// It prints nothing, because a SessionStart hook's stdout becomes the model's
// context; what it decided goes to split.log. It never fails the agent.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidates } from './adapters/index.mjs';
import { frontOf } from './front.mjs';
import { run, which } from './run.mjs';

const LOG_LIMIT = 256 * 1024;
/** What the pane needs from the agent's environment: a kitty window starts with kitty's own. */
const PASSED = ['PATH', 'XDG_STATE_HOME', 'VISUAL', 'EDITOR'];

/**
 * The pane's program: $AGENT_SIDECAR_CLI (a script run with this node, or a
 * program), else agent-sidecar on PATH, else where `npm run install:terminal`
 * puts it: a hook's PATH may be another program's (Codex's background server).
 */
export function paneProgram(env, tools = { which }) {
  const named = env.AGENT_SIDECAR_CLI;
  if (named) {
    const file = isAbsolute(named) ? named : resolve(named);
    if (!existsSync(file)) return undefined;
    return /\.[cm]?js$/.test(file) ? [process.execPath, file] : [file];
  }
  const found = tools.which('agent-sidecar', env) ?? tools.which('agent-sidecar', { PATH: join(env.HOME || homedir(), '.local', 'bin') });
  return found ? [found] : undefined;
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
export function handle(provider, hookPid, input, hookEnv = process.env, tools = { run, which }) {
  if (input.hook_event_name !== 'SessionStart') return undefined;
  // A compaction continues the session: the pane, if the reader kept it, is still there.
  if (input.source === 'compact') return '压缩后继续：不开栏';
  if (!(hookPid > 1)) return '没有 Agent 进程号：不开栏';
  const front = frontOf(hookPid, input.cwd || process.cwd(), { exec: tools.run, ...(tools.input ? { input: tools.input } : {}) });
  if (front.ambiguous) return `同一目录有 ${front.ambiguous.length} 个 Codex（${front.ambiguous.join(', ')}），都没有明显是刚发出消息的那个：不开栏`;
  if (front.missing) return 'Codex 后台运行这个会话，但找不到它在终端里的前台：不开栏';
  if (front.server && !front.env) return `读不到 Codex 前台 ${front.pid} 的环境变量：不开栏`;
  // The server's environment belongs to whoever started it: only the front's says where the session shows.
  const env = front.env ?? hookEnv, agentPid = front.pid, info = front.info;
  if (!info?.tty) return 'Agent 不在终端里（例如 VS Code 里的 Agent）：不开栏';
  if (!interactive(provider, info.args)) return '非交互运行：不开栏';
  const program = paneProgram(env, tools);
  if (!program) return '找不到 agent-sidecar：不开栏';
  for (const adapter of candidates(env)) {
    const place = adapter.locate(env, tools);
    if (place.skip) return `${adapter.name}：${place.skip}`;
    if (!place.owns(agentPid, info)) continue;
    const open = place.find(agentPid);
    if (open.length) return `${place.name}：Agent ${agentPid} 已有栏 ${open.join(',')}，它会自己改绑`;
    const extra = Object.fromEntries(PASSED.filter(key => env[key]).map(key => [key, env[key]]));
    // The state files are where sidecar-state writes them: it runs beside this hook, in the hook's environment.
    if (hookEnv.XDG_STATE_HOME) extra.XDG_STATE_HOME = hookEnv.XDG_STATE_HOME;
    else if (extra.XDG_STATE_HOME) extra.XDG_STATE_HOME = '';
    const result = place.open({ argv: paneArgv(program, agentPid, place.focus), cwd: input.cwd || process.cwd(), env: extra, tag: agentPid });
    const via = front.server ? `，Codex 前台，后台 ${front.server}` : '';
    return result.error ? `${place.name}：开栏失败：${result.error}` : `${place.name}：在 ${place.pane} 旁开栏 ${result.pane}（Agent ${agentPid}${via}）`;
  }
  return '不在支持自动开栏的终端里：不开栏，可以手动运行 agent-sidecar watch';
}

const stateRoot = env => join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-sidecar');
export const logFile = (env = process.env) => join(stateRoot(env), 'split.log');

function log(line, env = process.env) {
  try {
    const file = logFile(env);
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    if (existsSync(file) && statSync(file).size > LOG_LIMIT) renameSync(file, file + '.1');
    appendFileSync(file, line + '\n', { mode: 0o600 });
  } catch { /* Logging must never fail the hook. */ }
}

async function main() {
  const [provider, pid] = process.argv.slice(2);
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
