/** Embedded in our nonce-protected Webview script; receives only host-rendered fragments. */
export const liveClient = `
  const installObservation = onUpdated => {
    const streamId = sidecar && sidecar.dataset && sidecar.dataset.observationStream;
    if (!streamId || !timeline) return;
    let version = 0;
    let resyncPending = false;
    let scopeStopped = false;
    const key = node => node.nodeType === 1 ? ['observationKey', 'turnPanel', 'itemId', 'actionGroup', 'textId', 'inlineId', 'turnId', 'lensTurnId']
      .map(name => node.dataset[name] ? node.tagName + ':' + name + ':' + node.dataset[name] : '').find(Boolean) : undefined;
    const compatible = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);
    // Client-owned state the host never renders: an arrival still waiting or fading in, a quiet turn.
    const transient = name => name === 'arrived';
    const morph = (current, next) => {
      if (current.nodeType === 1 && current.dataset.inlineLoaded && current.dataset.inlineRevision === next.dataset?.inlineRevision) return;
      if (current.isEqualNode(next)) return;
      if (current.nodeType !== 1) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; return; }
      const local = name => name === 'open' && current.tagName === 'DETAILS' || name === 'aria-pressed' || name === 'aria-expanded' || name === 'data-stale' || name === 'data-fresh' || name === 'data-idle' || name === 'data-current' || name === 'style';
      const animating = [...current.classList].filter(transient);
      for (const attribute of [...current.attributes]) if (!local(attribute.name) && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
      for (const attribute of [...next.attributes]) if (!local(attribute.name) && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
      if (animating.length) current.classList.add(...animating);
      children(current, next);
    };
    let arrivals = [], revealAt = 0;
    // Claude Code writes a response's words together with the call that follows
    // them, so records land in bursts. Reveal the smallest keyed parts one at a
    // time: the agent's words fade in fully and rest before the first call row,
    // rows follow a step apart, and the loading line comes back only after all of
    // it. A new burst waits for the one still appearing; a long one is quickened.
    const FADE = 260, WORDS = FADE + 380, ROW = 170, TAIL = 220, BACKLOG = 2500;
    const words = part => part.matches('.csay, .tprompt, .turn-heading, .cfold');
    const reveal = (part, delay) => {
      // Restart: a part already fading (the loading line) goes back to waiting.
      part.classList.remove('arrived'); void part.offsetWidth;
      part.style.animationDelay = Math.round(delay) + 'ms';
      part.classList.add('arrived');
      const done = event => {
        if (event.target !== part) return;
        part.removeEventListener('animationend', done);
        part.classList.remove('arrived'); part.style.animationDelay = '';
        if (!part.getAttribute('style')) part.removeAttribute('style');
      };
      part.addEventListener('animationend', done);
    };
    const stagger = nodes => {
      const parts = new Set();
      for (const node of nodes) {
        // The turn map and lens only change their ticks; the reading column carries the motion.
        if (!node.isConnected || !timeline.contains(node)) continue;
        const inner = [...node.querySelectorAll('[data-observation-key]')].filter(part => !part.querySelector('[data-observation-key]'));
        const heading = node.matches('[data-turn-panel]') && node.querySelector(':scope > .turn-heading');
        for (const part of [...(heading ? [heading] : []), ...(inner.length ? inner : [node])]) {
          // Calls folded away arrive as their one fold line.
          const fold = part.closest('details:not([open])');
          parts.add(fold && timeline.contains(fold) ? fold : part);
        }
      }
      const ordered = [...parts].filter(part => !part.matches('.live-tail'))
        .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      const tail = timeline.querySelector('[data-turn-panel] .live-tail');
      if (!ordered.length && !parts.has(tail)) return;
      const now = performance.now(), step = Math.max(50, Math.min(ROW, 1600 / Math.max(1, ordered.length)));
      let at = Math.max(now, revealAt), last = at - FADE;
      if (at - now > BACKLOG) at = now + BACKLOG;
      for (const part of ordered) {
        reveal(part, at - now); last = at;
        at += words(part) ? WORDS : step;
      }
      revealAt = at;
      // The loading line always comes back last, once what arrived above it has settled.
      if (tail) reveal(tail, Math.max(0, last + FADE + TAIL - now));
    };
    const children = (parent, next) => {
      const old = [...parent.childNodes], used = new Set();
      const keyed = new Map(old.filter(key).map(node => [key(node), node]));
      [...next.childNodes].forEach((desired, index) => {
        const id = key(desired);
        const match = id ? keyed.get(id) : old.find(node => !used.has(node) && !key(node) && compatible(node, desired));
        const node = match && compatible(match, desired) ? match : desired.cloneNode(true);
        // A new unkeyed wrapper (a chapter's first list of calls) still brings keyed parts.
        if (node !== match && node.nodeType === 1 && (key(node) || node.querySelector('[data-observation-key]'))) arrivals.push(node);
        if (match === node) { used.add(node); morph(node, desired); }
        if (parent.childNodes[index] !== node) parent.insertBefore(node, parent.childNodes[index] || null);
      });
      old.forEach(node => { if (!used.has(node) && node.parentNode === parent) node.remove(); });
    };
    const fragment = html => { const template = document.createElement('template'); template.innerHTML = html; return template.content; };
    const patch = (target, html) => { if (target && typeof html === 'string') children(target, fragment(html)); };
    const status = document.querySelector('.observation-status');
    const problem = document.querySelector('.observation-problem');
    // Only the newest turn, still open in the source, carries data-last-at. Running
    // means records keep coming; a long silence is shown as such, a day-old one not at all.
    const QUIET = 10 * 60 * 1000, GONE = 6 * 60 * 60 * 1000;
    const span = ms => ms < 3600000 ? Math.max(1, Math.round(ms / 60000)) + ' 分钟' : Math.round(ms / 3600000) + ' 小时';
    // Claude Code publishes busy/idle for its session; when it does, that wins over any guess from silence.
    let agentState = '';
    const tickActivity = () => {
      const now = Date.now();
      const live = timeline.querySelector('[data-turn-panel][data-last-at]');
      const quiet = live ? now - Date.parse(live.dataset.lastAt) : NaN;
      let gone = !(quiet < GONE), stale = !gone && quiet > QUIET;
      if (agentState === 'busy') { gone = false; stale = false; }
      if (agentState === 'idle') { gone = true; stale = false; }
      if (live) {
        live.toggleAttribute('data-fresh', !gone); live.toggleAttribute('data-stale', stale);
        live.toggleAttribute('data-idle', agentState === 'idle');
        const verb = live.querySelector('[data-live-verb]'), since = live.querySelector('[data-since]');
        // Quiet for long: the spinner gives way to how long it has been. Otherwise the spinner says enough.
        if (verb) verb.textContent = stale ? '无新记录' : '';
        if (since) since.textContent = stale ? ' · ' + span(quiet) : '';
      }
      if (status && status.dataset.state !== 'paused') {
        const state = !live || gone ? '' : stale ? 'quiet' : 'running';
        status.dataset.state = state;
        status.textContent = state === 'running' ? '运行中' : state === 'quiet' ? '无新记录 · ' + span(quiet) : '';
      }
    };
    setInterval(tickActivity, 1000);
    const pause = text => {
      if (status) { status.textContent = '已暂停'; status.dataset.state = 'paused'; }
      if (problem) { problem.textContent = text; problem.hidden = false; }
    };
    const resync = () => {
      if (resyncPending) return;
      resyncPending = true;
      vscode.postMessage({ type: 'observerReady', streamId });
    };
    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'workspaceChanged') { scopeStopped = true; pause('工作区已改变，已停止读取。请重新选择当前项目会话。'); return; }
      if (scopeStopped) return;
      if (message.type !== 'observation' || message.streamId !== streamId || message.sessionId !== sessionId) return;
      if (!Number.isSafeInteger(message.version) || message.version <= version) return;
      if (!message.reset && message.baseVersion !== version) { resync(); return; }
      if (!Array.isArray(message.order) || !message.order.every(id => typeof id === 'string') || new Set(message.order).size !== message.order.length
        || !Array.isArray(message.turns) || !message.turns.every(turn => turn && typeof turn.key === 'string' && typeof turn.html === 'string')) return;
      const top = timeline.getBoundingClientRect().top;
      const visible = [...timeline.querySelectorAll('[data-observation-key], [data-turn-panel]')].filter(node => {
        // Content inside a closed fold has no place on screen to hold.
        if (node.closest('details:not([open])')) return false;
        const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > top;
      });
      // Prefer the innermost block crossing the viewport, then the first below.
      const anchor = visible.filter(node => node.getBoundingClientRect().top <= top).at(-1) || visible[0];
      const anchorKey = anchor && key(anchor), anchorTop = anchor && anchor.getBoundingClientRect().top;
      const oldScroll = timeline.scrollTop;
      const active = document.activeElement, activeKey = active && key(active);
      const expanded = new Set(groups().filter(group => group.open).map(group => group.dataset.actionGroup));
      const hadFocus = document.hasFocus() && active && sidecar.contains(active);
      const existing = new Map(panels().map(panel => [panel.dataset.turnPanel, panel]));
      const latestChanged = message.order[0] !== panels()[0]?.dataset.turnPanel || message.turns.some(turn => turn.key === message.order[0]);
      const wasNewest = panels()[0]?.dataset.turnPanel || '';
      const incoming = new Map();
      for (const turn of message.turns) {
        const next = fragment(turn.html).firstElementChild;
        if (!next || next.dataset.turnPanel !== turn.key) { resync(); return; }
        incoming.set(turn.key, next);
      }
      if (message.order.some(id => !existing.has(id) && !incoming.has(id))) { resync(); return; }
      patch(document.querySelector('[data-live-warnings]'), message.warnings);
      patch(document.querySelector('[data-live-empty]'), message.empty);
      for (const id of message.order) {
        const current = existing.get(id), next = incoming.get(id);
        if (current && next) morph(current, next);
      }
      const ordered = message.order.map(id => existing.get(id) || incoming.get(id));
      if (!message.reset) for (const [id, node] of incoming) if (!existing.has(id)) arrivals.push(node);
      // Work backwards so unchanged ordered nodes are never detached or moved.
      let after = null;
      for (let index = ordered.length - 1; index >= 0; index--) {
        const node = ordered[index];
        if (node.parentNode !== timeline || node.nextSibling !== after) timeline.insertBefore(node, after);
        after = node;
      }
      for (const [id, node] of existing) if (!message.order.includes(id)) node.remove();
      patch(document.querySelector('.toc-list'), message.lens);
      if (!message.reset) stagger(arrivals);
      arrivals = [];
      // A failed call can move out of an ordinary action run. Its disclosure
      // identity still denotes the same source input, so preserve reader state.
      groups().forEach(group => { group.open = expanded.has(group.dataset.actionGroup); });
      version = message.version; resyncPending = false;
      const health = message.health;
      agentState = health && (health.agent === 'busy' || health.agent === 'waiting') ? 'busy' : health && health.agent === 'idle' ? 'idle' : '';
      if (health && health.state === 'paused') pause(health.reason === 'source-changed'
        ? '会话来源发生替换或改写，已暂停；保留当前内容。可刷新后重新核验。' : '暂时无法读取会话，已暂停；保留当前内容。可刷新后重试。');
      else if (health && health.state === 'observing') {
        if (status && status.dataset.state === 'paused') status.dataset.state = '';
        if (problem) problem.hidden = true;
      }
      // A new turn: the reader on the newest one sent it, and goes on to it. Someone reading an older turn stays, with a note at the bottom.
      const arrivedTurn = !message.reset && message.order.length && !existing.has(message.order[0]) && existing.size ? message.order[0] : '';
      if (arrivedTurn && (following || selectedTurnId === wasNewest)) { selectedTurnId = arrivedTurn; resumeFollowing(); }
      else if (arrivedTurn) noticeTurnId = arrivedTurn;
      if (following) selectedTurnId = message.order[0] || selectedTurnId;
      onUpdated();
      tickActivity();
      const found = anchorKey && [...timeline.querySelectorAll('[data-observation-key], [data-turn-panel]')].find(node => key(node) === anchorKey);
      // A row just folded away is anchored by its fold line.
      const replacement = found && (found.closest('details:not([open])') || found);
      timeline.scrollTop = replacement && Number.isFinite(anchorTop) ? oldScroll + replacement.getBoundingClientRect().top - anchorTop : oldScroll;
      if (latestChanged) followLatest();
      if (hadFocus && !active.isConnected && activeKey && document.hasFocus()) {
        const target = [...sidecar.querySelectorAll('button, summary')].find(node => key(node) === activeKey);
        if (target && !target.closest('[hidden]') && !(target.tagName !== 'SUMMARY' && target.closest('details:not([open])'))) target.focus({ preventScroll: true });
      }
      persist();
    });
    tickActivity();
    resync();
  };
`;
