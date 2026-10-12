import type { SessionData } from '../../core/src/model';
import type { TurnGroup } from '../../core/src/timeline';
import type { LiveExtras } from '../../core/src/live-extras';
import { symbol, type Capabilities } from './caps';
import type { InputEvent } from './input';
import { cutLine, row, spans, type Line, type Span } from './screen';
import { contentsEntries, contentsLines, contentsOffset, ENTRY_LINES } from './views/contents';
import { callLink, detailDoc, recordedImage, type DetailDoc, type RecordedImage } from './views/detail';
import { wrapSpans } from './views/prose';
import { textWidth } from './width';
import type { Motion } from './motion';
import { MARGIN, label, headerLines, markSelected, viewOf, providerName, turnLayout, type CallTarget, type PageContext, type SessionStatus } from './views/turn-page';

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
  caps: Pick<Capabilities, 'symbols' | 'links' | 'background'>;
  now: number;
  width: number;
  height: number;
  /** The split adapter told the pane how to focus the agent: `a` does it. */
  focusAgent?: boolean;
  /** What is new on the page, and a count that moves on with each frame while something moves. */
  motion?: Motion;
  frame?: number;
}

export type Effect = { kind: 'open'; path: string; line?: number } | { kind: 'copy'; text: string; what: string } | { kind: 'focus' } | { kind: 'view'; image: RecordedImage } | { kind: 'link'; link: { target: string; name: string } };

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
  /** The open detail: its first line on screen, which change of the file, and whether a click opened it. */
  detail?: { scroll: number; edit?: number; clicked?: boolean };
  /** A turn that started while an older one was on screen. */
  notice?: number;
  /** Turns known at the last update, to see a new one start. */
  seen: number;
  /** The closing answer of the turn on screen is opened in full. */
  answerOpen?: boolean;
  /** The turn's changes on screen are listed a file a line. */
  changesOpen?: boolean;
  /** The newest turn was still open at the last update, to see it end. */
  wasLive?: boolean;
  /** The screen cell under the mouse pointer, to bring up the call there. */
  pointer?: { x: number; y: number };
  /**
   * Where the pointer was when the page last scrolled. Scrolling moves the
   * page under a pointer that stays put, so the call under it would light up
   * one after another; the pointer counts again only once it moves away.
   */
  scrolledAt?: { x: number; y: number };
  /** For the controller: what to do outside the screen. */
  effect?: Effect;
  /** A short line in the footer, e.g. after copying. */
  message?: { text: string; until: number };
  quit?: boolean;
}

export const initialState = (): AppState => ({ mode: 'turn', index: 0, follow: true, scroll: 0, selected: 0, seen: 0 });

/**
 * The turn page and 目录: one header line and a blank. A detail has its
 * file's directory too. No footer: the keys are on the help page, and the
 * header says what a key does now. Only a turn that started while an older
 * one is on screen takes the bottom line.
 */
const HEADER = 2;
const DETAIL_HEADER = 3;
const bodyHeight = (state: AppState, model: Model) => Math.max(1, model.height - HEADER - (state.notice !== undefined && state.mode === 'turn' ? 1 : 0));

const pageContext = (state: AppState, model: Model): PageContext => ({
  session: model.session, groups: model.groups, index: state.index, status: model.status,
  extras: model.extras, caps: model.caps, width: model.width, now: model.now, ...(state.answerOpen ? { answerOpen: true } : {}), ...(state.changesOpen ? { changesOpen: true } : {}), ...(model.motion ? { motion: model.motion } : {}),
});

/**
 * Laying out a long turn takes tens of milliseconds, and every key, wheel step
 * and pointer move asks for it several times. The controller hands in the same
 * `groups` until the transcript changes, so the page is kept per groups and
 * per everything else the page is drawn from.
 */
const LAYOUTS = new WeakMap<TurnGroup[], { key: string; value: ReturnType<typeof turnLayout> }>();
export function layout(state: AppState, model: Model): ReturnType<typeof turnLayout> {
  const key = JSON.stringify([state.index, model.width, Boolean(state.answerOpen), Boolean(state.changesOpen), model.frame ?? 0, model.status, model.extras, model.caps.background ?? null, model.caps.symbols]);
  const kept = LAYOUTS.get(model.groups);
  if (kept?.key === key) return kept.value;
  const value = turnLayout(pageContext(state, model));
  LAYOUTS.set(model.groups, { key, value });
  return value;
}

const ENTRIES = new WeakMap<TurnGroup[], { key: string; value: ReturnType<typeof contentsEntries> }>();
/** 目录's entries, kept the same way. */
function entriesOf(model: Model): ReturnType<typeof contentsEntries> {
  const key = JSON.stringify([model.status]);
  const kept = ENTRIES.get(model.groups);
  if (kept?.key === key) return kept.value;
  const value = contentsEntries(model.groups, model.session.provider, model.status, model.caps, model.now);
  ENTRIES.set(model.groups, { key, value });
  return value;
}
export const body = (state: AppState, model: Model): Line[] => layout(state, model).lines;
const bottom = (state: AppState, model: Model) => Math.max(0, body(state, model).length - bodyHeight(state, model));

/**
 * What some calls open instead of a detail: an image it read, in the
 * system's viewer; a call that points somewhere, at that place. A page of a
 * path or an address would say nothing.
 */
const openHint = (model: Model, target: CallTarget): string => {
  const effect = openTarget(model, target);
  return effect?.kind === 'view' ? '⏎ 打开图片' : effect?.kind === 'link' ? (/^https?:/.test(effect.link.target) ? '⏎ 打开链接' : '⏎ 打开文件') : '⏎ 详情';
};

function openTarget(model: Model, target: CallTarget | undefined): Effect | undefined {
  if (!target?.row) return undefined;
  const image = recordedImage(model.session, target.row);
  if (image) return { kind: 'view', image };
  const link = callLink(model.session, target.row);
  return link ? { kind: 'link', link } : undefined;
}

const DETAILS = new WeakMap<TurnGroup[], { key: string; value: DetailDoc | undefined }>();
/**
 * The open call's detail, laid out for the pane. Kept like the page: every
 * wheel step asks for it to know where the end is, and scrolling only changes
 * which of its lines are on screen.
 */
export function openDetail(state: AppState, model: Model): DetailDoc | undefined {
  const target = state.call !== undefined ? layout(state, model).targets[state.call] : undefined;
  const group = model.groups[state.index];
  if (!target?.row || !group) return undefined;
  const key = JSON.stringify([state.index, target.row.id, state.detail?.edit ?? null, model.width, model.caps.background ?? null, model.caps.symbols]);
  const kept = DETAILS.get(model.groups);
  if (kept?.key === key) return kept.value;
  const value = detailDoc({ session: model.session, group, row: target.row, width: model.width, glyph: ch => symbol(model.caps, ch), edit: state.detail?.edit, background: model.caps.background });
  DETAILS.set(model.groups, { key, value });
  return value;
}

const latestLive = (model: Model): boolean => {
  const group = model.groups.at(-1);
  return Boolean(group && viewOf(group, true, model.session.provider).live) && model.status.kind !== 'idle' && model.status.kind !== 'ended';
};

/**
 * Applies a new snapshot: follows the newest turn, or notes that one started.
 * Following an open turn keeps its end on screen, and it stays there when the
 * turn ends: its answer is what comes last. A turn that arrives finished
 * starts at its start, where the steps begin.
 */
export function update(state: AppState, model: Model): AppState {
  const total = model.groups.length;
  const last = Math.max(0, total - 1);
  const live = latestLive(model);
  const next: AppState = { ...state, seen: total, wasLive: live };
  if (next.message && next.message.until <= model.now) delete next.message;
  if (state.follow) {
    if (next.index !== last) { delete next.answerOpen; delete next.changesOpen; delete next.call; }
    const arrived = next.index !== last || state.seen === 0;
    next.index = last;
    delete next.notice;
    const end = bottom(next, model);
    next.scroll = live || (state.wasLive && !arrived) ? end : arrived ? 0 : Math.min(state.scroll, end);
    return settle(next, state);
  }
  // A new turn while the reader is on the newest one, scrolled back in it: they sent it, so it is
  // what they want to see next. Only someone reading an older turn is left there, with a notice.
  if (total > state.seen && state.seen > 0 && state.index === state.seen - 1) return update({ ...state, follow: true }, model);
  next.index = Math.min(state.index, last);
  if (total > state.seen && state.seen > 0 && next.index < last) next.notice = last;
  if (next.index === last) delete next.notice;
  next.scroll = Math.min(next.scroll, bottom(next, model));
  return settle(next, state);
}

/**
 * The pointer has left, as far as the pane can tell: a terminal reports no
 * leaving, so the controller calls this when the pointer rests at the pane's
 * edge or has not moved for a while. Its call goes dark until it moves again.
 */
export function pointerGone(state: AppState): AppState {
  if (!state.pointer) return state;
  const { pointer, ...rest } = state;
  return { ...rest, scrolledAt: pointer };
}

/** How long the pointer may rest before its call goes dark: at the pane's edge it is on its way out. */
export function pointerRest(state: AppState, model: Pick<Model, 'width' | 'height'>): number | undefined {
  const at = state.pointer;
  if (!at) return undefined;
  const edge = at.x <= 1 || at.x >= model.width - 1 || at.y <= 1 || at.y >= model.height;
  return edge ? 150 : 3000;
}

/** When the page moved under a pointer that stayed put, the pointer's call goes dark until the pointer moves. */
function settle(next: AppState, before: AppState): AppState {
  if (next.scroll === before.scroll || next.index !== before.index || !next.pointer) return next;
  const { pointer, ...rest } = next;
  return { ...rest, scrolledAt: pointer };
}

/** Moves within the turn; reaching the end of the newest turn follows again, unless a call is selected. */
function scrollTo(state: AppState, model: Model, scroll: number): AppState {
  const end = bottom(state, model);
  const target = Math.max(0, Math.min(end, scroll));
  const latest = state.index === model.groups.length - 1;
  return settle({ ...state, scroll: target, follow: state.call === undefined && latest && target >= end && scroll >= end }, state);
}

function showTurn(state: AppState, model: Model, index: number): AppState {
  const last = model.groups.length - 1;
  const target = Math.max(0, Math.min(last, index));
  const next: AppState = { ...state, mode: 'turn', index: target, scroll: 0, follow: false };
  delete next.call; delete next.detail; delete next.answerOpen; delete next.changesOpen;
  if (target === last) { delete next.notice; return update({ ...next, follow: true }, model); }
  return next;
}

/**
 * Opens or folds the closing answer. Opened, its label goes to the top when
 * the answer does not fit below it on screen, so it reads without scrolling;
 * one that fits leaves the page still. Folded, the label stays where it was on
 * screen. Either way the reader is reading: following pauses until the end.
 */
function toggleAnswer(state: AppState, model: Model, target: CallTarget, scrollBefore: number): AppState {
  const next: AppState = { ...state, answerOpen: !state.answerOpen, follow: false };
  const end = bottom(next, model);
  const row = target.line - scrollBefore;
  if (!next.answerOpen) return settle({ ...next, scroll: Math.max(0, Math.min(end, target.line - row)) }, state);
  // The answer is the last thing on the page: it fits when the page's end is on screen.
  return settle({ ...next, scroll: end <= scrollBefore ? scrollBefore : Math.min(target.line, end) }, state);
}

/** Selects a call and keeps its lines on screen. Selecting stops following: the reader is reading. */
function selectCall(state: AppState, model: Model, call: number, targets: CallTarget[]): AppState {
  const index = Math.max(0, Math.min(targets.length - 1, call));
  const { line, height: tall } = targets[index], height = bodyHeight(state, model);
  const scroll = line < state.scroll ? line : line + tall > state.scroll + height ? Math.min(line, line + tall - height) : state.scroll;
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
  const height = Math.max(1, model.height - DETAIL_HEADER);
  const end = Math.max(0, (doc?.lines.length ?? 0) - height);
  const scroll = (to: number) => ({ ...state, detail: { ...detail, scroll: Math.max(0, Math.min(end, to)) } });
  const targets = layout(state, model).targets;
  const move = (delta: number) => {
    const call = (state.call ?? 0) + delta;
    if (call < 0 || call >= targets.length || !targets[call].row) return state;
    return { ...selectCall(state, model, call, targets), mode: 'detail' as const, detail: { scroll: 0 } };
  };
  const edit = (delta: number) => {
    if (!doc?.edits) return state;
    const next = Math.max(0, Math.min(doc.edits.total - 1, doc.edits.index + delta));
    return { ...state, detail: { scroll: 0, edit: next } };
  };
  switch (name) {
    case 'q': return { ...state, quit: true };
    // Back from a detail a click opened, nothing stays selected; from one opened with the keys, the call stays to move on from.
    case 'escape': { const next: AppState = { ...state, mode: 'turn' }; delete next.detail; if (state.detail?.clicked) delete next.call; return next; }
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

/**
 * The call or answer under a screen cell of the turn page. Reads share a
 * line: the one under the pointer, else the nearest on that line.
 */
function targetAt(state: AppState, model: Model, y: number, x: number, targets = layout(state, model).targets): number {
  const at = y - HEADER - 1 + state.scroll;
  if (y <= HEADER || y > HEADER + bodyHeight(state, model)) return -1;
  const cell = x - 1;
  const here = targets.map((target, index) => ({ target, index })).filter(({ target }) => at >= target.line && at < target.line + target.height);
  if (here.length < 2) return here[0]?.index ?? -1;
  const distance = ({ target }: { target: CallTarget }) => target.from === undefined || target.to === undefined ? 0
    : cell < target.from ? target.from - cell : cell >= target.to ? cell - target.to + 1 : 0;
  return here.reduce((best, next) => distance(next) < distance(best) ? next : best).index;
}

export function key(state: AppState, event: InputEvent, model: Model): AppState {
  const page = bodyHeight(state, model);
  if (event.type === 'mouse') {
    if (event.action === 'move') {
      if (state.mode !== 'turn' || (state.pointer?.x === event.x && state.pointer.y === event.y)) return state;
      if (state.scrolledAt?.x === event.x && state.scrolledAt.y === event.y) return state;
      const { scrolledAt: _, ...rest } = state;
      return { ...rest, pointer: { x: event.x, y: event.y } };
    }
    if (state.mode === 'help') return state;
    if (event.action === 'wheelUp' || event.action === 'wheelDown') {
      const delta = event.action === 'wheelUp' ? -3 : 3;
      if (state.mode === 'contents') return { ...state, selected: Math.max(0, Math.min(model.groups.length - 1, state.selected - Math.sign(delta))) };
      if (state.mode === 'detail') {
        let next = state;
        for (let step = 0; step < 3; step++) next = detailKey(next, delta < 0 ? 'up' : 'down', model);
        return next;
      }
      // The wheel says where the pointer is, even when no move came before it.
      return scrollTo({ ...state, pointer: { x: event.x, y: event.y }, ...(delta < 0 ? { follow: false } : {}) }, model, state.scroll + delta);
    }
    if (event.action !== 'press') return state;
    if (state.mode === 'detail') return event.y === 1 && event.x <= MARGIN + 7 ? detailKey(state, 'escape', model) : state;
    if (state.mode === 'turn' && event.y === 1) return { ...state, mode: 'contents', selected: state.index };
    // The line saying a new turn started takes you there: a click works whatever the input method.
    if (state.mode === 'turn' && state.notice !== undefined && event.y === HEADER + bodyHeight(state, model) + 1) return showTurn(state, model, state.notice);
    if (state.mode === 'turn' && event.y > HEADER) {
      // The pointer already shows what a click opens: one click opens a call, or opens and folds the answer.
      const targets = layout(state, model).targets;
      const at = targetAt(state, model, event.y, event.x, targets);
      if (at < 0) return state;
      const selected = selectCall(state, model, at, targets);
      if (targets[at].answer) return toggleAnswer(selected, model, targets[at], state.scroll);
      if (targets[at].changes) return { ...selected, changesOpen: !state.changesOpen };
      const image = openTarget(model, targets[at]);
      if (image) { const { call: _, ...rest } = selected; return { ...rest, effect: image }; }
      return { ...selected, mode: 'detail', detail: { scroll: 0, clicked: true } };
    }
    if (state.mode === 'contents' && event.y > HEADER) {
      const entries = entriesOf(model);
      const at = Math.floor((event.y - HEADER - 1 + contentsScroll(state, model)) / ENTRY_LINES);
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
    case 'enter': {
      if (state.call === undefined) return state;
      if (targets()[state.call]?.answer) return toggleAnswer(state, model, targets()[state.call], state.scroll);
      if (targets()[state.call]?.changes) return { ...state, changesOpen: !state.changesOpen };
      const image = openTarget(model, targets()[state.call]);
      if (image) return { ...state, effect: image };
      return { ...state, mode: 'detail', detail: { scroll: 0 } };
    }
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
  const entries = entriesOf(model);
  const height = model.height - HEADER;
  // Keep the selected entry's two lines on screen, scrolled in whole entries.
  return Math.max(0, Math.ceil((contentsOffset(entries, state.selected) + 2 - height) / ENTRY_LINES) * ENTRY_LINES);
}

const dim = (text: string): Span => ({ text, style: { dim: true } });

const HELP: Array<[string, string]> = [
  ['j k  ↓ ↑', '移动：选择调用或答复（选中后暂停跟随）；详情里滚动'],
  ['⏎', '进入：打开详情；展开或收起答复；目录里打开这一轮'],
  ['Esc', '返回上一层；轮页上是取消选择'],
  ['[  ]', '同一层的上一个 / 下一个：轮页是轮，详情是调用'],
  ['<  >', '详情里：同一文件的上一次 / 下一次修改'],
  ['g  G', '开头 / 末尾（轮页的 G 回到最新一轮并恢复跟随）'],
  ['␣ b  ^d ^u', '整页 / 半页'],
  ['t  o  y', '目录 / 在编辑器打开 / 复制'],
  ['a', '切回 Agent'],
  ['q', '退出'],
  ['shift+拖动', '选择文字（按住 shift，终端自己选择）'],
];

function detailFrame(state: AppState, model: Model): Line[] {
  const { width, height } = model;
  const doc = openDetail(state, model);
  const lines: Line[] = [];
  if (!doc) {
    lines.push(row([dim(' '.repeat(MARGIN) + '← Esc')], '', width), [], [dim(' '.repeat(MARGIN) + '这个调用没有可显示的记录。')]);
  } else {
    lines.push(row([dim(' '.repeat(MARGIN) + '← Esc  '), { text: doc.title, style: { bold: true } }], [dim(doc.meta + ' ')], width));
    const link = doc.path && model.caps.links ? `file://${doc.path}` : undefined;
    const path: Span[] = doc.directory !== undefined ? [dim(' '.repeat(MARGIN) + doc.directory), { text: doc.title, style: { underline: Boolean(link), ...(link ? { link } : {}) } }] : [];
    // What this detail can do, on the right of its path; what does not fit is on the help page.
    const room = width - 2 - (path.length ? Math.min(textWidth(path.map(span => span.text).join('')), Math.floor(width / 2)) + 2 : 0);
    const keys = fitKeys([doc.path ? 'o 打开' : '', `y 复制${doc.copy.what}`, doc.edits ? '< > 切换修改' : '', '? 按键'], room);
    lines.push(row(path, [dim(keys + ' ')], width));
    lines.push([]);
    const shown = height - DETAIL_HEADER;
    const scroll = Math.min(state.detail?.scroll ?? 0, Math.max(0, doc.lines.length - shown));
    lines.push(...doc.lines.slice(scroll, scroll + shown));
  }
  while (lines.length < height) lines.push([]);
  return withMessage(lines.slice(0, height), state, model);
}

/** Key hints joined three spaces apart, dropping the last ones until they fit. */
export function fitKeys(hints: string[], room: number): string {
  const shown = hints.filter(Boolean);
  while (shown.length > 1 && textWidth(shown.join('   ')) > room) shown.pop();
  return shown.join('   ');
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
    const entries = entriesOf(model);
    lines.push(row([{ text: ' '.repeat(MARGIN) }, { text: '目录', style: { bold: true } }, dim(`  共 ${model.groups.length} 轮`)], [dim(fitKeys(['⏎ 打开', 'Esc 返回'], width - 12) + ' ')], width), []);
    const list = contentsLines(entries, state.selected, width, model.caps);
    const top = contentsScroll(state, model);
    lines.push(...list.slice(top, top + height - HEADER));
    while (lines.length < height) lines.push([]);
    return lines;
  }
  if (state.mode === 'help') {
    lines.push(row([{ text: ' '.repeat(MARGIN) }, { text: '按键', style: { bold: true } }], [dim('Esc 返回 ')], width), []);
    for (const [keys, what] of HELP.filter(([keys]) => keys !== 'a' || model.focusAgent)) lines.push(cutLine([{ text: ' '.repeat(MARGIN) + keys.padEnd(12) }, dim(what)], width));
    lines.push([], cutLine([dim(' '.repeat(MARGIN) + '只读：按键只用来阅读和跳转，不会向 Agent 输入任何东西。')], width));
    while (lines.length < height) lines.push([]);
    return lines.slice(0, height);
  }
  const { lines: page, targets } = layout(state, model);
  const selected = state.call !== undefined ? targets[state.call] : undefined;
  const pointed = state.pointer !== undefined ? targets[targetAt(state, model, state.pointer.y, state.pointer.x, targets)] : undefined;
  // The header says what a key does now: open what is selected, pick up following again, find the keys.
  const paused = !state.follow && state.index === model.groups.length - 1;
  const what = selected ?? pointed;
  const aside = fitKeys([what ? (what.answer ? (state.answerOpen ? '⏎ 收起' : '⏎ 展开') : what.changes ? (state.changesOpen ? '⏎ 收起' : '⏎ 展开') : openHint(model, what)) : '', paused ? '已暂停跟随 · G' : '', '? 按键'], Math.max(0, width - 30));
  lines.push(...headerLines(ctx, aside ? [dim(aside)] : []), []);
  const on = (target: CallTarget | undefined, at: number) => target !== undefined && at >= target.line && at < target.line + target.height;
  const visible = page.slice(state.scroll, state.scroll + bodyHeight(state, model)).map((line, index) => {
    const at = index + state.scroll;
    // The selection first; the pointer brings up another call that shares the line too.
    let marked = line;
    for (const target of [selected, pointed !== selected ? pointed : undefined]) {
      if (target && on(target, at)) marked = markSelected(marked, target.row?.id);
    }
    return marked;
  });
  lines.push(...visible);
  while (lines.length < HEADER + bodyHeight(state, model)) lines.push([]);
  if (state.notice !== undefined) {
    const group = model.groups[state.notice];
    const request = (group?.request ?? '').replace(/\s+/g, ' ');
    // Set as the answer is, a label in a block of colour: 新一轮, then what was asked. A click or ] goes there.
    lines.push(cutLine([{ text: ' '.repeat(MARGIN) }, label('New turn', 'yellow'), dim(request ? ' ' + request : '')], width));
  }
  return withMessage(lines.slice(0, height), state, model);
}

/** The tab title: the session's own name, as the agent's pane shows it, so the tab reads the same
 * whichever of the two has focus; ⏸ while the agent waits for you. Before the session has a name, the agent's. */
export function windowTitle(model: Model): string {
  const name = model.session.titleSource ? model.session.title : providerName(model.session.provider);
  return model.status.kind === 'waiting' ? `⏸ ${name}` : name;
}
