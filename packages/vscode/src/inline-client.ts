/** Expanded evidence is requested on demand; closed rows never embed full logs. */
export const inlineClient = `
  let inlineSerial = 0, inlineStopped = false;
  const pendingInline = new Map();
  const expandedTexts = new Set(Array.isArray(saved.expandedTextIds) ? saved.expandedTextIds.filter(id => typeof id === 'string') : []);
  const expandedInlineSections = new Set(Array.isArray(saved.expandedInlineSections) ? saved.expandedInlineSections.filter(id => typeof id === 'string') : []);
  const inlineHosts = () => [...document.querySelectorAll('[data-inline-id]')];
  const measureText = () => {
    document.querySelectorAll('[data-text-id]').forEach(block => {
      const expanded = expandedTexts.has(block.dataset.textId);
      block.classList.toggle('text-expanded', expanded);
      const button = block.querySelector('[data-toggle-text]');
      const content = block.querySelector('.narrative-preview > .markdown, .question-text > .markdown');
      const open = block.querySelector('[data-open-text]');
      if (open && content) {
        // Full text opens in the editor area, where pasted images keep their size.
        const clamped = content.scrollHeight > content.clientHeight + 2, extras = open.dataset.extras || '';
        open.hidden = !clamped && !extras;
        open.textContent = (clamped ? '查看全文' + (extras ? ' · ' + extras : '') : extras) + ' →';
      }
      if (!button || !content) return;
      button.hidden = !expanded && content.scrollHeight <= content.clientHeight + 2;
      button.setAttribute('aria-expanded', String(expanded));
      button.textContent = expanded ? '收起全文 ⌃' : '展开全文 ⌄';
    });
  };
  const loadOpenInline = () => {
    if (inlineStopped) return;
    for (const [id, request] of pendingInline) if (!request.host.isConnected || request.host.dataset.inlinePending !== id) pendingInline.delete(id);
    inlineHosts().forEach(host => {
      const disclosure = host.closest('details');
      if (!disclosure?.open || disclosure.parentElement?.closest('details:not([open])') || host.dataset.inlineLoaded || host.dataset.inlinePending) return;
      const requestId = String(++inlineSerial);
      host.dataset.inlinePending = requestId;
      pendingInline.set(requestId, { host, revision: host.dataset.inlineRevision });
      vscode.postMessage({ type: 'loadInlineEvidence', sessionId, itemId: host.dataset.inlineId, revision: host.dataset.inlineRevision, requestId });
    });
    measureText();
  };
  document.addEventListener('toggle', event => {
    const section = event.target instanceof Element && event.target.matches('details[data-inline-section]') ? event.target : null;
    const host = section && section.closest('[data-inline-id]');
    if (host) {
      const key = host.dataset.inlineId + ':' + section.dataset.inlineSection;
      if (section.open) expandedInlineSections.add(key); else expandedInlineSections.delete(key);
      persist();
    }
    if (event.target instanceof Element && event.target.matches('details')) loadOpenInline();
  }, true);
  document.addEventListener('click', event => {
    const button = event.target instanceof Element && event.target.closest('[data-toggle-text]');
    if (!button) return;
    const block = button.closest('[data-text-id]'), id = block.dataset.textId;
    if (expandedTexts.has(id)) expandedTexts.delete(id); else expandedTexts.add(id);
    measureText(); pauseFollowing(); persist();
  });
  if (typeof ResizeObserver !== 'undefined' && timeline) new ResizeObserver(measureText).observe(timeline);
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'workspaceChanged') { inlineStopped = true; pendingInline.clear(); return; }
    if (inlineStopped || message?.type !== 'inlineEvidence' || message.sessionId !== sessionId || typeof message.html !== 'string') return;
    const pending = pendingInline.get(message.requestId);
    if (!pending) return;
    pendingInline.delete(message.requestId);
    const host = pending.host;
    if (!host.isConnected || host.dataset.inlinePending !== message.requestId || host.dataset.inlineId !== message.itemId) return;
    delete host.dataset.inlinePending;
    if (host.dataset.inlineRevision !== message.revision || pending.revision !== message.revision) { return; } // A live update will retry; never loop on the same stale revision.
    host.innerHTML = message.html; host.dataset.inlineLoaded = 'true';
    host.querySelectorAll('details[data-inline-section]').forEach(section => { section.open = expandedInlineSections.has(host.dataset.inlineId + ':' + section.dataset.inlineSection); });
  });
`;
