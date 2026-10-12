/**
 * The pane's width in columns: 48, the width the pane is drawn for, but never
 * more than 40% of the agent's window, so the agent keeps most of it.
 */
export const paneColumns = total => Math.max(1, Math.min(48, Math.floor(total * 0.4)));
