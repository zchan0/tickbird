import type { Provider, TimelineItem } from '../../../core/src/model';
import type { TurnGroup } from '../../../core/src/timeline';
import { plainPasted } from '../../../core/src/pasted';
import { clock, publicBody, type turnView } from '../../../core/src/turn-view';
import { symbol, type Capabilities } from '../caps';
import { row, type Line, type Span, type Style } from '../screen';
import { viewOf, type SessionStatus } from './turn-page';
import { t } from '../../../core/src/i18n';

/**
 * 目录: every turn, newest first, two lines and a blank each — its number,
 * the request and when it started, then the first line of what the agent
 * answered. Where the turn is not simply done, its state takes that line.
 */
export interface ContentsEntry { index: number; ordinal: number; request: string; at: string; answer: string; state: string; stateStyle: Style }

/** The first line of the turn's closing answer, as plain text. */
const answerLine = (view: ReturnType<typeof turnView>): string => {
  const text = view.answers.map(segment => segment.kind === 'answer' ? publicBody(segment.item) : '').find(Boolean) ?? '';
  const first = text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  return first.replace(/^#+\s*|^[-*]\s+|^\d+\.\s+/, '').replace(/\*\*|__|`/g, '');
};

const firstLine = (item: TimelineItem | undefined, group: TurnGroup): string =>
  plainPasted(item ? publicBody(item) : group.request).replace(/\s+/g, ' ').trim() || t('(no request recorded for this turn)', '（未取得本轮请求）');

export function contentsEntries(groups: TurnGroup[], provider: Provider, status: SessionStatus, _caps: Pick<Capabilities, 'symbols'>, _now: number): ContentsEntry[] {
  return groups.map((group, index) => {
    const latest = index === groups.length - 1;
    const view = viewOf(group, latest, provider);
    let state = '', stateStyle: Style = { dim: true };
    if (latest && status.kind === 'waiting') { state = t('waiting for you', '等你批准'); stateStyle = { fg: 'yellow' }; }
    else if (latest && status.kind === 'running') { state = t('running', '运行中'); stateStyle = { fg: 'yellow' }; }
    else if (view.turn.aborted) { state = t('interrupted', '中断'); stateStyle = { fg: 'red' }; }
    else if (view.live) state = t('no new records', '无新记录');
    return { index, ordinal: group.ordinal ?? index + 1, request: firstLine(view.turn.request, group), at: clock(view.turn.start), answer: state ? '' : answerLine(view), state, stateStyle };
  }).reverse();
}

/**
 * Lines of the list; `selected` is a turn index. The selected turn comes up
 * as a selected call does on the turn page: its number from grey to the body
 * colour, its request underlined, and a ⏎ at the end.
 */
export function contentsLines(entries: ContentsEntry[], selected: number, width: number, caps: Pick<Capabilities, 'symbols'>): Line[] {
  const digits = Math.max(2, ...entries.map(entry => String(entry.ordinal).length));
  return entries.flatMap(entry => {
    const on = entry.index === selected;
    const left: Span[] = [{ text: String(entry.ordinal).padStart(digits + 1) + ' ', style: on ? {} : { dim: true } }, { text: entry.request, style: on ? { underline: true } : {} }];
    const right: Span[] = [
      { text: entry.at, style: { dim: true } },
      on ? { text: ' ' + symbol(caps, '⏎'), style: { bold: true } } : { text: '  ' },
      { text: ' ' },
    ];
    const second: Span = entry.state ? { text: entry.state, style: entry.stateStyle } : { text: entry.answer, style: { dim: true } };
    return [row(left, right, width), row([{ text: ' '.repeat(digits + 2) }, second], '', width), []];
  });
}

/** Lines each entry takes, its blank included. */
export const ENTRY_LINES = 3;

/** Where the selected entry's first line is, to keep it on screen. */
export const contentsOffset = (entries: ContentsEntry[], selected: number): number =>
  Math.max(0, entries.findIndex(entry => entry.index === selected)) * ENTRY_LINES;
