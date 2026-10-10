/**
 * Turns raw terminal input into keys and mouse events. Understands the legacy
 * encodings, the kitty keyboard protocol (`CSI code;mods u`) and SGR mouse.
 */
export interface Key {
  type: 'key';
  /** 'up', 'enter', 'escape', 'pageup' …, or the character itself, lower case for letters with ctrl. */
  name: string;
  ctrl: boolean; alt: boolean; shift: boolean;
}
export interface Mouse {
  type: 'mouse';
  action: 'press' | 'release' | 'move' | 'wheelUp' | 'wheelDown' | 'wheelLeft' | 'wheelRight';
  button: number;
  /** 1-based cell. */
  x: number; y: number;
}
export type InputEvent = Key | Mouse;

const key = (name: string, mods: Partial<Omit<Key, 'type' | 'name'>> = {}): Key =>
  ({ type: 'key', name, ctrl: Boolean(mods.ctrl), alt: Boolean(mods.alt), shift: Boolean(mods.shift) });

/** xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). */
const modifiers = (param: number | undefined) => {
  const bits = Math.max(0, (param ?? 1) - 1);
  return { shift: Boolean(bits & 1), alt: Boolean(bits & 2), ctrl: Boolean(bits & 4) };
};

const FINAL_KEYS: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4', Z: 'tab' };
const TILDE_KEYS: Record<number, string> = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12' };
const KITTY_KEYS: Record<number, string> = { 9: 'tab', 13: 'enter', 27: 'escape', 127: 'backspace' };

function controlKey(code: number, alt = false): Key {
  if (code === 13 || code === 10) return key('enter', { alt });
  if (code === 9) return key('tab', { alt });
  if (code === 127 || code === 8) return key('backspace', { alt });
  if (code === 27) return key('escape', { alt });
  if (code === 0) return key('space', { ctrl: true, alt });
  if (code < 27) return key(String.fromCharCode(code + 96), { ctrl: true, alt });
  return key(String.fromCharCode(code), { alt });
}

function csi(params: string, final: string): InputEvent | undefined {
  if (final === 'M' || final === 'm') {
    const mouse = params.match(/^<(\d+);(\d+);(\d+)$/);
    if (!mouse) return undefined;
    const button = Number(mouse[1]);
    const x = Number(mouse[2]), y = Number(mouse[3]);
    // The wheel: 64 up, 65 down, 66 left, 67 right. A trackpad swipe sends some sideways
    // steps among the vertical ones; read as up or down, they shook the page back and forth.
    if (button & 64) return { type: 'mouse', action: (['wheelUp', 'wheelDown', 'wheelLeft', 'wheelRight'] as const)[button & 3], button, x, y };
    // Any-event tracking: the pointer moved, with or without a button down.
    if (button & 32) return { type: 'mouse', action: 'move', button: button & 3, x, y };
    return { type: 'mouse', action: final === 'M' ? 'press' : 'release', button: button & 3, x, y };
  }
  const numbers = params.split(';').map(part => Number(part.split(':')[0]) || 0);
  if (final === 'u') {
    const code = numbers[0];
    const mods = modifiers(numbers[1]);
    const named = KITTY_KEYS[code];
    if (named) return key(named, mods);
    const char = String.fromCodePoint(code);
    return key(mods.shift && !mods.ctrl && !mods.alt ? char.toUpperCase() : char, mods);
  }
  if (final === '~') {
    const name = TILDE_KEYS[numbers[0]];
    return name ? key(name, modifiers(numbers[1])) : undefined;
  }
  const name = FINAL_KEYS[final];
  if (!name) return undefined;
  const mods = modifiers(numbers[1]);
  return key(name, final === 'Z' ? { ...mods, shift: true } : mods);
}

/**
 * A Chinese input method in its punctuation mode types these for the keys
 * the pane listens to: 】 for ], ？ for ?. They mean the same key.
 */
const FULL_WIDTH: Record<string, string> = { '【': '[', '】': ']', '？': '?', '《': '<', '》': '>', '：': ':', '／': '/', '、': '\\' };

export class InputParser {
  private buffer = '';

  /** True while the buffer ends in a lone Esc that may still start a sequence. */
  get pending(): boolean { return this.buffer.length > 0; }

  feed(text: string): InputEvent[] {
    this.buffer += text;
    const events: InputEvent[] = [];
    while (this.buffer) {
      const consumed = this.next(events, false);
      if (consumed === 0) break;
      this.buffer = this.buffer.slice(consumed);
    }
    return events;
  }

  /** Called after a short quiet gap: whatever is left is taken literally (a lone Esc is Escape). */
  flush(): InputEvent[] {
    const events: InputEvent[] = [];
    while (this.buffer) {
      const consumed = this.next(events, true) || 1;
      this.buffer = this.buffer.slice(consumed);
    }
    return events;
  }

  /** Parses one event at the buffer start; returns the characters used, or 0 to wait for more. */
  private next(events: InputEvent[], final: boolean): number {
    const text = this.buffer;
    if (text[0] !== '\x1b') {
      const char = String.fromCodePoint(text.codePointAt(0)!);
      const code = char.codePointAt(0)!;
      events.push(code < 32 || code === 127 ? controlKey(code) : key(char === ' ' ? 'space' : FULL_WIDTH[char] ?? char));
      return char.length;
    }
    if (text.length === 1) {
      if (!final) return 0;
      events.push(key('escape'));
      return 1;
    }
    const second = text[1];
    if (second === '[') {
      const match = text.slice(2).match(/^([<?>=]?[\d;:]*)[\x20-\x2f]*([\x40-\x7e])/);
      if (!match) {
        if (!final && /^[<?>=]?[\d;:]*[\x20-\x2f]*$/.test(text.slice(2))) return 0;
        events.push(key('[', { alt: true }));
        return 2;
      }
      const event = csi(match[1], match[2]);
      if (event) events.push(event);
      return 2 + match[0].length;
    }
    if (second === ']' || second === 'P' || second === '_') {
      // A terminal reply that came late (OSC, DCS, APC): skip it whole, never read it as keys.
      const end = text.slice(2).search(second === ']' ? /\x07|\x1b\\/ : /\x1b\\/);
      if (end < 0) { if (!final) return 0; events.push(key(second, { alt: true })); return 2; }
      return 2 + end + (text[2 + end] === '\x07' ? 1 : 2);
    }
    if (second === 'O') {
      if (text.length < 3) { if (!final) return 0; events.push(key('O', { alt: true })); return 2; }
      const name = FINAL_KEYS[text[2]];
      if (name) { events.push(key(name)); return 3; }
      events.push(key('O', { alt: true }));
      return 2;
    }
    if (second === '\x1b') { events.push(key('escape')); return 1; }
    const char = String.fromCodePoint(text.codePointAt(1)!);
    const code = char.codePointAt(0)!;
    events.push(code < 32 || code === 127 ? controlKey(code, true) : key(char, { alt: true }));
    return 1 + char.length;
  }
}

/** How a key reads in the help line and the demo echo: ↑, ⏎, Esc, Alt+x, Ctrl+c. */
export function describe(event: InputEvent): string {
  if (event.type === 'mouse') return `${event.action} ${event.x},${event.y}`;
  const names: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→', enter: '⏎', escape: 'Esc', tab: 'Tab', backspace: '⌫', space: 'Space', pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End', delete: 'Del', insert: 'Ins' };
  const base = names[event.name] ?? (event.name.length > 1 ? event.name.toUpperCase() : event.name);
  return [event.ctrl && 'Ctrl', event.alt && 'Alt', event.shift && event.name.length > 1 && 'Shift', base].filter(Boolean).join('+');
}
