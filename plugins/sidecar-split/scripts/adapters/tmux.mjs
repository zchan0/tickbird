// tmux: the server in TMUX, the agent's pane in TMUX_PANE. Panes opened for an
// agent carry the pane option @sidecar_agent=<agent pid>.
import { paneColumns } from './width.mjs';

export const name = 'tmux';
export const matches = env => Boolean(env.TMUX);

export function locate(env, { run, which }) {
  const pane = env.TMUX_PANE, socket = env.TMUX?.split(',')[0];
  if (!pane || !socket) return { skip: 'tmux 环境变量不完整（TMUX、TMUX_PANE）' };
  const tmux = which('tmux', env);
  if (!tmux) return { skip: '找不到 tmux' };
  const t = (...args) => run(tmux, ['-S', socket, ...args]);
  const panes = () => {
    const result = t('list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}\t#{@sidecar_agent}');
    return result.status !== 0 ? [] : result.stdout.split('\n').filter(Boolean).map(line => {
      const [id, tty, tag] = line.split('\t');
      return { id, tty: tty.replace(/^\/dev\//, ''), tag };
    });
  };
  return {
    name, pane,
    // The agent runs on the pane's terminal: a stale TMUX from another terminal never matches.
    owns: (_agentPid, info) => Boolean(info?.tty) && panes().some(item => item.id === pane && item.tty === info.tty),
    find: tag => panes().filter(item => item.tag === String(tag)).map(item => item.id),
    open({ argv, cwd, env: extra, tag }) {
      // On the agent's left (-b), a fixed number of columns.
      const total = Number(t('display-message', '-p', '-t', pane, '#{pane_width}').stdout?.trim());
      const size = Number.isInteger(total) && total > 0 ? String(paneColumns(total)) : '35%';
      const result = t('split-window', '-h', '-b', '-d', '-l', size, '-t', pane, '-c', cwd, '-P', '-F', '#{pane_id}',
        ...Object.entries(extra).flatMap(([key, value]) => ['-e', `${key}=${value}`]), ...argv);
      if (result.status !== 0) return { error: result.stderr || `tmux 退出码 ${result.status}` };
      const id = result.stdout.trim();
      t('set-option', '-p', '-t', id, '@sidecar_agent', String(tag));
      return { pane: id };
    },
    // A pane id names its window too: bring the window forward, then the pane.
    focus: [tmux, '-S', socket, 'select-window', '-t', pane, ';', 'select-pane', '-t', pane],
  };
}
