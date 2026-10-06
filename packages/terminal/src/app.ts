import type { SessionData } from '../../core/src/model';
import type { TurnGroup } from '../../core/src/timeline';
import type { LiveExtras } from '../../core/src/live-extras';
import type { Capabilities } from './caps';
import type { InputEvent } from './input';
import { cutLine, row, type Line, type Span } from './screen';
import { contentsEntries, contentsLines, contentsOffset } from './views/contents';
import { headerLines, providerName, turnBody, type PageContext, type SessionStatus } from './views/turn-page';

/**
 * The watch pane's state and what each key does to it. No I/O here: the
 * controller feeds in the session as it grows and draws what `frame` returns.
 */
export interface Model {
  session: SessionData;
  groups: TurnGroup[];
  status: SessionStatus;
  extras: LiveExtras;
  caps: Pick<Capabilities, 'symbols'>;
  now: number;
  width: number;
  height: number;
}

export interface AppState {
  mode: 'turn' | 'contents' | 'help';
  /** The turn on screen. While following it is always the newest. */
  index: number;
  /** Following: the newest turn, its end kept on screen. */
  follow: boolean;
  /** First body line on screen. */
  scroll: number;
  /** Selected turn in 目录. */
  selected: number;
  /** A turn that started while an older one was on screen. */
  notice?: number;
  /** Turns known at the last update, to see a new one start. */
  seen: number;
  quit?: boolean;
}

export const initialState = (): AppState => ({ mode: 'turn', index: 0, follow: true, scroll: 0, selected: 0, seen: 0 });

const HEADER = 3;
const bodyHeight = (state: AppState, model: Model) => Math.max(1, model.height - HEADER - (state.notice !== undefined ? 2 : 1));

const pageContext = (state: AppState, model: Model): PageContext => ({
  session: model.session, groups: model.groups, index: state.index, status: model.status,
  extras: model.extras, caps: model.caps, width: model.width, now: model.now,
});

export const body = (state: AppState, model: Model): Line[] => turnBody(pageContext(state, model));
const bottom = (state: AppState, model: Model) => Math.max(0, body(state, model).length - bodyHeight(state, model));

/** Applies a new snapshot: follows the newest turn, or notes that one started. */
export function update(state: AppState, model: Model): AppState {
  const total = model.groups.length;
  const last = Math.max(0, total - 1);
  let next: AppState = { ...state, seen: total };
  if (state.follow) {
    next.index = last;
    delete next.notice;
    next.scroll = bottom(next, model);
    return next;
  }
  next.index = Math.min(state.index, last);
  if (total > state.seen && state.seen > 0 && next.index < last) next.notice = last;
  if (next.index === last) delete next.notice;
  next.scroll = Math.min(next.scroll, bottom(next, model));
  return next;
}

/** Moves within the turn; reaching the end of the newest turn follows again. */
function scrollTo(state: AppState, model: Model, scroll: number): AppState {
  const end = bottom(state, model);
  const target = Math.max(0, Math.min(end, scroll));
  const latest = state.index === model.groups.length - 1;
  return { ...state, scroll: target, follow: latest && target >= end && scroll >= end };
}

function showTurn(state: AppState, model: Model, index: number): AppState {
  const last = model.groups.length - 1;
  const target = Math.max(0, Math.min(last, index));
  const next: AppState = { ...state, mode: 'turn', index: target, scroll: 0, follow: false };
  if (target === last) { delete next.notice; return update({ ...next, follow: true }, model); }
  return next;
}

export function key(state: AppState, event: InputEvent, model: Model): AppState {
  const page = bodyHeight(state, model);
  if (event.type === 'mouse') {
    if (state.mode === 'help') return state;
    if (event.action === 'wheelUp' || event.action === 'wheelDown') {
      const delta = event.action === 'wheelUp' ? -3 : 3;
      if (state.mode === 'contents') return { ...state, selected: Math.max(0, Math.min(model.groups.length - 1, state.selected - Math.sign(delta))) };
      return scrollTo(state, model, state.scroll + delta);
    }
    if (event.action !== 'press') return state;
    if (state.mode === 'turn' && event.y === 2) return { ...state, mode: 'contents', selected: state.index };
    if (state.mode === 'contents' && event.y > HEADER) {
      const entries = contentsEntries(model.groups, model.session.provider, model.status, model.caps, model.now);
      const at = Math.floor((event.y - HEADER - 1 + contentsScroll(state, model)) / 3);
      const entry = entries[at];
      if (entry) return entry.index === state.selected ? showTurn(state, model, entry.index) : { ...state, selected: entry.index };
    }
    return state;
  }
  const { name, ctrl } = event;
  if (ctrl && name === 'c') return { ...state, quit: true };
  if (state.mode === 'help') return name === 'q' || name === '?' || name === 'escape' ? { ...state, mode: 'turn' } : state;
  if (state.mode === 'contents') {
    const last = model.groups.length - 1;
    if (name === 'up' || name === 'k') return { ...state, selected: Math.min(last, state.selected + 1) };
    if (name === 'down' || name === 'j') return { ...state, selected: Math.max(0, state.selected - 1) };
    if (name === 'enter') return showTurn(state, model, state.selected);
    if (name === 'g' || name === 'home') return { ...state, selected: last };
    if (name === 'G' || name === 'end') return { ...state, selected: 0 };
    if (name === 'q' || name === 't' || name === 'escape') return { ...state, mode: 'turn' };
    return state;
  }
  switch (name) {
    case 'q': return { ...state, quit: true };
    case '?': return { ...state, mode: 'help' };
    case 't': return { ...state, mode: 'contents', selected: state.index };
    case 'up': case 'k': return scrollTo({ ...state, follow: false }, model, state.scroll - 1);
    case 'down': case 'j': return scrollTo(state, model, state.scroll + 1);
    case 'space': case 'pagedown': return scrollTo(state, model, state.scroll + page - 1);
    case 'b': case 'pageup': return scrollTo({ ...state, follow: false }, model, state.scroll - page + 1);
    case 'g': case 'home': return scrollTo({ ...state, follow: false }, model, 0);
    case 'G': case 'end': return showTurn(state, model, model.groups.length - 1);
    case '[': return showTurn(state, model, state.index - 1);
    case ']': return showTurn(state, model, state.notice ?? state.index + 1);
    default: return state;
  }
}

function contentsScroll(state: AppState, model: Model): number {
  const entries = contentsEntries(model.groups, model.session.provider, model.status, model.caps, model.now);
  const height = model.height - HEADER - 1;
  const at = contentsOffset(entries, state.selected);
  // Keep the selected entry's two lines on screen, scrolled in whole entries.
  return Math.max(0, Math.ceil((at + 2 - height) / 3) * 3);
}

const dim = (text: string): Span => ({ text, style: { dim: true } });

const HELP: Array<[string, string]> = [
  ['↑ ↓  j k', '上下滚动（向上会暂停跟随）'],
  ['␣  b', '下一页 / 上一页'],
  ['g  G', '本轮开头 / 最新一轮的末尾，并恢复跟随'],
  ['[  ]', '上一轮 / 下一轮'],
  ['t', '目录'],
  ['q', '返回或退出'],
];

/** Everything on screen, row by row. */
export function frame(state: AppState, model: Model): Line[] {
  const { width, height } = model;
  const ctx = pageContext(state, model);
  const lines: Line[] = [];
  if (state.mode === 'contents') {
    const entries = contentsEntries(model.groups, model.session.provider, model.status, model.caps, model.now);
    lines.push(row([{ text: ' ' }, { text: '目录', style: { bold: true } }], [dim(`共 ${model.groups.length} 轮 `)], width), [], []);
    const list = contentsLines(entries, state.selected, width, model.caps);
    const top = contentsScroll(state, model);
    lines.push(...list.slice(top, top + height - HEADER - 1));
    while (lines.length < height - 1) lines.push([]);
    lines.push(row('', [dim('↑↓ 选择   ⏎ 打开   q 返回 ')], width));
    return lines;
  }
  lines.push(...headerLines(ctx), []);
  if (state.mode === 'help') {
    lines.push([{ text: ' ' }, { text: '按键', style: { bold: true } }], []);
    for (const [keys, what] of HELP) lines.push(cutLine([{ text: '   ' + keys.padEnd(12) }, dim(what)], width));
    lines.push([], cutLine([dim('   只读：按键只用来阅读和跳转，不会向 Agent 输入任何东西。')], width));
    while (lines.length < height - 1) lines.push([]);
    lines.push(row('', [dim('q 返回 ')], width));
    return lines;
  }
  const visible = body(state, model).slice(state.scroll, state.scroll + bodyHeight(state, model));
  lines.push(...visible);
  while (lines.length < HEADER + bodyHeight(state, model)) lines.push([]);
  if (state.notice !== undefined) {
    const group = model.groups[state.notice];
    const request = (group?.request ?? '').replace(/\s+/g, ' ');
    lines.push([dim('─'.repeat(width))]);
    lines.push(row([{ text: ' ' }, { text: '●', style: { fg: 'yellow' } }, { text: ` 第 ${group?.ordinal ?? state.notice + 1} 轮开始了${request ? '：' + request : ''}` }],
      [{ text: ']', style: { bold: true } }, dim(' 跳到最新 ')], width));
  } else {
    const paused = !state.follow && state.index === model.groups.length - 1;
    lines.push(row(paused ? [dim(' 已暂停跟随 · G 恢复')] : '', [dim('t 目录   ? 帮助 ')], width));
  }
  return lines.slice(0, height);
}

/** The tab title: who, and whether the agent waits for you. */
export function windowTitle(model: Model): string {
  const who = providerName(model.session.provider);
  if (model.status.kind === 'waiting') return `⏸ 等你批准 — Sidecar · ${who}`;
  return `Sidecar — ${who}${model.session.title ? ' · ' + model.session.title : ''}`;
}
