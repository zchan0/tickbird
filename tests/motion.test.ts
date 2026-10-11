import test from 'node:test';
import assert from 'node:assert/strict';
import { Motion, SAY_MS, STAGGER_MS, spinnerAt, SPINNER, SPIN_MS } from '../packages/terminal/src/motion';

test('words type out over SAY_MS once the pane watches; what was there at first is simply there', () => {
  const motion = new Motion();
  motion.begin(0);
  assert.equal(motion.reveal('old', 100), 100, 'The first page is drawn still');
  assert.equal(motion.busy, false);
  motion.live = true;
  motion.begin(1000);
  assert.equal(motion.reveal('new', 100), 0);
  assert.equal(motion.busy, true);
  motion.begin(1000 + SAY_MS / 2);
  assert.equal(motion.reveal('new', 100), 50);
  motion.begin(1000 + SAY_MS);
  assert.equal(motion.reveal('new', 100), 100);
  assert.equal(motion.busy, false);
  // Words that grow go on typing from where they are, not from the start.
  motion.begin(2000);
  assert.equal(motion.reveal('new', 200), 100);
  motion.begin(2000 + SAY_MS);
  assert.equal(motion.reveal('new', 200), 200);
  // Seen once, the same words never move again.
  motion.begin(5000);
  assert.equal(motion.reveal('old', 100), 100);
});

test('calls first seen on one page come in one after another; a still page counts as seen', () => {
  const motion = new Motion();
  motion.begin(0);
  assert.equal(motion.shows('a'), true);
  motion.live = true;
  motion.begin(100);
  assert.deepEqual([motion.shows('b'), motion.shows('c'), motion.shows('d')], [true, false, false]);
  motion.begin(100 + STAGGER_MS);
  assert.deepEqual([motion.shows('b'), motion.shows('c'), motion.shows('d')], [true, true, false]);
  motion.begin(100 + 2 * STAGGER_MS);
  assert.deepEqual([motion.shows('c'), motion.shows('d')], [true, true]);
  assert.equal(motion.busy, false);
  assert.equal(spinnerAt(SPIN_MS * 3), SPINNER[3]);
});

test('calls that come with words wait until the words are out, then come in one after another', () => {
  const motion = new Motion();
  motion.live = true;
  motion.begin(1000);
  // Words and two calls arrive on one page, drawn in that order.
  motion.reveal('say', 60);
  assert.deepEqual([motion.shows('a'), motion.shows('b')], [false, false], 'Not while the words type');
  motion.begin(1000 + SAY_MS - 1);
  motion.reveal('say', 60);
  assert.deepEqual([motion.shows('a'), motion.shows('b')], [false, false]);
  motion.begin(1000 + SAY_MS);
  assert.deepEqual([motion.shows('a'), motion.shows('b')], [true, false], 'The first as the words end');
  motion.begin(1000 + SAY_MS + STAGGER_MS);
  assert.deepEqual([motion.shows('a'), motion.shows('b')], [true, true]);
  // A call that comes later, with no new words, comes at once.
  motion.begin(5000);
  assert.equal(motion.shows('c'), true);
});
