/**
 * What is new on the page, and how far it has come in. Words the agent just
 * said type out over SAY_MS; calls that arrive together come in STAGGER_MS
 * apart. Only what arrives while the pane watches moves: everything on the
 * first page drawn, and anything drawn while `live` is off, is simply there.
 * The page asks by a key that stays the same from the hook's early copy to
 * the transcript's record, so nothing moves twice.
 */
export const SAY_MS = 300;
export const STAGGER_MS = 80;
/** One turn of the spinner. */
export const SPIN_MS = 80;

interface Words { length: number; from: number; at: number }

export class Motion {
  /** Off for the first page drawn, and while the reader is not on the newest turn's live end. */
  live = false;
  /** Set while a page is drawn: something on it is still coming in or turning. */
  busy = false;
  private words = new Map<string, Words>();
  private calls = new Map<string, number>();
  private batch = 0;
  private now = 0;
  /** When the words now typing are all out: the calls under them wait for it. */
  private typed = -Infinity;

  /** Starts a page drawn at `now`. */
  begin(now: number): void { this.now = now; this.batch = 0; this.busy = false; }

  /** How many of `length` characters of the words under `key` show now. */
  reveal(key: string, length: number): number {
    const seen = this.words.get(key);
    if (!seen) {
      this.words.set(key, this.live ? { length, from: 0, at: this.now } : { length, from: length, at: -Infinity });
      if (this.live && length) this.typed = Math.max(this.typed, this.now + SAY_MS);
      return this.reveal(key, length);
    }
    const shown = (words: Words) => Math.min(words.length, words.from + Math.floor((words.length - words.from) * Math.min(1, (this.now - words.at) / SAY_MS)));
    // Words that grow (the hook sends long ones in pieces) go on typing from where they are.
    if (length > seen.length) {
      this.words.set(key, { length, from: this.live ? shown(seen) : length, at: this.now });
      if (this.live) this.typed = Math.max(this.typed, this.now + SAY_MS);
    }
    else if (length < seen.length) this.words.set(key, { length, from: length, at: -Infinity });
    const count = shown(this.words.get(key)!);
    if (count < length) this.busy = true;
    return count;
  }

  /** Whether the call under `key` shows yet; calls first seen on one page come in one after another. */
  shows(key: string): boolean {
    let at = this.calls.get(key);
    if (at === undefined) {
      // After the words above them are out, then one after another: a call never comes before what explains it.
      at = this.live ? Math.max(this.now, this.typed) + this.batch++ * STAGGER_MS : -Infinity;
      this.calls.set(key, at);
    }
    if (at > this.now) { this.busy = true; return false; }
    return true;
  }

  /** Something turns on the page: draw it again soon. */
  turning(): void { this.busy = true; }
}

/** A spinner frame for a call still running, at `now`. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const spinnerAt = (now: number): string => SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length];
