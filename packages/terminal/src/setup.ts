import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Private install of the agents' side: the plugins in Claude Code and Codex,
 * kitty's remote control, and the checks around them. Every command runs
 * through `run`, so tests stand in for claude, codex and code. Running it
 * again changes nothing that is already in place.
 */
export interface RunResult { ok: boolean; out: string; missing?: boolean }
export type Runner = (command: string, args: string[]) => RunResult;

export const MARKETPLACE = 'tickbird';
export const STATE = `tickbird-state@${MARKETPLACE}`, SPLIT = `tickbird-split@${MARKETPLACE}`;
export const EXTENSION = 'zchan0.tickbird';
const CODE = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
// Names used before: agent-sidecar-local until 2026-10-05, Agent Sidecar until 2026-10-12.
// Removed on sight so a reinstall leaves one copy.
export const OLD = {
  marketplaces: ['agent-sidecar-local', 'agent-sidecar'],
  plugins: ['agent-sidecar@agent-sidecar-local', 'sidecar-state@agent-sidecar', 'sidecar-split@agent-sidecar'],
  extensions: ['agent-sidecar-local.agent-sidecar', 'zchan0.agent-sidecar'],
  command: 'agent-sidecar',
};

export const spawnRunner: Runner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 });
  return { ok: result.status === 0 && !result.error, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(), missing: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' };
};

const json = (run: Runner, command: string, args: string[]): any => {
  const result = run(command, args);
  try { return result.ok ? JSON.parse(result.out) : undefined; } catch { return undefined; }
};
const lastLine = (text: string) => text.split('\n').filter(Boolean).at(-1) ?? '';

/** One line of the report: ✓ done, ✗ failed, · for the reader to know or do. */
export interface Report { ok(what: string, note?: string): void; fail(what: string, note?: string): void; info(text: string): void; failed: boolean }
export function consoleReport(write: (line: string) => void = line => console.log(line)): Report {
  const report: Report = {
    failed: false,
    ok: (what, note) => write(`✓ ${what}${note ? `：${note}` : ''}`),
    fail: (what, note) => { report.failed = true; write(`✗ ${what}${note ? `：${note}` : ''}`); },
    info: text => write(`· ${text}`),
  };
  return report;
}

/** Claude Code: `source` as a folder marketplace, then each plugin installed or brought up to date. */
export function claudePlugins(run: Runner, source: string, ids: string[], report: Report): boolean {
  const markets = json(run, 'claude', ['plugin', 'marketplace', 'list', '--json']);
  if (!markets) { report.fail('Claude Code', '没有找到 claude 命令，跳过'); return false; }
  const before = new Set((json(run, 'claude', ['plugin', 'list', '--json']) ?? []).map((item: any) => item.id));
  for (const id of OLD.plugins) if (before.has(id)) { run('claude', ['plugin', 'uninstall', id]); report.ok(`Claude Code：移除旧插件 ${id}`); }
  for (const name of OLD.marketplaces) if (markets.some((item: any) => item.name === name)) run('claude', ['plugin', 'marketplace', 'remove', name]);
  const now = json(run, 'claude', ['plugin', 'marketplace', 'list', '--json']) ?? [];
  const market = now.some((item: any) => item.name === MARKETPLACE)
    ? run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE]) : run('claude', ['plugin', 'marketplace', 'add', source]);
  if (!market.ok) { report.fail('Claude Code 插件市场', lastLine(market.out)); return false; }
  const installed = new Set((json(run, 'claude', ['plugin', 'list', '--json']) ?? []).map((item: any) => item.id));
  let all = true;
  for (const id of ids) {
    const result = installed.has(id) ? run('claude', ['plugin', 'update', id]) : run('claude', ['plugin', 'install', id, '--scope', 'user']);
    if (result.ok) report.ok(`Claude Code：${id.split('@')[0]}`, installed.has(id) ? '已更新（新开的会话生效）' : '已安装（/plugin 里可以停用）');
    else { report.fail(`Claude Code：${id.split('@')[0]}`, lastLine(result.out)); all = false; }
  }
  return all;
}

/** Codex: the same folder through .agents/plugins/marketplace.json. */
export function codexPlugins(run: Runner, source: string, ids: string[], report: Report): boolean {
  const markets = json(run, 'codex', ['plugin', 'marketplace', 'list', '--json']);
  if (!markets) { report.fail('Codex', '没有找到 codex 命令，跳过'); return false; }
  // `codex plugin remove` reports success even for a plugin that is not there: run it, do not report it.
  for (const id of OLD.plugins) run('codex', ['plugin', 'remove', id]);
  for (const name of OLD.marketplaces) run('codex', ['plugin', 'marketplace', 'remove', name]);
  // Listed again: Codex names a marketplace by its manifest, so one added under an earlier name
  // read as this one until it was removed just now.
  const known = (json(run, 'codex', ['plugin', 'marketplace', 'list', '--json'])?.marketplaces ?? []).some((item: any) => item.name === MARKETPLACE);
  const market = known ? { ok: true, out: '' } : run('codex', ['plugin', 'marketplace', 'add', source]);
  if (!market.ok) { report.fail('Codex 插件市场', lastLine(market.out)); return false; }
  let all = true;
  for (const id of ids) {
    const result = run('codex', ['plugin', 'add', id]);
    if (result.ok) report.ok(`Codex：${id.split('@')[0]}`, '已安装');
    else { report.fail(`Codex：${id.split('@')[0]}`, lastLine(result.out)); all = false; }
  }
  return all;
}

/** The VS Code extension's version, or undefined when it is not installed (or VS Code is not there). */
export function vscodeExtension(run: Runner, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const result = run(env.TICKBIRD_CODE_CLI || CODE, ['--list-extensions', '--show-versions']);
  if (!result.ok) return undefined;
  return result.out.split('\n').map(line => line.trim()).find(line => line.toLowerCase().startsWith(EXTENSION + '@'))?.split('@')[1];
}

const versionParts = (version: string) => version.split('.').map(part => Number(part) || 0);
export const olderThan = (version: string, than: string) => {
  const [a, b] = [versionParts(version), versionParts(than)];
  for (let at = 0; at < 3; at++) if ((a[at] ?? 0) !== (b[at] ?? 0)) return (a[at] ?? 0) < (b[at] ?? 0);
  return false;
};

// kitty ------------------------------------------------------------------

export const kittyConfigPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.KITTY_CONFIG_DIRECTORY || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kitty'), 'kitty.conf');

/** What kitty.conf says about remote control, as kitty reads it: the last setting wins. */
export function kittyRemote(text: string): { remote: boolean; listen: boolean; splits?: boolean } {
  let remote = false, listen = false, splits: boolean | undefined;
  for (const raw of text.split('\n')) {
    const [key, ...rest] = raw.trim().split(/\s+/);
    const value = rest.join(' ');
    if (key === 'allow_remote_control') remote = ['yes', 'socket-only', 'socket'].includes(value);
    else if (key === 'listen_on') listen = value.startsWith('unix:');
    else if (key === 'enabled_layouts') splits = value === '*' || value.split(',').map(item => item.trim().split(':')[0]).includes('splits');
  }
  return { remote, listen, splits };
}

/** The lines setup appends: kitty listens on a socket per instance, and only that socket controls it. */
export const KITTY_LINES = ['# Tickbird: open the Tickbird pane beside an agent (tickbird setup)', 'allow_remote_control socket-only', 'listen_on unix:${TMPDIR}/kitty-{kitty_pid}'];

export interface KittyOptions { env?: NodeJS.ProcessEnv; ask?: (question: string) => Promise<boolean>; now?: Date; kittyApp?: string }

/** kitty is here: its command answers, its app is installed, or it has a config. */
export function kittyInstalled(run: Runner, env: NodeJS.ProcessEnv = process.env, app = '/Applications/kitty.app'): boolean {
  return run('kitty', ['--version']).ok || existsSync(app) || existsSync(kittyConfigPath(env));
}

/**
 * Checks kitty's remote control. With `ask` answering yes, backs up
 * kitty.conf and appends the two lines; kitty reads them after a full restart.
 */
export async function kitty(report: Report, { env = process.env, ask, now = new Date() }: KittyOptions = {}): Promise<void> {
  const file = kittyConfigPath(env);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const status = kittyRemote(text);
  if (status.splits === false) report.info(`kitty 的 enabled_layouts 不含 splits：栏会按当前布局摆放，不一定在 Agent 右侧（${file}）`);
  if (status.remote && status.listen) { report.ok('kitty 远程控制', '已开启'); return; }
  report.info(`kitty 还没开启远程控制，自动开栏需要在 ${file} 里加上：`);
  for (const line of KITTY_LINES.slice(1)) report.info(`    ${line}`);
  if (!ask || !(await ask(`要替你备份 kitty.conf 并加上这两行吗？[y/N] `))) { report.info('没有修改 kitty.conf。加上后要完全退出并重新打开 kitty'); return; }
  mkdirSync(join(file, '..'), { recursive: true });
  if (existsSync(file)) {
    const backup = `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
    report.ok('kitty.conf 已备份', backup);
  }
  writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + '\n' + KITTY_LINES.join('\n') + '\n');
  report.ok('kitty.conf 已修改', '完全退出并重新打开 kitty 后生效（只关窗口不够）');
}

// setup and uninstall ----------------------------------------------------

export interface Paths { data: string; bin: string }
export const installPaths = (env: NodeJS.ProcessEnv = process.env): Paths => ({
  data: env.TICKBIRD_DATA || join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'tickbird'),
  bin: env.TICKBIRD_BIN || join(homedir(), '.local', 'bin'),
});

/** Written by `npm run install:terminal`: where the plugins come from, and which version is installed. */
export interface InstallRecord { source: string; version: string }
export function installRecord(paths: Paths): InstallRecord | undefined {
  try { return JSON.parse(readFileSync(join(paths.data, 'install.json'), 'utf8')); } catch { return undefined; }
}

export interface SetupOptions extends KittyOptions { run?: Runner; report?: Report; source?: string; version?: string; paths?: Paths }

/** `tickbird setup`: the plugins in both agents, kitty, and what is left for the reader to do. */
export async function setup(options: SetupOptions = {}): Promise<boolean> {
  const { run = spawnRunner, report = consoleReport(), env = process.env } = options;
  const paths = options.paths ?? installPaths(env);
  const record = installRecord(paths);
  const source = options.source ?? record?.source;
  const version = options.version ?? record?.version;
  if (!source || !existsSync(join(source, '.claude-plugin', 'marketplace.json'))) {
    report.fail('找不到插件来源', '在仓库里运行 npm run install:terminal，或用 tickbird setup --source <仓库>');
    return false;
  }
  claudePlugins(run, source, [STATE, SPLIT], report);
  const codex = codexPlugins(run, source, [STATE, SPLIT], report);
  if (codex) report.info('Codex 第一次启动时会提示 Hooks need review：选 Trust all（或在 Codex 里执行 /hooks，按 t）。不信任时 Codex 会静默跳过这些 hook');
  const extension = vscodeExtension(run, env);
  if (extension && version && olderThan(extension, version)) report.info(`VS Code 版是 ${extension}，比接入（${version}）旧：在仓库里运行 npm run install:vscode 一起更新`);
  if (run('tmux', ['-V']).ok) report.ok('tmux', '可以自动开栏');
  // Only a terminal that is here is checked; tmux and kitty are the ones with a split adapter today.
  if (kittyInstalled(run, env, options.kittyApp)) await kitty(report, options);
  report.info('Agent 已经开着的会话不受影响：新开一个会话后生效');
  return !report.failed;
}

export interface UninstallOptions { run?: Runner; report?: Report; env?: NodeJS.ProcessEnv; paths?: Paths }

/**
 * `tickbird uninstall`: the terminal version only. tickbird-state stays
 * while the VS Code version is installed: it reads the same state files.
 */
export function uninstall({ run = spawnRunner, report = consoleReport(), env = process.env, paths = installPaths(env) }: UninstallOptions = {}): boolean {
  const keepState = Boolean(vscodeExtension(run, env));
  const ids = keepState ? [SPLIT] : [SPLIT, STATE];
  const claude = json(run, 'claude', ['plugin', 'list', '--json']);
  if (claude) {
    for (const id of ids) if (claude.some((item: any) => item.id === id)) {
      const result = run('claude', ['plugin', 'uninstall', id]);
      if (result.ok) report.ok(`Claude Code：移除 ${id.split('@')[0]}`); else report.fail(`Claude Code：移除 ${id.split('@')[0]}`, lastLine(result.out));
    }
    if (!keepState) run('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE]);
  }
  const codex = json(run, 'codex', ['plugin', 'list', '--json']);
  if (codex) {
    for (const id of ids) if ((codex.installed ?? []).some((item: any) => item.pluginId === id)) {
      const result = run('codex', ['plugin', 'remove', id]);
      if (result.ok) report.ok(`Codex：移除 ${id.split('@')[0]}`); else report.fail(`Codex：移除 ${id.split('@')[0]}`, lastLine(result.out));
    }
    if (!keepState) run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE]);
  }
  if (keepState) report.info('VS Code 版还在用 tickbird-state，保留它');
  const launcher = join(paths.bin, 'tickbird');
  if (existsSync(launcher)) { rmSync(launcher); report.ok('移除命令', launcher); }
  if (existsSync(paths.data)) { rmSync(paths.data, { recursive: true, force: true }); report.ok('移除程序文件', paths.data); }
  report.info('kitty.conf 里的远程控制设置没有改动；不需要时可以自己删掉');
  return !report.failed;
}
