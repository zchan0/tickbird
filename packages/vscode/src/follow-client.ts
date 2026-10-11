/** Follow the newest turn's chronological tail, not the bottom of older history. */
export const followClient = `
  const followButton = document.querySelector('[data-follow-toggle]');
  const followLabel = document.querySelector('[data-follow-label]');
  let following = Boolean(followButton && (saved.autoFollow === true || !saved.readingVersion));
  const paintFollowing = () => {
    if (!followButton) return;
    followButton.setAttribute('aria-pressed', String(following));
    // Short, so the turn's line beside it keeps its time in a narrow side bar; the tooltip says the rest.
    followButton.textContent = following ? '' : '↓ 跟随';
    followButton.title = following ? '' : '已暂停跟随：回到最新一轮的末尾，恢复跟随';
    if (followLabel) followLabel.textContent = following ? '轮内按发生顺序' : '已暂停跟随';
  };
  const followPosition = () => {
    const edge = panels()[0]?.querySelector('.turn-content-end');
    if (!panels()[0]?.hasAttribute('data-current')) return undefined;
    if (!timeline || !edge || timeline.clientHeight <= 0) return undefined;
    return Math.min(Math.max(0, timeline.scrollHeight - timeline.clientHeight),
      Math.max(0, timeline.scrollTop + edge.getBoundingClientRect().top - timeline.getBoundingClientRect().top - timeline.clientHeight + 16));
  };
  // Glide when the new tail is near; jump when it is far. A glide's own scroll
  // events are not the reader scrolling, so they must not pause following.
  let gliding = 0;
  const lessMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const followLatest = () => {
    const position = followPosition();
    if (!following || position === undefined) return;
    const distance = Math.abs(position - timeline.scrollTop);
    if (!lessMotion && distance > 2 && distance < timeline.clientHeight * 1.5 && typeof timeline.scrollTo === 'function') {
      gliding = Date.now() + 700;
      timeline.scrollTo({ top: position, behavior: 'smooth' });
    } else timeline.scrollTop = position;
    trackReading();
  };
  const pauseFollowing = () => { following = false; paintFollowing(); };
  // Bring a block's start to the top, as the reader's next thing to read; the
  // reader is then reading, not following, until they return to the edge.
  const readFromTop = node => {
    const top = Math.max(0, timeline.scrollTop + node.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 12);
    pauseFollowing(); persist();
    gliding = Date.now() + 900;
    if (!lessMotion && typeof timeline.scrollTo === 'function') timeline.scrollTo({ top, behavior: 'smooth' }); else timeline.scrollTop = top;
  };
  // A new turn means a new request was sent to the agent: the reader is back at
  // the live edge. Pausing covers the turn being read, not every later turn.
  const resumeFollowing = () => { if (!followButton || following) return; following = true; paintFollowing(); persist(); };
  // Only the reader's own scrolling can bring following back; a layout shift or
  // an anchored update that happens to land on the edge does not.
  let readerInput = 0;
  const readerScrolled = () => { readerInput = Date.now(); };
  if (followButton) {
    // Following again goes back to the newest turn.
    followButton.addEventListener('click', () => {
      following = true; paintFollowing();
      const newest = panels()[0];
      if (newest) goTo(newest.dataset.turnPanel);
      followLatest(); persist();
    });
    timeline.addEventListener('scroll', () => {
      if (Date.now() < gliding) return;
      const position = followPosition();
      if (position === undefined) return;
      const atEdge = Math.abs(timeline.scrollTop - position) <= 3;
      if (following && !atEdge) { pauseFollowing(); persist(); }
      // Scrolling back down to the newest turn's end is asking to follow again.
      else if (!following && atEdge && Date.now() - readerInput < 1000) { following = true; paintFollowing(); persist(); }
    }, { passive: true });
    for (const name of ['wheel', 'keydown', 'pointerdown', 'touchmove']) timeline.addEventListener(name, readerScrolled, { passive: true });
    // Reading an expanded call, opening evidence or choosing a turn is explicit
    // reader intent. A later result must not pull that content out of view.
    document.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target.closest('summary, button[data-item-id], button[data-turn-id], button[data-lens-turn-id]') : null;
      if (target && sidecar.contains(target)) { pauseFollowing(); persist(); }
    });
    // Moving up, away from the live edge, pauses at once; moving down is judged by where it lands.
    timeline.addEventListener('wheel', event => {
      if (event.deltaY < 0) { pauseFollowing(); persist(); }
    }, { passive: true });
    timeline.addEventListener('keydown', event => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) { pauseFollowing(); persist(); }
    });
  }
  paintFollowing();
`;
