import type { Provider, TimelineItem } from '../../../core/src/model';
import type { TurnGroup } from '../../../core/src/timeline';
import { plainPasted } from '../../../core/src/pasted';
import { clock, publicBody, turnView } from '../../../core/src/turn-view';
import { symbol, type Capabilities } from '../caps';
import { row, type Line, type Style } from '../screen';
import { runningClock, type SessionStatus } from './turn-page';

/**
 * 目录: every turn, newest first, two lines each — the request, and the line
 * the agent printed when the turn ended. The state of each turn on the right.
 */
export interface ContentsEntry { index: number; request: string; detail: string; state: string; stateStyle: Style }

const firstLine = (item: TimelineItem | undefined, group: TurnGroup): string =>
  plainPasted(item ? publicBody(item) : group.request).replace(/\s+/g, ' ').trim() || '（未取得本轮请求）';

export function contentsEntries(groups: TurnGroup[], provider: Provider, status: SessionStatus, caps: Pick<Capabilities, 'symbols'>, now: number): ContentsEntry[] {
  return groups.map((group, index) => {
    const latest = index === groups.length - 1;
    const view = turnView(group, latest, provider);
    const calls = `${view.calls} ${view.calls === 1 ? 'call' : 'calls'}`;
    const at = clock(view.turn.start);
    let state = '完成', stateStyle: Style = { dim: true }, detail: string;
    if (latest && status.kind === 'waiting') { state = '等你批准'; stateStyle = { fg: 'yellow' }; }
    else if (latest && status.kind === 'running') { state = '运行中'; stateStyle = { fg: 'yellow' }; }
    else if (view.turn.aborted) state = '中断';
    else if (view.live) state = '无新记录';
    if (view.live || view.turn.aborted || !view.turn.durationMs) {
      const start = view.turn.start ? Date.parse(view.turn.start) : NaN;
      const end = view.live ? now : view.turn.lastAt ? Date.parse(view.turn.lastAt) : NaN;
      const length = Number.isFinite(start) && Number.isFinite(end) ? runningClock(end - start) : '';
      detail = [length, calls, at].filter(Boolean).join(' · ');
    } else {
      detail = [`${symbol(caps, '✻')} ${view.done}`, calls, at].filter(Boolean).join(' · ');
    }
    return { index, request: firstLine(view.turn.request, group), detail, state, stateStyle };
  }).reverse();
}

/** Lines of the list; `selected` is a turn index. Each entry is two lines and a blank. */
export function contentsLines(entries: ContentsEntry[], selected: number, width: number, caps: Pick<Capabilities, 'symbols'>): Line[] {
  const lines: Line[] = [];
  for (const entry of entries) {
    const on = entry.index === selected;
    const mark = on ? [{ text: ` ${symbol(caps, '❯')} `, style: { fg: 'yellow' } as Style }] : [{ text: '   ' }];
    lines.push(row([...mark, { text: entry.request, style: on ? { bold: true } : {} }], [{ text: entry.state, style: entry.stateStyle }, { text: ' ' }], width));
    lines.push(row([{ text: '   ' }, { text: entry.detail, style: { dim: true } }], '', width));
    lines.push([]);
  }
  return lines;
}

/** Where the selected entry's first line is, to keep it on screen. */
export const contentsOffset = (entries: ContentsEntry[], selected: number): number =>
  Math.max(0, entries.findIndex(entry => entry.index === selected)) * 3;
