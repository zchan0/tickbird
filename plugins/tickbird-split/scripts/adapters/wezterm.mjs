// WezTerm: `wezterm cli` talks to the GUI that owns WEZTERM_PANE. WezTerm has
// no pane variables, so the pane opened for an agent is kept in panes.json.
// Written from WezTerm's documentation (cli split-pane, list, activate-pane);
// not yet run against a real WezTerm.
import { paneColumns } from './width.mjs';
import { remember, remembered } from './registry.mjs';

export const name = 'WezTerm';
export const matches = env => Boolean(env.WEZTERM_PANE);

export function locate(env, { run, which }) {
  const pane = env.WEZTERM_PANE;
  const wezterm = which('wezterm', env, ['/Applications/WezTerm.app/Contents/MacOS/wezterm']);
  if (!wezterm) return { skip: '找不到 wezterm 命令' };
  const cli = (...args) => run(wezterm, ['cli', ...args]);
  const panes = () => {
    const result = cli('list', '--format', 'json');
    if (result.status !== 0) return [];
    try { return JSON.parse(result.stdout); } catch { return []; }
  };
  const tty = item => String(item.tty_name ?? '').replace(/^\/dev\//, '');
  return {
    name, pane,
    // The agent runs on the pane's terminal: a stale WEZTERM_PANE from another terminal never matches.
    owns: (_agentPid, info) => Boolean(info?.tty) && panes().some(item => String(item.pane_id) === pane && tty(item) === info.tty),
    find: tag => {
      const id = remembered(env, name, tag);
      return id && panes().some(item => String(item.pane_id) === id) ? [id] : [];
    },
    open({ argv, cwd, env: extra, tag }) {
      // On the agent's left, a fixed number of columns; then the agent keeps the focus.
      const total = panes().find(item => String(item.pane_id) === pane)?.size?.cols;
      const size = Number.isInteger(total) && total > 0 ? ['--cells', String(paneColumns(total))] : ['--percent', '35'];
      const result = cli('split-pane', '--pane-id', pane, '--left', ...size, '--cwd', cwd, '--',
        'env', ...Object.entries(extra).map(([key, value]) => `${key}=${value}`), ...argv);
      if (result.status !== 0) return { error: result.stderr || `wezterm 退出码 ${result.status}` };
      const id = result.stdout.trim();
      remember(env, name, tag, id);
      cli('activate-pane', '--pane-id', pane);
      return { pane: id };
    },
    focus: [wezterm, 'cli', 'activate-pane', '--pane-id', pane],
  };
}
