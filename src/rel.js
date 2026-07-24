// src/rel.js — Rel (RelliK Wolf-Krow) session manager.
//
// Embeds the Claude Agent SDK in the main process to power the in-app
// assistant. Auth comes from the user's Claude subscription login (`claude
// login` OAuth credentials) — no API key. One turn runs at a time; assistant
// output streams to the Rel window via the onEvent callback supplied by
// main.js. Per-project conversations persist across app restarts through SDK
// session ids stored in the `rel_sessions` settings key.

const path = require('path');
const db = require('./db');

// The Agent SDK is ESM-only; this module is CJS. Lazy dynamic import, cached.
let _sdkPromise = null;
function loadSdk() {
  if (!_sdkPromise) _sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return _sdkPromise;
}

const DEFAULT_CONFIG = {
  chatModel: 'claude-sonnet-5',
  auditModel: 'claude-opus-4-8',
  // User preference: edits apply automatically (no approval prompts). Bash
  // stays off unless explicitly enabled — it is the one tool class that can
  // do damage outside the repo.
  allowBash: false,
};

async function getConfig() {
  const stored = await db.getSettings('rel').catch(() => null);
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function getSessionMap() {
  return (await db.getSettings('rel_sessions').catch(() => null)) || {};
}

async function saveSessionId(projectKey, sessionId) {
  const map = await getSessionMap();
  if (map[projectKey] === sessionId) return;
  map[projectKey] = sessionId;
  await db.saveSetting('rel_sessions', map).catch(() => {});
}

async function clearSessionId(projectKey) {
  const map = await getSessionMap();
  if (!(projectKey in map)) return;
  delete map[projectKey];
  await db.saveSetting('rel_sessions', map).catch(() => {});
}

// Env for the SDK's spawned CLI process. Electron (and the VS Code shell that
// may have launched us) injects ELECTRON_RUN_AS_NODE, which breaks child
// process resolution — the same failure scripts/launch.js guards against.
function childEnv(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function personaPrompt(project) {
  const projectLine = project
    ? `The active HuminLoop project is "${project.name}" at ${project.repo_path || '(no repo path set)'}.`
    : 'No HuminLoop project is currently active; general questions only until one is connected.';
  return [
    'You are RelliK Wolf-Krow — "Rel" for short — HuminLoop\'s in-app workflow assistant.',
    'HuminLoop is an ADHD-friendly knowledge-capture app for developers; you live inside it as a chat window.',
    projectLine,
    'You have the huminloop MCP tools (clips, projects, demos, workflow state) and read/edit access to the repo you were opened for.',
    'Be direct and warm. Keep answers tight — this is a chat pane, not a report. When you change files, say exactly what you changed.',
  ].join('\n');
}

const _state = {
  activeQuery: null,   // in-flight Query handle (has .interrupt())
  projectKey: null,    // key of the project the active/last turn belongs to
  busy: false,
};

function projectKeyOf(project) {
  return project && project.id != null ? String(project.id) : '_global';
}

function getStatus() {
  return { busy: _state.busy, projectKey: _state.projectKey };
}

async function interrupt() {
  const q = _state.activeQuery;
  if (!q) return false;
  try { await q.interrupt(); } catch {}
  return true;
}

// Run one conversational turn. Streams events to onEvent:
//   { kind:'status', state:'starting'|'error'|'done', detail? }
//   { kind:'text-delta', text }          — streamed assistant text
//   { kind:'tool', name }                — a tool call began
//   { kind:'assistant', text }           — completed assistant message text
//   { kind:'result', ok, sessionId, costUsd, durationMs, error? }
async function startTurn({ project, prompt, mode = 'chat' }, onEvent) {
  if (_state.busy) {
    onEvent({ kind: 'status', state: 'error', detail: 'Rel is still working on the previous message.' });
    return;
  }
  _state.busy = true;
  const projectKey = projectKeyOf(project);
  _state.projectKey = projectKey;
  onEvent({ kind: 'status', state: 'starting' });

  try {
    const resumeId = (await getSessionMap())[projectKey] || undefined;
    try {
      await runQuery({ project, prompt, mode, resumeId, projectKey }, onEvent);
    } catch (err) {
      // A stale persisted session id is the one recoverable failure — drop it
      // and retry the turn fresh instead of surfacing an opaque error.
      if (resumeId) {
        await clearSessionId(projectKey);
        await runQuery({ project, prompt, mode, resumeId: undefined, projectKey }, onEvent);
      } else {
        throw err;
      }
    }
  } catch (err) {
    onEvent({ kind: 'status', state: 'error', detail: friendlyError(err) });
    onEvent({ kind: 'result', ok: false, error: friendlyError(err) });
  } finally {
    _state.busy = false;
    _state.activeQuery = null;
  }
}

async function runQuery({ project, prompt, mode, resumeId, projectKey }, onEvent) {
  const { query } = await loadSdk();
  const config = await getConfig();

  const allowedTools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'WebSearch', 'WebFetch',
    'mcp__huminloop', 'mcp__huminloop__*'];
  if (config.allowBash) allowedTools.push('Bash');

  const apiPort = process.env.HUMINLOOP_API_PORT || '7277';
  const mcpEnv = { HUMINLOOP_API_PORT: apiPort };
  if (project && project.repo_path) {
    mcpEnv.HUMINLOOP_PROJECT_ROOT = project.repo_path;
    mcpEnv.PROJECT_ROOT = project.repo_path;
  }

  const options = {
    cwd: project && project.repo_path ? project.repo_path : undefined,
    model: mode === 'audit' ? config.auditModel : config.chatModel,
    fallbackModel: mode === 'audit' ? config.chatModel : undefined,
    permissionMode: 'acceptEdits',
    allowedTools,
    includePartialMessages: true,
    resume: resumeId,
    executable: 'node',
    env: childEnv(project),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: personaPrompt(project) },
    mcpServers: {
      huminloop: {
        type: 'stdio',
        command: 'node',
        args: [path.join(__dirname, '..', 'mcp-server', 'index.js')],
        env: mcpEnv,
      },
    },
  };

  const q = query({ prompt, options });
  _state.activeQuery = q;

  for await (const message of q) {
    switch (message.type) {
      case 'stream_event': {
        const ev = message.event;
        if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          onEvent({ kind: 'text-delta', text: ev.delta.text });
        }
        break;
      }
      case 'assistant': {
        if (message.error) {
          onEvent({ kind: 'status', state: 'error', detail: friendlyAssistantError(message.error) });
          break;
        }
        const blocks = (message.message && message.message.content) || [];
        for (const block of blocks) {
          if (block.type === 'tool_use') onEvent({ kind: 'tool', name: block.name });
        }
        const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
        if (text) onEvent({ kind: 'assistant', text });
        break;
      }
      case 'result': {
        if (message.session_id) await saveSessionId(projectKey, message.session_id);
        const ok = !message.is_error;
        onEvent({
          kind: 'result',
          ok,
          sessionId: message.session_id,
          costUsd: message.total_cost_usd,
          durationMs: message.duration_ms,
          error: ok ? undefined : (message.result || message.subtype),
        });
        onEvent({ kind: 'status', state: 'done' });
        break;
      }
      default:
        break;
    }
  }
}

function friendlyAssistantError(code) {
  switch (code) {
    case 'authentication_failed':
      return 'Not signed in to Claude. Run `claude login` in a terminal (or open Claude Code and sign in), then try again.';
    case 'billing_error':
      return 'Claude subscription issue — check your plan or usage limits.';
    case 'rate_limit':
      return 'Claude usage limit reached — try again in a bit.';
    case 'overloaded':
      return 'Claude is overloaded right now — try again shortly.';
    default:
      return `Claude error: ${code}`;
  }
}

function friendlyError(err) {
  const msg = (err && err.message) || String(err);
  if (/credential|authentication|login|401/i.test(msg)) {
    return 'Not signed in to Claude. Run `claude login` in a terminal (or open Claude Code and sign in), then try again.';
  }
  return msg;
}

module.exports = { startTurn, interrupt, getStatus, getConfig };
