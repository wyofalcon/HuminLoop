// renderer/rel.js — Rel chat window logic.
// Streams one turn at a time from main (src/rel.js) over the 'rel-event'
// channel and renders it as chat bubbles. No framework — string HTML + DOM,
// matching the rest of the renderers.

let projects = [];
let activeProjectId = null;
let busy = false;

// Streaming state for the turn in flight: the bubble receiving text deltas.
let streamBubble = null;
let streamText = '';
let toolNames = [];

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');
const toolTicker = document.getElementById('toolTicker');
const projectSelect = document.getElementById('projectSelect');

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

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function init() {
  const ctx = await window.quickclip.getRelContext();
  projects = ctx.projects || [];
  activeProjectId = ctx.projectId;

  projectSelect.innerHTML = '<option value="">No project</option>' + projects.map(p =>
    `<option value="${p.id}"${String(p.id) === String(activeProjectId) ? ' selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  const proj = projects.find(p => String(p.id) === String(activeProjectId));
  const hello = proj
    ? `Hey! I'm <strong>Rel</strong> \u{1F43A} — I can see <strong>${esc(proj.name)}</strong>${proj.repo_path ? ' and its repo' : ''}, plus your clips, demos, and workflow. What do you need?`
    : `Hey! I'm <strong>Rel</strong> \u{1F43A}. Pick a project above and I can dig into its repo, clips, and workflow — or just ask me anything.`;
  addBubble('rel', hello);
  inputEl.focus();
}

window.quickclip.onRelEvent(handleRelEvent);
init();
