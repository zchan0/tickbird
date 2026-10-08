import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionCandidate } from '../../core/src/model';
import { discoverSessions } from '../../core/src/sessions';
import { openLiveSession, type LiveSession } from '../../core/src/live-session';
import { readSessionStates, sessionStateDirectory, type SessionState, type SessionStateCache } from '../../core/src/session-state';
import { liveExtras } from '../../core/src/live-extras';
import { visibleTurnGroups } from '../../core/src/outline';
import { turnView } from '../../core/src/turn-view';
import type { Capabilities } from './caps';
import { describe, InputParser } from './input';
import { enterBytes, leaveBytes, row, Screen, type Line } from './screen';
import { frame, initialState, key, update, windowTitle, type AppState, type Effect, type Model } from './app';
import { clipboardBytes, openFile } from './effects';
import { sessionStatus } from './views/turn-page';
import { prose } from './views/prose';

const ESCAPE_GAP_MS = 30;
const STATE_POLL_MS = 1000;

/**
 * Which session to show: the one named (by id or transcript path), or the
 * newest one of this directory. A session named by id is also looked up in the
 * integration's state files, which know its directory.
 */
export async function resolveSession(target: string | undefined, cwd: string, states: SessionState[]): Promise<SessionCandidate | undefined> {
  if (!target) return (await discoverSessions({ projectPath: cwd })).candidates[0];
  const file = existsSync(target) ? resolve(target) : undefined;
  const state = states.find(item => item.session === target || (file && item.transcript === file));
  for (const projectPath of [cwd, state?.cwd].filter((path): path is string => Boolean(path))) {
    const found = (await discoverSessions({ projectPath })).candidates.find(candidate => candidate.id === target || candidate.file === file);
    if (found) return found;
  }
  return undefined;
}

const SET_TITLE = (title: string) => `\x1b]2;${title.replace(/[\x00-\x1f\x7f]/g, ' ')}\x1b\\`;
// xterm's title stack: keep the tab's own title and give it back on exit.
const PUSH_TITLE = '\x1b[22;2t', POP_TITLE = '\x1b[23;2t';

/** Runs the pane until q or Ctrl+C. The terminal must already be probed. */
export async function watch(target: string | undefined, caps: Capabilities): Promise<void> {
  const out = process.stdout, input = process.stdin;
  const screen = new Screen(out, caps, out.columns, out.rows);
  const cache: SessionStateCache = new Map();
  const stateDir = sessionStateDirectory();
  let states = await readSessionStates(stateDir, undefined, cache);
  let live: LiveSession | undefined;
  let app: AppState = initialState();
  let title = '';
  let timer: NodeJS.Timeout | undefined;
  const parser = new InputParser();

  const stateOf = () => live && states.find(item => item.provider === live!.session.provider && item.session === live!.session.id);
  const model = (): Model | undefined => {
    if (!live) return undefined;
    const session = live.session, state = stateOf();
    const groups = visibleTurnGroups(session);
    const extras = liveExtras(session, state);
    const latest = groups.length ? turnView(groups[groups.length - 1], true, session.provider) : undefined;
    const status = sessionStatus(latest, extras, Date.now(), { busy: live.health.agent === 'busy' || state?.phase === 'working', ended: state?.phase === 'ended' });
    return { session, groups, status, extras, caps, now: Date.now(), width: screen.width, height: screen.height };
  };
  const waitingLines = (message: string): Line[] => [row([{ text: ' Sidecar', style: { bold: true } }], '', screen.width), [], ...prose(message, screen.width - 1, { indent: 3, style: { dim: true } })];
  const draw = () => {
    const current = model();
    if (!current) { screen.render(waitingLines(target ? `找不到会话 ${target}` : '当前目录还没有 Agent 会话，开始一个会话后这里会自动显示。')); return; }
    app = update(app, current);
    screen.render(frame(app, current));
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
  const perform = (effect: Effect) => {
    if (effect.kind === 'copy') {
      // OSC 52 only where the terminal says it takes it; otherwise the text is shown to copy by hand.
      if (caps.clipboard) { out.write(clipboardBytes(effect.text)); say(`已复制${effect.what}`); }
      else say(`这个终端不能直接复制，请手动复制：${effect.text}`, 15000);
      return;
    }
    say(openFile(effect.path, effect.line, {
      suspend: () => { out.write(leaveBytes(caps.kittyKeyboard)); input.setRawMode(false); },
      resume: () => { input.setRawMode(true); out.write(enterBytes(caps.kittyKeyboard)); screen.resize(out.columns, out.rows); },
    }), 4000);
  };
  const handle = (events: ReturnType<InputParser['feed']>) => {
    const current = model();
    // SIDECAR_DEBUG_KEYS=<file>: every parsed key and the raw input, for tracking down terminal quirks.
    if (process.env.SIDECAR_DEBUG_KEYS) appendFileSync(process.env.SIDECAR_DEBUG_KEYS, events.map(event => describe(event)).join(' ') + '\n');
    for (const event of events) {
      if (!current) { if (event.type === 'key' && (event.name === 'q' || (event.ctrl && event.name === 'c'))) finish(); continue; }
      app = key(app, event, current);
      if (app.quit) finish();
      if (app.effect) { const effect = app.effect; delete app.effect; perform(effect); }
    }
    draw();
  };

  out.write(PUSH_TITLE + enterBytes(caps.kittyKeyboard));
  input.setRawMode(true);
  input.resume();
  input.on('data', chunk => {
    if (timer) clearTimeout(timer);
    if (process.env.SIDECAR_DEBUG_KEYS) appendFileSync(process.env.SIDECAR_DEBUG_KEYS, 'raw ' + JSON.stringify(chunk.toString('utf8')) + '\n');
    handle(parser.feed(chunk.toString('utf8')));
    if (parser.pending) timer = setTimeout(() => handle(parser.flush()), ESCAPE_GAP_MS);
  });
  out.on('resize', () => { screen.resize(out.columns, out.rows); draw(); });
  process.on('SIGTERM', finish);
  process.on('SIGHUP', finish);
  draw();

  // Find the session; without one, look again until it appears.
  while (!live) {
    const candidate = await resolveSession(target, process.cwd(), states).catch(() => undefined);
    if (candidate) {
      live = await openLiveSession(candidate);
      live.start(() => draw());
    } else {
      await new Promise(done => setTimeout(done, 2000));
      states = await readSessionStates(stateDir, undefined, cache);
    }
  }
  draw();
  // The state files and the running clock change without a transcript write.
  setInterval(async () => {
    states = await readSessionStates(stateDir, undefined, cache).catch(() => states);
    draw();
  }, STATE_POLL_MS);
}
