/**
 * What is new on the page, and how far it has come in, at the VS Code panel's
 * pace (design v12). Words the agent just said type out at a reading pace,
 * WORD_MS a character, SAY_MIN to SAY_MAX in all. The calls under them wait for
 * the words and a REST_MS beat, then come in STAGGER_MS apart, each fading in
 * over FADE_MS where the terminal's colours are known. Words that come after
 * calls still waiting wait their turn too, so the page only grows at its end.
 * Anything queued more than BACKLOG_MS ahead shows at once: the pane must not
 * fall behind the agent. The waiting dot comes back WAIT_MS after the last of
 * it is in. Only what arrives while the pane watches moves: everything on the
 * first page drawn, and anything drawn while `live` is off, is simply there.
 * The page asks by a key that stays the same from the hook's early copy to
 * the transcript's record, so nothing moves twice.
 */
export const WORD_MS = 5;
export const SAY_MIN = 120;
export const SAY_MAX = 480;
export const REST_MS = 120;
export const STAGGER_MS = 90;
export const FADE_MS = 150;
export const BACKLOG_MS = 1200;
export const WAIT_MS = 240;
/** How often a page with something moving on it is drawn again. */
export const SPIN_MS = 80;
/** One breath of the waiting dot. */
export const BREATH_MS = 1600;

interface Words { length: number; from: number; at: number; ms: number }
interface Call { at: number; shown: boolean }

const pace = (chars: number): number => Math.min(SAY_MAX, Math.max(SAY_MIN, chars * WORD_MS));

export class Motion {
  /** Off for the first page drawn, and while the reader is not on the newest turn's live end. */
  live = false;
  /** Set while a page is drawn: something on it is still coming in or turning. */
  busy = false;
  private words = new Map<string, Words>();
  private calls = new Map<string, Call>();
  private now = 0;
  /** When the words now typing are all out: the calls under them wait for it. */
  private typed = -Infinity;
  /** When the last call queued comes in: what arrives after it waits for it. */
  private queued = -Infinity;
  /** When the last thing to come in is all in: the waiting dot waits for it. */
  private settled = -Infinity;

  /** Starts a page drawn at `now`. */
  begin(now: number): void { this.now = now; this.busy = false; }

  /** When something new can start: after what is queued, and never more than BACKLOG_MS from now. */
  private next(after: number): number {
    const at = Math.max(this.now, after);
    return at - this.now > BACKLOG_MS ? this.now : at;
  }

  /** How many of `length` characters of the words under `key` show now. */
  reveal(key: string, length: number): number {
    const seen = this.words.get(key);
    if (!seen) {
      if (this.live && length) {
        const at = this.next(this.queued + STAGGER_MS), ms = pace(length);
        this.words.set(key, { length, from: 0, at, ms });
        this.typed = Math.max(this.typed, at + ms);
        this.settled = Math.max(this.settled, at + ms);
      } else this.words.set(key, { length, from: length, at: -Infinity, ms: 0 });
      return this.reveal(key, length);
    }
    const shown = (words: Words) => words.ms
      ? Math.min(words.length, words.from + Math.floor((words.length - words.from) * Math.max(0, Math.min(1, (this.now - words.at) / words.ms))))
      : words.length;
    // Words that grow (the hook sends long ones in pieces) go on typing from where they are,
    // and the calls still waiting under them wait for the rest: none comes in mid-sentence.
    if (length > seen.length) {
      const from = this.live ? shown(seen) : length, ms = this.live ? pace(length - from) : 0;
      this.words.set(key, { length, from, at: this.now, ms });
      if (this.live) { this.typed = Math.max(this.typed, this.now + ms); this.settled = Math.max(this.settled, this.now + ms); this.hold(this.now + ms + REST_MS); }
    }
    else if (length < seen.length) this.words.set(key, { length, from: length, at: -Infinity, ms: 0 });
    const count = shown(this.words.get(key)!);
    if (count < length) this.busy = true;
    return count;
  }

  /**
   * How long the call under `key` has shown, or undefined while it waits its
   * turn. Calls first seen together come in one after another, after the words
   * above them: a call never comes before what explains it.
   */
  age(key: string): number | undefined {
    let call = this.calls.get(key);
    if (!call) {
      if (this.live) {
        const at = this.next(Math.max(this.typed + REST_MS, this.queued + STAGGER_MS));
        this.queued = at;
        this.settled = Math.max(this.settled, at + FADE_MS);
        call = { at, shown: false };
      } else call = { at: -Infinity, shown: true };
      this.calls.set(key, call);
    }
    if (call.at > this.now) { this.busy = true; return undefined; }
    call.shown = true;
    if (this.now - call.at < FADE_MS) this.busy = true;
    return this.now - call.at;
  }

  /** The calls not yet in come in from `start` on, still one after another. */
  private hold(start: number): void {
    let at = start;
    for (const call of this.calls.values()) {
      if (call.shown || call.at >= at) continue;
      call.at = at;
      at += STAGGER_MS;
    }
    this.queued = Math.max(this.queued, at - STAGGER_MS);
  }

  /** Whether the call under `key` shows yet. */
  shows(key: string): boolean { return this.age(key) !== undefined; }

  /** Nothing is coming in, and nothing has for WAIT_MS: the waiting dot may show. */
  resting(): boolean {
    if (!this.live || this.now >= this.settled + WAIT_MS) return true;
    this.busy = true;
    return false;
  }

  /** Something turns on the page: draw it again soon. */
  turning(): void { this.busy = true; }
}

/**
 * The waiting dot's brightness at `now`, from 0.3 to 1 and back over a
 * BREATH_MS breath: still there at its faintest, never a blink.
 */
export const breathAt = (now: number): number => 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(2 * Math.PI * now / BREATH_MS));
