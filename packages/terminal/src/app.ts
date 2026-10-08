import type { SessionData } from '../../core/src/model';
import type { TurnGroup } from '../../core/src/timeline';
import type { LiveExtras } from '../../core/src/live-extras';
import { symbol, type Capabilities } from './caps';
import type { InputEvent } from './input';
import { cutLine, row, spans, type Line, type Span } from './screen';
import { contentsEntries, contentsLines, contentsOffset } from './views/contents';
import { detailDoc, type DetailDoc } from './views/detail';
import { wrapSpans } from './views/prose';
import { textWidth } from './width';
import { headerLines, providerName, turnLayout, type CallTarget, type PageContext, type SessionStatus } from './views/turn-page';

/**
 * The watch pane's state and what each key does to it. No I/O here: the
 * controller feeds in the session as it grows, draws what `frame` returns and
 * carries out the effect a key asks for (open a file, copy text).
 */
export interface Model {
  session: SessionData;
  groups: TurnGroup[];
  status: SessionStatus;
  extras: LiveExtras;
  caps: Pick<Capabilities, 'symbols' | 'links'>;
  now: number;
  width: number;
  height: number;
  /** The split adapter told the pane how to focus the agent: `a` does it. */
  focusAgent?: boolean;
}

export type Effect = { kind: 'open'; path: string; line?: number } | { kind: 'copy'; text: string; what: string } | { kind: 'focus' };

export interface AppState {
  mode: 'turn' | 'contents' | 'help' | 'detail';
  /** The turn on screen. While following it is always the newest. */
  index: number;
  /** Following: the newest turn, its end kept on screen. */
  follow: boolean;
  /** First body line on screen. */
  scroll: number;
  /** Selected turn in 目录. */
  selected: number;
  /** Selected call on the turn page, by position: calls only ever append. */
  call?: number;
  /** The open detail: its first line on screen and which change of the file. */
  detail?: { scroll: number; edit?: number };
  /** A turn that started while an older one was on screen. */
  notice?: number;
  /** Turns known at the last update, to see a new one start. */
  seen: number;
  /** For the controller: what to do outside the screen. */
  effect?: Effect;
  /** A short line in the footer, e.g. after copying. */
  message?: { text: string; until: number };
  quit?: boolean;
}

export const initialState = (): AppState => ({ mode: 'turn', index: 0, follow: true, scroll: 0, selected: 0, seen: 0 });

const HEADER = 3;
const bodyHeight = (state: AppState, model: Model) => Math.max(1, model.height - HEADER - (state.notice !== undefined && state.mode === 'turn' ? 2 : 1));

const pageContext = (state: AppState, model: Model): PageContext => ({
  session: model.session, groups: model.groups, index: state.index, status: model.status,
  extras: model.extras, caps: model.caps, width: model.width, now: model.now,
});

export const layout = (state: AppState, model: Model) => turnLayout(pageContext(state, model));
export const body = (state: AppState, model: Model): Line[] => layout(state, model).lines;
const bottom = (state: AppState, model: Model) => Math.max(0, body(state, model).length - bodyHeight(state, model));

/** The open call's detail, laid out for the pane. */
export function openDetail(state: AppState, model: Model): DetailDoc | undefined {
  const target = state.call !== undefined ? layout(state, model).targets[state.call] : undefined;
  const group = model.groups[state.index];
  if (!target || !group) return undefined;
  return detailDoc({ session: model.session, group, row: target.row, width: model.width, glyph: ch => symbol(model.caps, ch), edit: state.detail?.edit });
}

/** Applies a new snapshot: follows the newest turn, or notes that one started. */
export function update(state: AppState, model: Model): AppState {
  const total = model.groups.length;
  const last = Math.max(0, total - 1);
  const next: AppState = { ...state, seen: total };
  if (next.message && next.message.until <= model.now) delete next.message;
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

/** Moves within the turn; reaching the end of the newest turn follows again, unless a call is selected. */
function scrollTo(state: AppState, model: Model, scroll: number): AppState {
  const end = bottom(state, model);
  const target = Math.max(0, Math.min(end, scroll));
  const latest = state.index === model.groups.length - 1;
  return { ...state, scroll: target, follow: state.call === undefined && latest && target >= end && scroll >= end };
}

function showTurn(state: AppState, model: Model, index: number): AppState {
  const last = model.groups.length - 1;
  const target = Math.max(0, Math.min(last, index));
  const next: AppState = { ...state, mode: 'turn', index: target, scroll: 0, follow: false };
  delete next.call; delete next.detail;
  if (target === last) { delete next.notice; return update({ ...next, follow: true }, model); }
  return next;
}

/** Selects a call and keeps its line on screen. Selecting stops following: the reader is reading. */
function selectCall(state: AppState, model: Model, call: number, targets: CallTarget[]): AppState {
  const index = Math.max(0, Math.min(targets.length - 1, call));
  const line = targets[index].line, height = bodyHeight(state, model);
  const scroll = line < state.scroll ? line : line >= state.scroll + height ? line - height + 1 : state.scroll;
  return { ...state, call: index, follow: false, scroll };
}

/** The first or last call on screen, to start a selection from where the reader looks. */
function visibleCall(state: AppState, model: Model, targets: CallTarget[], last: boolean): number {
  const height = bodyHeight(state, model);
  const on = targets.map((target, index) => ({ ...target, index })).filter(target => target.line >= state.scroll && target.line < state.scroll + height);
  if (on.length) return (last ? on[on.length - 1] : on[0]).index;
  return last ? targets.length - 1 : 0;
}

function detailKey(state: AppState, name: string, model: Model): AppState {
  const doc = openDetail(state, model);
  const detail = state.detail ?? { scroll: 0 };
  const height = Math.max(1, model.height - HEADER - 1);
  const end = Math.max(0, (doc?.lines.length ?? 0) - height);
  const scroll = (to: number) => ({ ...state, detail: { ...detail, scroll: Math.max(0, Math.min(end, to)) } });
  const targets = layout(state, model).targets;
  const move = (delta: number) => {
    const call = (state.call ?? 0) + delta;
    if (call < 0 || call >= targets.length) return state;
    return { ...selectCall(state, model, call, targets), mode: 'detail' as const, detail: { scroll: 0 } };
  };
  const edit = (delta: number) => {
    if (!doc?.edits) return state;
    const next = Math.max(0, Math.min(doc.edits.total - 1, doc.edits.index + delta));
    return { ...state, detail: { scroll: 0, edit: next } };
  };
  switch (name) {
    case 'q': return { ...state, quit: true };
    case 'escape': { const next: AppState = { ...state, mode: 'turn' }; delete next.detail; return next; }
    case 'up': case 'k': return scroll(detail.scroll - 1);
    case 'down': case 'j': return scroll(detail.scroll + 1);
    case 'space': case 'pagedown': return scroll(detail.scroll + height - 1);
    case 'b': case 'pageup': return scroll(detail.scroll - height + 1);
    case 'halfdown': return scroll(detail.scroll + Math.ceil(height / 2));
    case 'halfup': return scroll(detail.scroll - Math.ceil(height / 2));
    case 'g': case 'home': return scroll(0);
    case 'G': case 'end': return scroll(end);
    case ']': return move(1);
    case '[': return move(-1);
    case '<': return edit(-1);
    case '>': return edit(1);
    case 'o': return doc?.path ? { ...state, effect: { kind: 'open', path: doc.path, ...(doc.line ? { line: doc.line } : {}) } } : state;
    case 'y': return doc ? { ...state, effect: { kind: 'copy', text: doc.copy.text, what: doc.copy.what } } : state;
    case '?': return { ...state, mode: 'help' };
    default: return state;
  }
}

export function key(state: AppState, event: InputEvent, model: Model): AppState {
  const page = bodyHeight(state, model);
  if (event.type === 'mouse') {
    if (state.mode === 'help') return state;
    if (event.action === 'wheelUp' || event.action === 'wheelDown') {
      const delta = event.action === 'wheelUp' ? -3 : 3;
      if (state.mode === 'contents') return { ...state, selected: Math.max(0, Math.min(model.groups.length - 1, state.selected - Math.sign(delta))) };
      if (state.mode === 'detail') {
        let next = state;
        for (let step = 0; step < 3; step++) next = detailKey(next, delta < 0 ? 'up' : 'down', model);
        return next;
      }
      return scrollTo({ ...state, ...(delta < 0 ? { follow: false } : {}) }, model, state.scroll + delta);
    }
    if (event.action !== 'press') return state;
    if (state.mode === 'detail') return event.y === 1 && event.x <= 8 ? detailKey(state, 'escape', model) : state;
    if (state.mode === 'turn' && event.y === 2) return { ...state, mode: 'contents', selected: state.index };
    if (state.mode === 'turn' && event.y > HEADER) {
      // A click selects a call; a click on the selected call opens it.
      const targets = layout(state, model).targets;
      const at = targets.findIndex(target => target.line === event.y - HEADER - 1 + state.scroll);
      if (at < 0) return state;
      return at === state.call ? { ...state, mode: 'detail', detail: { scroll: 0 } } : selectCall(state, model, at, targets);
    }
    if (state.mode === 'contents' && event.y > HEADER) {
      const entries = contentsEntries(model.groups, model.session.provider, model.status, model.caps, model.now);
      const at = Math.floor((event.y - HEADER - 1 + contentsScroll(state, model)) / 3);
      const entry = entries[at];
      if (entry) return entry.index === state.selected ? showTurn(state, model, entry.index) : { ...state, selected: entry.index };
    }
    return state;
  }
  const { ctrl } = event;
  if (ctrl && event.name === 'c') return { ...state, quit: true };
  // Ctrl-d and Ctrl-u move half a page, as in vim and less; other Ctrl keys mean nothing here.
  const name = ctrl ? (event.name === 'd' ? 'halfdown' : event.name === 'u' ? 'halfup' : '') : event.name;
  if (name === 'q') return { ...state, quit: true };
  if (name === 'a' && model.focusAgent) return { ...state, effect: { kind: 'focus' } };
  if (state.mode === 'help') return name === '?' || name === 'escape' ? { ...state, mode: state.detail ? 'detail' : 'turn' } : state;
  if (state.mode === 'detail') return detailKey(state, name, model);
  if (state.mode === 'contents') {
    const last = model.groups.length - 1;
    if (name === 'up' || name === 'k') return { ...state, selected: Math.min(last, state.selected + 1) };
    if (name === 'down' || name === 'j') return { ...state, selected: Math.max(0, state.selected - 1) };
    if (name === 'enter') return showTurn(state, model, state.selected);
    if (name === 'g' || name === 'home') return { ...state, selected: last };
    if (name === 'G' || name === 'end') return { ...state, selected: 0 };
    if (name === 't' || name === 'escape') return { ...state, mode: 'turn' };
    return state;
  }
  const targets = () => layout(state, model).targets;
  switch (name) {
    case 'q': return { ...state, quit: true };
    case '?': return { ...state, mode: 'help' };
    case 't': return { ...state, mode: 'contents', selected: state.index };
    case 'up': case 'k': case 'down': case 'j': {
      const list = targets();
      const down = name === 'down' || name === 'j';
      // A turn without calls just scrolls.
      if (!list.length) return scrollTo(down ? state : { ...state, follow: false }, model, state.scroll + (down ? 1 : -1));
      const call = state.call === undefined ? visibleCall(state, model, list, !down) : state.call + (down ? 1 : -1);
      return selectCall(state, model, call, list);
    }
    case 'enter': return state.call !== undefined ? { ...state, mode: 'detail', detail: { scroll: 0 } } : state;
    case 'escape': { const next = { ...state }; delete next.call; return next; }
    case 'space': case 'pagedown': return scrollTo(state, model, state.scroll + page - 1);
    case 'halfdown': return scrollTo(state, model, state.scroll + Math.ceil(page / 2));
    case 'halfup': return scrollTo({ ...state, follow: false }, model, state.scroll - Math.ceil(page / 2));
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
  ['j k  ↓ ↑', '移动：选择调用（选中后暂停跟随）；详情里滚动'],
  ['⏎', '进入：打开详情；目录里打开这一轮'],
  ['Esc', '返回上一层；轮页上是取消选择'],
  ['[  ]', '同一层的上一个 / 下一个：轮页是轮，详情是调用'],
  ['<  >', '详情里：同一文件的上一次 / 下一次修改'],
  ['g  G', '开头 / 末尾（轮页的 G 回到最新一轮并恢复跟随）'],
  ['␣ b  ^d ^u', '整页 / 半页'],
  ['t  o  y', '目录 / 在编辑器打开 / 复制'],
  ['a', '切回 Agent'],
  ['q', '退出'],
];

/** A selected call: its tool name no longer dim, its label bold, its arrow yellow. One marker, at the end. */
function marked(line: Line, caps: Pick<Capabilities, 'symbols'>): Line {
  const arrow = symbol(caps, '→');
  return spans(line).map((span, index) => index === 1 ? { ...span, style: { ...span.style, dim: false } }
    : index === 3 ? { ...span, style: { ...span.style, bold: true } }
    : span.text.trim() === arrow ? { ...span, style: { fg: 'yellow' as const, bold: true } } : span);
}

function detailFrame(state: AppState, model: Model): Line[] {
  const { width, height } = model;
  const doc = openDetail(state, model);
  const lines: Line[] = [];
  if (!doc) {
    lines.push(row([dim(' ← Esc')], '', width), [], [dim('   这个调用没有可显示的记录。')]);
  } else {
    lines.push(row([dim(' ← Esc  '), { text: doc.title, style: { bold: true } }], [dim(doc.meta + ' ')], width));
    const link = doc.path && model.caps.links ? `file://${doc.path}` : undefined;
    lines.push(doc.directory !== undefined ? cutLine([dim(' ' + doc.directory), { text: doc.title, style: { underline: Boolean(link), ...(link ? { link } : {}) } }], width) : []);
    lines.push([]);
    const scroll = Math.min(state.detail?.scroll ?? 0, Math.max(0, doc.lines.length - (height - HEADER - 1)));
    lines.push(...doc.lines.slice(scroll, scroll + height - HEADER - 1));
  }
  while (lines.length < height - 1) lines.push([]);
  // Most useful first; what does not fit the pane is left out, never cut in half.
  const keys = fitKeys([doc?.edits ? '< > 切换修改' : '', doc?.path ? 'o 在编辑器打开' : '', doc ? `y 复制${doc.copy.what}` : '', '[ ] 上/下一个调用'], width - 2);
  lines.push(footer(state, model, keys));
  return withMessage(lines.slice(0, height), state, model);
}

/** Key hints joined three spaces apart, dropping the last ones until they fit. */
export function fitKeys(hints: string[], room: number): string {
  const shown = hints.filter(Boolean);
  while (shown.length > 1 && textWidth(shown.join('   ')) > room) shown.pop();
  return shown.join('   ');
}

function footer(_state: AppState, model: Model, keys: string): Line {
  return row('', [dim(keys + ' ')], model.width);
}

/**
 * A message covers the bottom lines, wrapped: text that could not be copied is
 * shown whole there, to copy by hand.
 */
function withMessage(lines: Line[], state: AppState, model: Model): Line[] {
  if (!state.message || state.message.until <= model.now) return lines;
  const shown = wrapSpans([{ text: state.message.text }], model.width - 2).slice(0, 6).map(line => [{ text: ' ' }, ...line.map(span => ({ ...span, style: { fg: 'green' as const } }))]);
  return [...lines.slice(0, lines.length - shown.length - 1), [dim('─'.repeat(model.width))], ...shown];
}

/** Everything on screen, row by row. */
export function frame(state: AppState, model: Model): Line[] {
  const { width, height } = model;
  const ctx = pageContext(state, model);
  const lines: Line[] = [];
  if (state.mode === 'detail') return detailFrame(state, model);
  if (state.mode === 'contents') {
    const entries = contentsEntries(model.groups, model.session.provider, model.status, model.caps, model.now);
    lines.push(row([{ text: ' ' }, { text: '目录', style: { bold: true } }], [dim(`共 ${model.groups.length} 轮 `)], width), [], []);
    const list = contentsLines(entries, state.selected, width, model.caps);
    const top = contentsScroll(state, model);
    lines.push(...list.slice(top, top + height - HEADER - 1));
    while (lines.length < height - 1) lines.push([]);
    lines.push(row('', [dim('↑↓ 选择   ⏎ 打开   Esc 返回 ')], width));
    return lines;
  }
  lines.push(...headerLines(ctx), []);
  if (state.mode === 'help') {
    lines.push([{ text: ' ' }, { text: '按键', style: { bold: true } }], []);
    for (const [keys, what] of HELP.filter(([keys]) => keys !== 'a' || model.focusAgent)) lines.push(cutLine([{ text: '   ' + keys.padEnd(12) }, dim(what)], width));
    lines.push([], cutLine([dim('   只读：按键只用来阅读和跳转，不会向 Agent 输入任何东西。')], width));
    while (lines.length < height - 1) lines.push([]);
    lines.push(row('', [dim('Esc 返回 ')], width));
    return lines;
  }
  const { lines: page, targets } = layout(state, model);
  const selectedLine = state.call !== undefined ? targets[state.call]?.line : undefined;
  const visible = page.slice(state.scroll, state.scroll + bodyHeight(state, model))
    .map((line, index) => index + state.scroll === selectedLine ? marked(line, model.caps) : line);
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
    const left = ' 已暂停跟随 · G 恢复';
    const keys = fitKeys(['t 目录', targets.length ? (state.call !== undefined ? '⏎ 详情' : '↑↓ 选择') : '', '? 帮助', model.focusAgent ? 'a 切回 Agent' : ''],
      width - 2 - (paused ? textWidth(left) + 2 : 0));
    lines.push(row(paused ? [dim(left)] : '', [dim(keys + ' ')], width));
  }
  return withMessage(lines.slice(0, height), state, model);
}

/** The tab title: who, and whether the agent waits for you. */
export function windowTitle(model: Model): string {
  const who = providerName(model.session.provider);
  if (model.status.kind === 'waiting') return `⏸ 等你批准 — Sidecar · ${who}`;
  return `Sidecar — ${who}${model.session.title ? ' · ' + model.session.title : ''}`;
}
