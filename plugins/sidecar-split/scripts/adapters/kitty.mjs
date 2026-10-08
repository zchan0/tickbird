// kitty: remote control over the socket in KITTY_LISTEN_ON. Panes opened for
// an agent carry the user variable sidecar_agent=<agent pid>.
import { dirname, join } from 'node:path';

export const name = 'kitty';
// kitty sets TERM=xterm-kitty and no TERM_PROGRAM. Another terminal started
// from a kitty shell keeps KITTY_WINDOW_ID but names itself in TERM_PROGRAM.
export const matches = env => Boolean(env.KITTY_WINDOW_ID) && (env.TERM === 'xterm-kitty' || !env.TERM_PROGRAM);

export function locate(env, { run, which }) {
  const window = env.KITTY_WINDOW_ID, socket = env.KITTY_LISTEN_ON;
  if (!socket) return { skip: 'kitty 没有开启 socket 远程控制（allow_remote_control socket-only 与 listen_on）' };
  // This kitty's own kitten first: macOS keeps it in Contents/MacOS, Linux in bin/.
  const home = env.KITTY_INSTALLATION_DIR;
  const kitten = which('kitten', env, home ? [join(home, '..', '..', 'MacOS', 'kitten'), join(dirname(dirname(home)), 'bin', 'kitten')] : []);
  if (!kitten) return { skip: '找不到 kitten' };
  const at = (...args) => run(kitten, ['@', '--to', socket, ...args]);
  const windows = match => {
    const result = at('ls', '--match', match);
    if (result.status !== 0) return [];
    try { return JSON.parse(result.stdout).flatMap(os => os.tabs.flatMap(tab => tab.windows)); } catch { return []; }
  };
  return {
    name, pane: window,
    // The agent is one of the window's foreground processes: stale kitty variables in another terminal never match.
    owns: agentPid => windows(`id:${window}`).some(win => win.foreground_processes?.some(proc => proc.pid === agentPid)),
    find: tag => windows(`var:sidecar_agent=${tag}`).map(win => String(win.id)),
    open({ argv, cwd, env: extra, tag }) {
      const result = at('launch', '--type=window', '--location=vsplit', '--next-to', `id:${window}`, '--keep-focus', '--bias=35',
        '--var', `sidecar_agent=${tag}`, '--cwd', cwd, '--title', 'Sidecar',
        ...Object.entries(extra).flatMap(([key, value]) => ['--env', `${key}=${value}`]), ...argv);
      return result.status === 0 ? { pane: result.stdout.trim() } : { error: result.stderr || `kitten 退出码 ${result.status}` };
    },
    focus: [kitten, '@', '--to', socket, 'focus-window', '--match', `id:${window}`],
  };
}
