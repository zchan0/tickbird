import { execFileSync } from 'node:child_process';

/**
 * What this terminal can do, asked of the terminal itself rather than guessed
 * from its name. Every query goes out at once, followed by DA1, which every
 * terminal answers: a query still unanswered when DA1 arrives is unsupported.
 */
export interface Capabilities {
  /** Answers came back at all; false under TERM=dumb or when nothing answered in time. */
  probed: boolean;
  /** Synchronized output (DEC mode 2026): a frame shows whole. */
  sync: boolean;
  /** OSC 8 hyperlinks. Cannot be queried; decided from the environment. */
  links: boolean;
  images: 'kitty' | 'iterm' | false;
  notify: 'osc99' | 'osc9' | false;
  /** The kitty keyboard protocol: Esc and Alt combinations stay apart. */
  kittyKeyboard: boolean;
  /** OSC 52 clipboard writes, as the terminal's own terminfo says (XTGETTCAP Ms). */
  clipboard: boolean;
  background?: { r: number; g: number; b: number; dark: boolean };
  /** XTVERSION, for the report only: never used to decide a feature that can be asked. */
  terminal?: string;
  inTmux: boolean;
  /** Measured cell width of each symbol the views use. */
  symbols: Record<string, number>;
}

/** Symbols the views draw, and what replaces each one when it is not one cell wide. */
export const SYMBOLS: Readonly<Record<string, string>> = {
  '●': '*', '✻': '*', '┃': '|', '…': '...', '─': '-', '⏸': '||', '▌': '|', '›': '>', '‹': '<', '│': '|', '✓': 'v', '❯': '>',
  '☐': '[ ]', '☑': '[x]', '┌': '+', '┬': '+', '┐': '+', '├': '+', '┼': '+', '┤': '+', '└': '+', '┴': '+', '┘': '+',
};

export const NONE: Capabilities = { probed: false, sync: false, links: false, images: false, notify: false, kittyKeyboard: false, clipboard: false, inTmux: false, symbols: {} };

const ESC = '\x1b', ST = '\x1b\\';

/** tmux and GNU screen take an APC string as the pane title, and pass no images anyway. */
export const apcIsTitle = (env: NodeJS.ProcessEnv): boolean => Boolean(env.TMUX || env.STY);

/** The query batch. Symbol widths are measured with cursor reports on a line that is cleared after. */
export function queries(symbols = Object.keys(SYMBOLS), graphics = true): string {
  return `${ESC}[?2026$p`                                   // DECRQM synchronized output
    + `${ESC}[?u`                                           // kitty keyboard flags
    + (graphics ? `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}` : '') // kitty graphics query
    + `${ESC}]11;?${ST}`                                    // background colour
    + `${ESC}[>0q`                                          // XTVERSION
    + `${ESC}]99;i=sidecar:p=?;${ST}`                        // OSC 99 notification query
    + `${ESC}P+q4d73${ST}`                                  // XTGETTCAP Ms (clipboard)
    + symbols.map(symbol => `\r${symbol}${ESC}[6n`).join('')
    + `\r${ESC}[2K`
    + `${ESC}[c`;                                           // DA1, answered by everyone
}

export interface Answers {
  done: boolean;
  sync?: boolean; kittyKeyboard?: boolean; kittyGraphics?: boolean; osc99?: boolean; clipboard?: boolean;
  background?: Capabilities['background']; terminal?: string; cursorColumns: number[];
}

/** Reads every answer found so far in the terminal's replies. */
export function parseAnswers(text: string): Answers {
  const answers: Answers = { done: /\x1b\[\?[\d;]*c/.test(text), cursorColumns: [] };
  const sync = text.match(/\x1b\[\?2026;(\d)\$y/);
  if (sync) answers.sync = sync[1] === '1' || sync[1] === '2';
  if (/\x1b\[\?\d+u/.test(text)) answers.kittyKeyboard = true;
  if (/\x1b_Gi=31;OK/.test(text)) answers.kittyGraphics = true;
  if (/\x1b\]99;i=sidecar:p=\?;/.test(text)) answers.osc99 = true;
  if (/\x1bP1\+r4d73/.test(text)) answers.clipboard = true;
  const bg = text.match(/\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
  if (bg) {
    const channel = (hex: string) => Math.round(parseInt(hex, 16) / (16 ** hex.length - 1) * 255);
    const [r, g, b] = [channel(bg[1]), channel(bg[2]), channel(bg[3])];
    answers.background = { r, g, b, dark: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 };
  }
  const version = text.match(/\x1bP>\|([^\x1b]*)\x1b\\/);
  if (version) answers.terminal = version[1];
  for (const report of text.matchAll(/\x1b\[(\d+);(\d+)R/g)) answers.cursorColumns.push(Number(report[2]));
  return answers;
}

/** Links cannot be queried: off on terminals that cannot show them, and in tmux unless it forwards them. */
export function linksFromEnvironment(env: NodeJS.ProcessEnv, tmuxFeatures?: string): boolean {
  if (!env.TERM || env.TERM === 'dumb' || env.TERM === 'linux') return false;
  if (env.TMUX) return Boolean(tmuxFeatures && /hyperlinks/.test(tmuxFeatures));
  return true;
}

export function capabilitiesFrom(answers: Answers, env: NodeJS.ProcessEnv, symbols = Object.keys(SYMBOLS), tmuxFeatures?: string): Capabilities {
  const terminal = answers.terminal;
  const iterm = /iTerm2/i.test(terminal ?? '') || env.TERM_PROGRAM === 'iTerm.app';
  const osc9 = /iTerm2|WezTerm|ghostty/i.test(terminal ?? '');
  const widths: Record<string, number> = {};
  // Each report follows one symbol drawn from column 1: the column after it gives its width.
  symbols.forEach((symbol, index) => { const column = answers.cursorColumns[index]; if (column) widths[symbol] = column - 1; });
  return {
    probed: answers.done,
    sync: Boolean(answers.sync),
    links: linksFromEnvironment(env, tmuxFeatures),
    images: answers.kittyGraphics ? 'kitty' : iterm ? 'iterm' : false,
    notify: answers.osc99 ? 'osc99' : osc9 ? 'osc9' : false,
    kittyKeyboard: Boolean(answers.kittyKeyboard),
    clipboard: Boolean(answers.clipboard),
    ...(answers.background ? { background: answers.background } : {}),
    ...(terminal ? { terminal } : {}),
    inTmux: Boolean(env.TMUX),
    symbols: widths,
  };
}

function readTmuxFeatures(): string | undefined {
  try { return execFileSync('tmux', ['show', '-sv', 'terminal-features'], { encoding: 'utf8', timeout: 500 }); } catch { return undefined; }
}

export interface ProbeIO {
  write(text: string): void;
  /** Subscribes to raw input; returns the unsubscribe. */
  onData(listener: (text: string) => void): () => void;
}

/** Asks the terminal. The input must already be raw; nothing is asked of a dumb terminal. */
/**
 * DA1 normally comes back within a few milliseconds, but kitty answers about
 * 190ms late while its window is in the background. Every terminal answers DA1,
 * so the wait ends there; the limit only guards against one that never does.
 */
export const PROBE_TIMEOUT_MS = 1000;

export async function probe(io: ProbeIO, env: NodeJS.ProcessEnv = process.env, timeoutMs = PROBE_TIMEOUT_MS, tmuxFeaturesOf = readTmuxFeatures): Promise<Capabilities> {
  if (!env.TERM || env.TERM === 'dumb') return NONE;
  const tmuxFeatures = env.TMUX ? tmuxFeaturesOf() : undefined;
  let received = '';
  const answered = new Promise<void>(resolve => {
    const stop = io.onData(text => { received += text; if (parseAnswers(received).done) { stop(); resolve(); } });
    setTimeout(() => { stop(); resolve(); }, timeoutMs).unref?.();
  });
  io.write(queries(Object.keys(SYMBOLS), !apcIsTitle(env)));
  await answered;
  return capabilitiesFrom(parseAnswers(received), env, Object.keys(SYMBOLS), tmuxFeatures);
}

/** A symbol where it is one cell wide, its ASCII stand-in otherwise or when unmeasured. */
export const symbol = (caps: Pick<Capabilities, 'symbols'>, ch: string): string => caps.symbols[ch] === 1 ? ch : SYMBOLS[ch] ?? ch;
