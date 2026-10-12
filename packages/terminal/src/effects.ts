import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

/**
 * What `o` and `y` do outside the screen. Both only read: `o` opens the file
 * as it is on disk now, in the user's editor; `y` puts text on the clipboard.
 */
export interface EditorCommand {
  command: string;
  args: string[];
  /** Runs inside this pane: the pane gives the terminal to it until it exits. */
  inPane: boolean;
  name: string;
}

const TERMINAL_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'hx', 'helix', 'kak', 'micro', 'joe', 'ne', 'mg']);
const GOTO_EDITORS = new Set(['code', 'code-insiders', 'cursor', 'windsurf', 'codium']);

/** Arguments that open `path` at `line` for one editor; unknown editors get the path only. */
export function editorArgs(editor: string, path: string, line?: number): string[] {
  const name = basename(editor);
  if (!line) return [path];
  if (GOTO_EDITORS.has(name)) return ['-g', `${path}:${line}`];
  if (name === 'subl' || name === 'zed') return [`${path}:${line}`];
  if (TERMINAL_EDITORS.has(name)) return [`+${line}`, path];
  return [path];
}

/**
 * $VISUAL, then $EDITOR, then VS Code, then the system's default program.
 * An editor variable may carry flags ("code --wait"); they are kept.
 */
export function editorCommand(path: string, line: number | undefined, env: NodeJS.ProcessEnv, has: (command: string) => boolean, platform = process.platform): EditorCommand {
  for (const value of [env.VISUAL, env.EDITOR]) {
    const words = value?.trim().split(/\s+/).filter(Boolean);
    if (!words?.length) continue;
    const name = basename(words[0]);
    return { command: words[0], args: [...words.slice(1), ...editorArgs(words[0], path, line)], inPane: TERMINAL_EDITORS.has(name), name };
  }
  if (has('code')) return { command: 'code', args: editorArgs('code', path, line), inPane: false, name: 'VS Code' };
  return { command: platform === 'darwin' ? 'open' : 'xdg-open', args: [path], inPane: false, name: '系统默认程序' };
}

export const commandExists = (command: string): boolean => {
  try { execFileSync('/bin/sh', ['-c', 'command -v "$0"', command], { stdio: 'ignore' }); return true; } catch { return false; }
};

/** OSC 52: the terminal puts the text on the clipboard. */
export const clipboardBytes = (text: string): string => `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x1b\\`;

/**
 * Opens an image in the system's viewer: the bytes the transcript kept, saved
 * to a temporary file, or else the file it was read from as it is now.
 */
export function viewImage(image: { name: string; data?: string; mime?: string; path?: string }, platform = process.platform): string {
  let path = image.path;
  if (image.data) {
    const extension = extname(image.name) || '.' + (image.mime ?? 'image/png').split('/')[1];
    const directory = join(tmpdir(), 'tickbird');
    mkdirSync(directory, { recursive: true });
    path = join(directory, createHash('sha256').update(image.data).digest('hex').slice(0, 12) + '-' + basename(image.name, extname(image.name)) + extension);
    if (!existsSync(path)) writeFileSync(path, Buffer.from(image.data, 'base64'));
  }
  if (!path || !existsSync(path)) return `图片已不存在：${image.path ?? image.name}`;
  try {
    spawn(platform === 'darwin' ? 'open' : 'xdg-open', [path], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
    return '';
  } catch {
    return `无法打开图片：${image.name}`;
  }
}

/** Opens a web address in the browser, or a local file in its default program. */
export function openLink(link: { target: string; name: string }, platform = process.platform): string {
  const web = /^https?:\/\//.test(link.target);
  if (!web && !existsSync(link.target)) return `文件已不存在：${link.target}`;
  try {
    spawn(platform === 'darwin' ? 'open' : 'xdg-open', [link.target], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
    return '';
  } catch {
    return `无法打开：${link.target}`;
  }
}

/**
 * Opens a file. A terminal editor takes over the pane until it exits (the
 * caller leaves and re-enters its screen around it); others start detached.
 * Returns what went wrong, or nothing: what opened says so itself.
 */
export function openFile(path: string, line: number | undefined, around: { suspend(): void; resume(): void }): string {
  if (!existsSync(path)) return `文件已不存在：${path}`;
  const editor = editorCommand(path, line, process.env, commandExists);
  try {
    if (editor.inPane) {
      around.suspend();
      try { spawnSync(editor.command, editor.args, { stdio: 'inherit' }); } finally { around.resume(); }
      return '';
    }
    spawn(editor.command, editor.args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
    return '';
  } catch {
    return `无法打开：${editor.command}`;
  }
}
