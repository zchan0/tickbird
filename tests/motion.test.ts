import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKLOG_MS, breathAt, BREATH_MS, FADE_MS, Motion, REST_MS, SAY_MAX, SAY_MIN, STAGGER_MS, WAIT_MS, WORD_MS } from '../packages/terminal/src/motion';

test('words type out at a reading pace once the pane watches; what was there at first is simply there', () => {
  const motion = new Motion();
  motion.begin(0);
  assert.equal(motion.reveal('old', 100), 100, 'The first page is drawn still');
  assert.equal(motion.busy, false);
  motion.live = true;
  // 60 characters at WORD_MS each.
  const ms = 60 * WORD_MS;
  motion.begin(1000);
  assert.equal(motion.reveal('new', 60), 0);
  assert.equal(motion.busy, true);
  motion.begin(1000 + ms / 2);
  assert.equal(motion.reveal('new', 60), 30);
  motion.begin(1000 + ms);
  assert.equal(motion.reveal('new', 60), 60);
  assert.equal(motion.busy, false);
  // Words that grow go on typing from where they are, not from the start.
  motion.begin(2000);
  assert.equal(motion.reveal('new', 120), 60);
  motion.begin(2000 + 60 * WORD_MS);
  assert.equal(motion.reveal('new', 120), 120, 'Sixty more characters, at the pace of sixty');
  // Seen once, the same words never move again.
  motion.begin(5000);
  assert.equal(motion.reveal('old', 100), 100);
});

test('a short line still takes SAY_MIN, a long paragraph no more than SAY_MAX', () => {
  const motion = new Motion();
  motion.live = true;
  motion.begin(0);
  motion.reveal('short', 4); motion.reveal('long', 2000);
  motion.begin(SAY_MIN - 1);
  assert.ok(motion.reveal('short', 4) < 4);
  motion.begin(SAY_MIN);
  assert.equal(motion.reveal('short', 4), 4);
  motion.begin(SAY_MAX);
  assert.equal(motion.reveal('long', 2000), 2000);
});

test('calls first seen together come in one after another, each fading in; a still page counts as seen', () => {
  const motion = new Motion();
  motion.begin(0);
  assert.equal(motion.shows('a'), true);
  motion.live = true;
  motion.begin(100);
  assert.deepEqual([motion.shows('b'), motion.shows('c'), motion.shows('d')], [true, false, false]);
  assert.equal(motion.age('b'), 0, 'Just come in: it fades in from here');
  motion.begin(100 + STAGGER_MS);
  assert.deepEqual([motion.shows('b'), motion.shows('c'), motion.shows('d')], [true, true, false]);
  // Calls seen on a later page queue behind the ones still waiting.
  assert.equal(motion.shows('e'), false);
  motion.begin(100 + 3 * STAGGER_MS);
  assert.deepEqual([motion.shows('d'), motion.shows('e')], [true, true]);
  motion.begin(100 + 3 * STAGGER_MS + FADE_MS);
  assert.deepEqual([motion.shows('d'), motion.shows('e')], [true, true]);
  assert.equal(motion.busy, false, 'All in and faded');
});

test('calls that come with words wait until the words are out and a beat more; words after waiting calls wait too', () => {
  const motion = new Motion();
  motion.live = true;
  motion.begin(1000);
  // Words and two calls arrive on one page, drawn in that order.
  const ms = 60 * WORD_MS;
  motion.reveal('say', 60);
  assert.deepEqual([motion.shows('a'), motion.shows('b')], [false, false], 'Not while the words type');
  motion.begin(1000 + ms + REST_MS - 1);
  assert.deepEqual([motion.shows('a'), motion.shows('b')], [false, false], 'Nor in the beat after');
  motion.begin(1000 + ms + REST_MS);
  assert.deepEqual([motion.shows('a'), motion.shows('b')], [true, false], 'The first after the beat');
  // Words seen now wait for the call still queued: the page only grows at its end.
  assert.equal(motion.reveal('next', 60), 0);
  motion.begin(1000 + ms + REST_MS + STAGGER_MS);
  assert.deepEqual([motion.shows('a'), motion.shows('b')], [true, true]);
  assert.equal(motion.reveal('next', 60), 0, 'Starts typing only now');
  // A call that comes later, with no new words, comes at once.
  motion.begin(9000);
  assert.equal(motion.shows('c'), true);
});

test('a queue more than BACKLOG_MS ahead shows at once', () => {
  const motion = new Motion();
  motion.live = true;
  motion.begin(0);
  const keys = Array.from({ length: 40 }, (_, index) => `k${index}`);
  keys.forEach(key => motion.shows(key));
  motion.begin(BACKLOG_MS);
  assert.ok(keys.every(key => motion.shows(key)), 'Nothing waits past the backlog');
});

test('the waiting dot rests until everything is in, then breathes without going out', () => {
  const motion = new Motion();
  motion.live = true;
  motion.begin(0);
  motion.reveal('say', 20);
  assert.equal(motion.resting(), false);
  motion.begin(SAY_MIN + WAIT_MS - 1);
  assert.equal(motion.resting(), false);
  motion.begin(SAY_MIN + WAIT_MS);
  assert.equal(motion.resting(), true);
  const still = new Motion();
  assert.equal(still.resting(), true, 'Drawn still, it is there at once');
  assert.ok(Math.abs(breathAt(0) - 0.3) < 1e-9 && Math.abs(breathAt(BREATH_MS / 2) - 1) < 1e-9);
});

test('words that grow while the calls under them wait hold those calls back until the rest is typed', () => {
  const motion = new Motion();
  motion.live = true;
  motion.begin(0);
  motion.reveal('say', 20);
  assert.equal(motion.shows('a'), false);
  // Before the call's turn, the hook sends the rest of the words.
  motion.begin(SAY_MIN);
  assert.ok(motion.reveal('say', 120) < 120);
  motion.begin(SAY_MIN + REST_MS + 10);
  assert.equal(motion.shows('a'), false, 'Not in the middle of the words');
  motion.begin(SAY_MIN + 100 * WORD_MS + REST_MS);
  assert.equal(motion.reveal('say', 120), 120);
  assert.equal(motion.shows('a'), true, 'Once the words are out and a beat more');
});
