import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, statSync, watch as watchFiles } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionCandidate } from '../../core/src/model';
import { discoverSessions } from '../../core/src/sessions';
import { openLiveSession, type LiveSession } from '../../core/src/live-session';
import { readSessionStates, sessionStateDirectory, type SessionState, type SessionStateCache } from '../../core/src/session-state';
import { liveExtras } from '../../core/src/live-extras';
import { readClaudeSubagents, type SubagentCache } from '../../core/src/subagents';
import type { SessionData } from '../../core/src/model';
import { Motion, SPIN_MS } from './motion';
import { visibleTurnGroups } from '../../core/src/outline';
import type { turnView } from '../../core/src/turn-view';
import type { Capabilities } from './caps';
import { describe, InputParser } from './input';
import { enterBytes, leaveBytes, row, Screen, type Line } from './screen';
import { frame, initialState, key, pointerGone, pointerRest, update, windowTitle, type AppState, type Effect, type Model } from './app';
import { clipboardBytes, openFile, openLink, viewImage } from './effects';
import { sessionStatus, viewOf } from './views/turn-page';
import { prose } from './views/prose';
import { t } from '../../core/src/i18n';

const ESCAPE_GAP_MS = 30;
const STATE_POLL_MS = 1000;
/** How often a paused transcript is opened again. */
const REOPEN_MS = 2000;

/**
 * Which session to show: the one named (by id or transcript path), or the
 * newest one of this directory. A session named by id is also looked up in the
 * integration's state files: they hold its transcript, wherever the agent
 * keeps them (a custom CODEX_HOME too), and its directory.
 */
export async function resolveSession(target: string | undefined, cwd: string, states: SessionState[]): Promise<SessionCandidate | undefined> {
  if (!target) return (await discoverSessions({ projectPath: cwd })).candidates[0];
  const file = existsSync(target) ? resolve(target) : undefined;
  const state = states.find(item => item.session === target || (file && item.transcript === file));
  if (state?.transcript && existsSync(state.transcript)) {
    return { id: state.session, provider: state.provider, file: state.transcript, projectPath: state.cwd,
      updatedAt: statSync(state.transcript).mtimeMs, activity: 'unverified' };
  }
  for (const projectPath of [cwd, state?.cwd].filter((path): path is string => Boolean(path))) {
    const found = (await discoverSessions({ projectPath })).candidates.find(candidate => candidate.id === target || candidate.file === file);
    if (found) return found;
  }
  return undefined;
}

/**
 * How the pane was started. By hand: a session (id or transcript) or the
 * newest of this directory. By the split plugin: `--agent <pid>` follows that
 * agent process from session to session and exits with it; `--focus <json
 * argv>` is the command that brings the agent's pane forward.
 */
export interface WatchOptions { target?: string; agent?: number; focus?: string[] }

export function parseWatchArgs(args: string[]): WatchOptions | { error: string } {
  const options: WatchOptions = {};
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === '--agent') {
      const pid = Number(args[++at]);
      if (!Number.isInteger(pid) || pid <= 1) return { error: t('--agent needs the agent\'s process id', '--agent 需要 Agent 的进程号') };
      options.agent = pid;
    } else if (arg === '--focus') {
      try {
        const argv = JSON.parse(args[++at] ?? '');
        if (!Array.isArray(argv) || !argv.length || !argv.every(item => typeof item === 'string')) throw new Error();
        options.focus = argv;
      } catch { return { error: t('--focus needs a JSON array of strings', '--focus 需要 JSON 字符串数组') }; }
    } else if (arg.startsWith('-')) return { error: t(`unknown option ${arg}`, `不认识的参数 ${arg}`) };
    else if (options.target === undefined) options.target = arg;
    else return { error: t(`extra argument ${arg}`, `多余的参数 ${arg}`) };
  }
  return options;
}

/**
 * The session an agent process is in now: its newest one not ended. /clear
 * ends one session and starts the next in the same process; between the two,
 * none is current and the pane keeps what it shows.
 */
export function agentSession(states: SessionState[], agentPid: number): SessionState | undefined {
  return states.filter(state => state.agentPid === agentPid && state.phase !== 'ended').sort((a, b) => b.activeAt - a.activeAt)[0];
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

const SET_TITLE = (title: string) => `\x1b]2;${title.replace(/[\x00-\x1f\x7f]/g, ' ')}\x1b\\`;
// xterm's title stack: keep the tab's own title and give it back on exit.
const PUSH_TITLE = '\x1b[22;2t', POP_TITLE = '\x1b[23;2t';

/** Runs the pane until q, Ctrl+C, or the agent it follows exits. The terminal must already be probed. */
export async function watch(options: WatchOptions, caps: Capabilities): Promise<void> {
  const { agent, focus } = options;
  if (agent && !alive(agent)) return;
  const out = process.stdout, input = process.stdin;
  const screen = new Screen(out, caps, out.columns, out.rows);
  const cache: SessionStateCache = new Map();
  const stateDir = sessionStateDirectory();
  let states = await readSessionStates(stateDir, undefined, cache);
  let live: LiveSession | undefined;
  /** The transcript `live` reads, and its subagents' own sessions. */
  let liveFile: string | undefined;
  let subagents: ReadonlyMap<string, SessionData> = new Map(), subagentsRevision = 0;
  const subagentCache: SubagentCache = new Map();
  let pausedRetry = 0;
  let app: AppState = initialState();
  // What is new on the page: the first page of a session is drawn still, what comes after moves in.
  let motion = new Motion();
  let frames = 0;
  let moving: NodeJS.Timeout | undefined;
  let title = '';
  let timer: NodeJS.Timeout | undefined;
  /** The session to show: the one named, the agent's current one, or (undefined) the directory's newest. */
  let target = options.target;
  let opening = false;
  const parser = new InputParser();

  const stateOf = () => live && states.find(item => item.provider === live!.session.provider && item.session === live!.session.id);
  /**
   * The turns, worked out again only when the transcript changed: the app
   * keeps its layout per `groups`, and a key or a pointer move must not pay
   * for reading the whole turn again.
   */
  let revision = 0;
  let turns: { live: LiveSession; revision: number; groups: ReturnType<typeof visibleTurnGroups>; latest?: ReturnType<typeof turnView> } | undefined;
  const model = (): Model | undefined => {
    if (!live) return undefined;
    const session = live.session, state = stateOf();
    if (turns?.live !== live || turns.revision !== revision) {
      const groups = visibleTurnGroups(session);
      turns = { live, revision, groups, ...(groups.length ? { latest: viewOf(groups[groups.length - 1], true, session.provider) } : {}) };
    }
    const { groups, latest } = turns;
    const extras = liveExtras(session, state);
    const agentState = live.health.agent;
    const status = sessionStatus(latest, extras, Date.now(), { busy: agentState === 'busy' || agentState === 'waiting', ended: state?.phase === 'ended', ...(agentState ? { state: agentState } : {}) });
    return { session, groups, status, extras, caps, now: Date.now(), width: screen.width, height: screen.height, focusAgent: Boolean(focus), motion, frame: frames, subagents, subagentsRevision };
  };
  const waitingLines = (message: string): Line[] => {
    const lines: Line[] = [row([{ text: ' Tickbird', style: { bold: true } }], '', screen.width), [], ...prose(message, screen.width - 1, { indent: 3, style: { dim: true } })];
    while (lines.length < screen.height - 1) lines.push([]);
    return [...lines.slice(0, screen.height - 1), row('', [{ text: (focus ? t('a back to agent   ', 'a 切回 Agent   ') : '') + t('q quit ', 'q 退出 '), style: { dim: true } }], screen.width)];
  };
  const waitingMessage = () => agent ? t('Waiting for the first message to the agent: once you send it, this session\'s process shows here.', '等 Agent 的第一条消息：发出后，这里显示这个会话的过程。')
    : target ? t(`No session ${target}`, `找不到会话 ${target}`) : t('No agent session in this directory yet. Start one and it shows here.', '当前目录还没有 Agent 会话，开始一个会话后这里会自动显示。');
  const draw = () => {
    const current = model();
    if (!current) { screen.render(waitingLines(waitingMessage())); return; }
    app = update(app, current);
    screen.render(frame(app, current));
    // Something still coming in or turning: the next frame soon, and only then.
    if (motion.busy && !moving) moving = setTimeout(() => { moving = undefined; frames++; draw(); }, SPIN_MS);
    motion.live = true;
    const next = windowTitle(current);
    if (next !== title) { title = next; out.write(SET_TITLE(title)); }
  };
  const finish = () => {
    void live?.close();
    out.write(leaveBytes(caps.kittyKeyboard) + POP_TITLE);
    if (input.isTTY) input.setRawMode(false);
    process.exit(0);
  };
  const say = (text: string, ms = 3000) => { if (text) app = { ...app, message: { text, until: Date.now() + ms } }; };
  const focusAgent = () => {
    if (!focus) return;
    const result = spawnSync(focus[0], focus.slice(1), { stdio: 'ignore', timeout: 2000 });
    if (result.error || result.status !== 0) say(t('Could not go back to the agent: its pane may be closed', '无法切回 Agent：它的窗格可能已经关闭'));
  };
  const perform = (effect: Effect) => {
    if (effect.kind === 'focus') { focusAgent(); return; }
    if (effect.kind === 'view') { say(viewImage(effect.image), 4000); return; }
    if (effect.kind === 'link') { say(openLink(effect.link), 4000); return; }
    if (effect.kind === 'copy') {
      // OSC 52 where the terminal says it takes it; on this Mac, the system clipboard; otherwise the text is shown to copy by hand.
      const copied = caps.clipboard ? (out.write(clipboardBytes(effect.text)), true)
        : process.platform === 'darwin' && !process.env.SSH_CONNECTION && spawnSync('pbcopy', [], { input: effect.text, timeout: 2000 }).status === 0;
      // Copied, it says nothing (y), but for words dragged over: their inverse is gone on release, and nothing else would tell.
      if (!copied) say(t(`This terminal cannot copy for Tickbird. Copy it by hand: ${effect.text}`, `这个终端不能直接复制，请手动复制：${effect.text}`), 15000);
      else if (effect.selected) say(t('Copied', '已复制'), 1500);
      return;
    }
    say(openFile(effect.path, effect.line, {
      suspend: () => { out.write(leaveBytes(caps.kittyKeyboard)); input.setRawMode(false); },
      resume: () => { input.setRawMode(true); out.write(enterBytes(caps.kittyKeyboard)); screen.resize(out.columns, out.rows); },
    }), 4000);
  };
  // The pointer's call goes dark once the pointer has rested or reached the edge on its way out.
  let resting: NodeJS.Timeout | undefined;
  const watchPointer = (current: Model) => {
    if (resting) clearTimeout(resting);
    const wait = pointerRest(app, current);
    if (wait === undefined) return;
    const at = app.pointer;
    resting = setTimeout(() => { if (app.pointer === at) { app = pointerGone(app); draw(); } }, wait);
  };
  const handle = (events: ReturnType<InputParser['feed']>) => {
    const current = model();
    // TICKBIRD_DEBUG_KEYS=<file>: every parsed key and the raw input, for tracking down terminal quirks.
    if (process.env.TICKBIRD_DEBUG_KEYS) appendFileSync(process.env.TICKBIRD_DEBUG_KEYS, events.map(event => describe(event)).join(' ') + '\n');
    for (const event of events) {
      if (!current) {
        if (event.type === 'key' && (event.name === 'q' || (event.ctrl && event.name === 'c'))) finish();
        if (event.type === 'key' && event.name === 'a' && !event.ctrl && !event.alt) focusAgent();
        continue;
      }
      app = key(app, event, current);
      if (app.quit) finish();
      if (app.effect) { const effect = app.effect; delete app.effect; perform(effect); }
    }
    if (current && events.some(event => event.type === 'mouse')) watchPointer(current);
    draw();
  };

  out.write(PUSH_TITLE + enterBytes(caps.kittyKeyboard));
  input.setRawMode(true);
  input.resume();
  input.on('data', chunk => {
    if (timer) clearTimeout(timer);
    if (process.env.TICKBIRD_DEBUG_KEYS) appendFileSync(process.env.TICKBIRD_DEBUG_KEYS, 'raw ' + JSON.stringify(chunk.toString('utf8')) + '\n');
    handle(parser.feed(chunk.toString('utf8')));
    if (parser.pending) timer = setTimeout(() => handle(parser.flush()), ESCAPE_GAP_MS);
  });
  out.on('resize', () => { screen.resize(out.columns, out.rows); draw(); });
  process.on('SIGTERM', finish);
  process.on('SIGHUP', finish);
  draw();

  /**
   * Opens the session to show, once its transcript exists. Bound to an agent,
   * a new session of that agent (after /clear or /resume) replaces the old one
   * in the same pane, starting fresh on its newest turn.
   */
  const follow = async () => {
    if (opening) return;
    opening = true;
    try {
      if (agent) {
        const current = agentSession(states, agent);
        if (current && current.session !== target) {
          target = current.session;
          if (live) { void live.close(); live = undefined; app = initialState(); motion = new Motion(); }
        }
        if (!target) return;
      }
      // Reading stops when the transcript looks rewritten, or a read fails. That
      // is checked again by opening it afresh; the old copy stays on screen
      // until the new one is read, and the page stays where it is.
      const stale = live?.health.state === 'paused' ? live : undefined;
      if (live && !stale) return;
      if (stale && Date.now() - pausedRetry < REOPEN_MS) return;
      if (stale) pausedRetry = Date.now();
      const wanted = target;
      const candidate = await resolveSession(wanted, process.cwd(), states).catch(() => undefined);
      if (!candidate || target !== wanted) return;
      const opened = await openLiveSession(candidate).catch(() => undefined);
      if (!opened) return;
      if (target !== wanted || live !== stale) { void opened.close(); return; }
      if (stale) { void stale.close(); revision++; }
      live = opened; liveFile = candidate.file;
      subagents = new Map(); subagentsRevision++;
      live.start(change => { if (change.contentChanged) revision++; draw(); });
    } finally { opening = false; }
  };

  await follow();
  draw();
  // The state files and the running clock change without a transcript write.
  const refresh = async () => {
    states = await readSessionStates(stateDir, undefined, cache).catch(() => states);
    if (agent && !alive(agent)) finish();
    await follow();
    // Subagents write their own records: read again only what changed.
    if (live?.session.provider === 'claude' && liveFile) {
      const read = await readClaudeSubagents(live.session, liveFile, subagentCache).catch(() => undefined);
      if (read && (read.changed || read.byCall.size !== subagents.size)) {
        subagents = new Map([...read.byCall].map(([id, found]) => [id, found.session])); subagentsRevision++;
      }
    }
    draw();
  };
  setInterval(() => { void refresh(); }, STATE_POLL_MS);
  // The agent's words arrive in the state files a piece at a time: show each piece as it lands, not on the next second.
  let soon: NodeJS.Timeout | undefined;
  try {
    watchFiles(stateDir, { persistent: false }, () => {
      if (soon) return;
      soon = setTimeout(() => { soon = undefined; void refresh(); }, 30);
    }).on('error', () => undefined);
  } catch { /* No watching here: the second's poll still comes. */ }
}
