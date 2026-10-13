// Zellij: `zellij --session <ZELLIJ_SESSION_NAME> action …`, the agent's pane in
// ZELLIJ_PANE_ID. A new pane opens to the right only; it is moved to the
// agent's left, and the focus goes back to the agent. The pane opened for an
// agent is named "Tickbird <agent pid>", and found again by that name.
// Written from Zellij's documentation (cli actions); not yet run against a real Zellij.
export const name = 'Zellij';
export const matches = env => Boolean(env.ZELLIJ);

export function locate(env, { run, which }) {
  const pane = env.ZELLIJ_PANE_ID, session = env.ZELLIJ_SESSION_NAME;
  if (!pane || !session) return { skip: 'Zellij 环境变量不完整（ZELLIJ_PANE_ID、ZELLIJ_SESSION_NAME）' };
  const zellij = which('zellij', env);
  if (!zellij) return { skip: '找不到 zellij' };
  const action = (...args) => run(zellij, ['--session', session, 'action', ...args]);
  const agentPane = `terminal_${String(pane).replace(/^terminal_/, '')}`;
  const title = tag => `Tickbird ${tag}`;
  return {
    name, pane,
    // ZELLIJ_PANE_ID is read from the agent's own environment (see front.mjs): it is the agent's pane.
    owns: () => true,
    // list-panes (newer Zellij) names every pane; without it nothing is known, and a pane is opened.
    find: tag => {
      const result = action('list-panes');
      return result.status === 0 && result.stdout.includes(title(tag)) ? [title(tag)] : [];
    },
    open({ argv, cwd, env: extra, tag }) {
      const result = action('new-pane', '--direction', 'right', '--close-on-exit', '--name', title(tag), '--cwd', cwd, '--',
        'env', ...Object.entries(extra).map(([key, value]) => `${key}=${value}`), ...argv);
      if (result.status !== 0) return { error: result.stderr || `zellij 退出码 ${result.status}` };
      // The new pane has the focus: to the agent's left, then back to the agent.
      action('move-pane', 'left');
      action('focus-pane-id', agentPane);
      return { pane: result.stdout.trim() || title(tag) };
    },
    focus: [zellij, '--session', session, 'action', 'focus-pane-id', agentPane],
  };
}
