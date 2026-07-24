// renderer/rel-panel.js — Rel as an embedded chat panel inside the viewer.
//
// Ported from the old standalone rel.js (which drove a separate BrowserWindow).
// Now Rel lives docked in the bottom-right of the main window, opened by a
// floating launcher bubble. The whole file is wrapped in an IIFE so its helpers
// (esc, renderMarkdownLite, sendMessage, …) never collide with index.js, which
// defines several of the same names. It talks to main over the same IPC as
// before (get-rel-context / rel-send / rel-interrupt / rel-event), plus a new
// 'rel-open' push so the tray and Connect-IDE wizard can pop the dock.
//
// Exposes on window: openRelDock(projectId), closeRelDock(), toggleRelDock(id).
(function () {
  const dock = document.getElementById('relDock');
  const launcher = document.getElementById('relLauncher');
  if (!dock || !launcher) return; // markup missing → no-op (defensive)

  const messagesEl = document.getElementById('relMessages');
  const inputEl = document.getElementById('relInput');
  const sendBtn = document.getElementById('relSendBtn');
  const stopBtn = document.getElementById('relStopBtn');
  const statusBar = document.getElementById('relStatusBar');
  const statusText = document.getElementById('relStatusText');
  const toolTicker = document.getElementById('relToolTicker');
  const projectSelect = document.getElementById('relProjectSelect');
  const closeBtn = document.getElementById('relCloseBtn');

  let projects = [];
  let activeProjectId = null;
  let busy = false;
  let inited = false;
  let initing = null; // in-flight init promise (so concurrent opens await one init)

  // Streaming state for the turn in flight: the bubble receiving text deltas.
  let streamBubble = null;
  let streamText = '';
  let toolNames = [];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Minimal safe markdown: escape everything first, then re-introduce a few
  // formatting tags. Fenced code blocks before inline code before bold.
  function renderMarkdownLite(text) {
    let html = esc(text);
    html = html.replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    return html.replace(/\n/g, '<br>');
  }

  function addBubble(cls, html) {
    const div = document.createElement('div');
    div.className = `rel-msg ${cls}`;
    div.innerHTML = html;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function setBusy(state) {
    busy = state;
    sendBtn.disabled = state;
    stopBtn.style.display = state ? '' : 'none';
    statusBar.style.display = state ? 'flex' : 'none';
    if (!state) { toolNames = []; toolTicker.textContent = ''; }
  }

  function finalizeStreamBubble() {
    if (streamBubble && streamText) streamBubble.innerHTML = renderMarkdownLite(streamText);
    streamBubble = null;
    streamText = '';
  }

  function handleRelEvent(event) {
    switch (event.kind) {
      case 'status':
        if (event.state === 'starting') {
          statusText.textContent = 'Rel is thinking…';
        } else if (event.state === 'error') {
          finalizeStreamBubble();
          addBubble('error', renderMarkdownLite(event.detail || 'Something went wrong.'));
          setBusy(false);
        } else if (event.state === 'done') {
          setBusy(false);
        }
        break;

      case 'text-delta':
        if (!streamBubble) { streamBubble = addBubble('rel', ''); streamText = ''; }
        streamText += event.text;
        streamBubble.innerHTML = renderMarkdownLite(streamText);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;

      case 'assistant':
        // The completed message is authoritative; it closes the current stream
        // bubble (there can be several per turn, between tool calls).
        if (streamBubble) {
          streamBubble.innerHTML = renderMarkdownLite(event.text);
          streamBubble = null;
          streamText = '';
        } else {
          addBubble('rel', renderMarkdownLite(event.text));
        }
        break;

      case 'tool':
        toolNames.push(event.name.replace(/^mcp__huminloop__/, 'huminloop:'));
        toolTicker.textContent = '\u{1F527} ' + toolNames.slice(-4).join(' · ');
        break;

      case 'result':
        finalizeStreamBubble();
        if (!event.ok && event.error) addBubble('error', renderMarkdownLite(event.error));
        setBusy(false);
        break;

      case 'project-changed':
        if (event.projectId != null) {
          activeProjectId = event.projectId;
          projectSelect.value = String(event.projectId);
        }
        break;
    }
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value = '';
    addBubble('user', renderMarkdownLite(text));
    setBusy(true);
    statusText.textContent = 'Rel is thinking…';
    const pid = projectSelect.value ? parseInt(projectSelect.value, 10) : null;
    activeProjectId = pid;
    window.quickclip.relSend(pid, text);
  }

  function stopTurn() {
    window.quickclip.relInterrupt();
  }

  function projectName(id) {
    const p = projects.find((x) => String(x.id) === String(id));
    return p ? p.name : null;
  }

  // First open fetches context and paints the greeting. Subsequent opens reuse
  // the live DOM, so the conversation persists across close/reopen.
  function ensureInit() {
    if (inited) return Promise.resolve();
    if (initing) return initing;
    initing = (async () => {
      const ctx = await window.quickclip.getRelContext();
      projects = ctx.projects || [];
      if (activeProjectId == null) activeProjectId = ctx.defaultProjectId || null;

      projectSelect.innerHTML = '<option value="">No project</option>' + projects.map((p) =>
        `<option value="${p.id}"${String(p.id) === String(activeProjectId) ? ' selected' : ''}>${esc(p.name)}</option>`
      ).join('');

      const proj = projects.find((p) => String(p.id) === String(activeProjectId));
      const hello = proj
        ? `Hey! I'm <strong>Rel</strong> \u{1F43A} — I can see <strong>${esc(proj.name)}</strong>${proj.repo_path ? ' and its repo' : ''}, plus your clips, demos, and workflow. What do you need?`
        : `Hey! I'm <strong>Rel</strong> \u{1F43A}. Pick a project above and I can dig into its repo, clips, and workflow — or just ask me anything.`;
      addBubble('rel', hello);
      inited = true;
    })();
    // Don't cache a rejected promise: on a transient failure, clear it so the
    // next open retries instead of returning the same failure all session.
    initing.catch(() => { initing = null; });
    return initing;
  }

  function isOpen() { return !dock.classList.contains('hidden'); }

  async function openRelDock(projectId) {
    dock.classList.remove('hidden');
    launcher.classList.add('hidden');
    // Switching to a different project mid-session gets a hand-off note; the
    // very first open instead folds the project straight into the greeting.
    const switching = inited && projectId != null && String(projectId) !== String(activeProjectId);
    if (projectId != null) activeProjectId = projectId; // so greeting + select reflect it
    try {
      await ensureInit();
    } catch (e) {
      addBubble('error', renderMarkdownLite('Couldn’t load Rel’s context — reopen to try again.'));
      return;
    }
    if (projectId != null) projectSelect.value = String(projectId);
    if (switching) {
      const name = projectName(projectId);
      if (name) addBubble('sys', `Now looking at ${esc(name)}`);
    }
    inputEl.focus();
  }

  function closeRelDock() {
    dock.classList.add('hidden');
    launcher.classList.remove('hidden');
  }

  function toggleRelDock(projectId) {
    if (isOpen()) closeRelDock();
    else openRelDock(projectId != null ? projectId : null);
  }

  // ── Wiring ──
  launcher.addEventListener('click', () => toggleRelDock(null));
  if (closeBtn) closeBtn.addEventListener('click', closeRelDock);
  sendBtn.addEventListener('click', sendMessage);
  stopBtn.addEventListener('click', stopTurn);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  window.quickclip.onRelEvent(handleRelEvent);
  if (window.quickclip.onRelOpen) window.quickclip.onRelOpen((data) => openRelDock(data && data.projectId != null ? data.projectId : null));

  // Exposed for index.js (header button, Connect-IDE wizard) onclick handlers.
  window.openRelDock = openRelDock;
  window.closeRelDock = closeRelDock;
  window.toggleRelDock = toggleRelDock;
})();
