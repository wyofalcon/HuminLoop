#!/usr/bin/env node
/**
 * HuminLoop MCP Server — Protocol bridge between AI IDE agents and the HuminLoop Electron app.
 *
 * Architecture:
 *   Claude Code (stdio) ←→ this process ←→ HuminLoop Electron app (HTTP on localhost)
 *
 * Knowledge tools call the HuminLoop HTTP API.
 * Workflow tools (session, git) run locally via child_process.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ──

const API_PORT = process.env.HUMINLOOP_API_PORT || '7277';
const IS_CONTAINER = process.env.REMOTE_CONTAINERS === 'true'
  || process.env.CODESPACES === 'true'
  || require('fs').existsSync('/.dockerenv');
const API_HOST = process.env.HUMINLOOP_API_HOST || (IS_CONTAINER ? 'host.docker.internal' : '127.0.0.1');
const API_BASE = `http://${API_HOST}:${API_PORT}`;
const PROJECT_ROOT = process.env.HUMINLOOP_PROJECT_ROOT
  || (() => { try { return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim(); } catch { return process.cwd(); } })();

// ── HTTP helpers ──

async function api(method, path, body) {
  const url = `${API_BASE}${path}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    throw new Error(`HuminLoop app not reachable at ${API_BASE} — is it running? (${e.message})`);
  }
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

// ── MCP Tool Result helpers ──

function textResult(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function errorResult(msg) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

function imageContent(base64, mimeType = 'image/png') {
  return { type: 'image', data: base64, mimeType };
}

// ── Project Matching ──

let _cachedProject = undefined;
const _proposedThisSession = new Set();

// Canonicalize a path for cross-environment comparison. Handles:
//   - backslashes → forward slashes
//   - .code-workspace filename suffix
//   - trailing slashes
//   - WSL UNC paths from Windows: \\wsl.localhost\<distro>\... or \\wsl$\<distro>\...
//     normalize to the underlying Linux path so a Windows-side MCP and a
//     Linux-side project repo_path resolve to the same canonical form
function normalizePath(p) {
  if (!p) return '';
  let out = p.replace(/\\/g, '/').replace(/\/[^/]+\.code-workspace$/i, '').replace(/\/+$/, '');
  const wslMatch = out.match(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i);
  if (wslMatch) out = wslMatch[1] || '/';
  return out.toLowerCase();
}

async function matchProject() {
  if (_cachedProject !== undefined) return _cachedProject;
  const projects = await api('GET', '/api/projects');
  const target = normalizePath(PROJECT_ROOT);
  const match = projects.find(p => p.repo_path && normalizePath(p.repo_path) === target);
  _cachedProject = match || null;
  if (!match) proposeWorkspaceOnce(PROJECT_ROOT).catch(() => {});
  return _cachedProject;
}

async function proposeWorkspaceOnce(root) {
  const key = root.toLowerCase();
  if (_proposedThisSession.has(key)) return;
  _proposedThisSession.add(key);
  const name = root.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).pop() || 'Workspace';
  try { await api('POST', '/api/workspace/propose', { root, name }); } catch { /* viewer may be closed */ }
}

// ── IDE Heartbeat ──
// Sends a heartbeat to HuminLoop so it knows this project is actively connected.
// Called on every tool invocation. Fire-and-forget — failures are silent.
function detectAgent() {
  if (process.env.CLAUDE_CODE) return 'Claude Code';
  if (process.env.GEMINI_CLI) return 'Gemini CLI';
  if (process.env.COPILOT_AGENT) return 'Copilot';
  if (process.env.CURSOR_SESSION_ID) return 'Cursor';
  if (process.env.WINDSURF_SESSION_ID) return 'Windsurf';
  if (process.env.CLINE_TASK_ID) return 'Cline';
  if (process.env.VSCODE_PID) return 'VS Code MCP';
  return 'MCP Client';
}
const _agentName = detectAgent();

// Stable per-process session ID. PID + hostname + workspace root collides only
// across reused PIDs on the same host pointing at the same workspace, which is
// vanishingly rare. The HuminLoop API uses this to detect when a *different*
// IDE tries to claim a project that already has an active owner.
const os = require('os');
const _sessionId = `${os.hostname()}-${process.pid}-${PROJECT_ROOT.replace(/[^a-z0-9]/gi, '').slice(-16)}`;

let _heartbeatRejected = false;

async function sendHeartbeat() {
  if (_heartbeatRejected) return;
  try {
    const project = await matchProject();
    if (!project) return;
    const url = `${API_BASE}/api/projects/${project.id}/heartbeat`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ide: _agentName, session_id: _sessionId }),
    });
    if (resp.status === 409) {
      _heartbeatRejected = true;
      try {
        const data = await resp.json();
        process.stderr.write(`[HuminLoop MCP] Project already claimed by another IDE session (${data.owner_ide || 'unknown'}). Heartbeats suppressed.\n`);
      } catch {}
    }
  } catch { /* heartbeat is best-effort */ }
}

// ── Tool Definitions ──

const TOOLS = [
  // Knowledge Capture
  {
    name: 'clip_list',
    description: 'List clips from HuminLoop. Filter by project_id or get unassigned clips.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Filter by project ID' },
        unassigned: { type: 'boolean', description: 'If true, return only unassigned clips' },
      },
    },
  },
  {
    name: 'clip_get',
    description: 'Get a single HuminLoop clip by ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Clip ID' } },
      required: ['id'],
    },
  },
  {
    name: 'clip_create',
    description: 'Create a new HuminLoop clip (screenshot note). Provide at least a comment or image.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique clip ID (e.g. timestamp-based)' },
        comment: { type: 'string', description: 'Note/description' },
        category: { type: 'string', description: 'Category name (default: Uncategorized)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
        project_id: { type: 'number', description: 'Project ID to assign to' },
        window_title: { type: 'string', description: 'Source window title for context' },
        process_name: { type: 'string', description: 'Source process name' },
      },
      required: ['id'],
    },
  },
  {
    name: 'clip_update',
    description: 'Update fields on a HuminLoop clip.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Clip ID' },
        comment: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['active', 'parked'] },
        project_id: { type: 'number' },
        category: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'clip_delete',
    description: 'Soft-delete a HuminLoop clip (moves to trash).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'clip_complete',
    description: 'Mark a HuminLoop clip as completed. Optionally archive (trash) it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        archive: { type: 'boolean', description: 'Also move to trash after completing' },
      },
      required: ['id'],
    },
  },
  {
    name: 'clip_search',
    description: 'AI-powered semantic search across all HuminLoop clips.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Natural language search query' } },
      required: ['query'],
    },
  },
  {
    name: 'clip_summarize',
    description: 'Generate AI fix prompts for all notes in a HuminLoop project.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'number', description: 'Project ID to summarize' } },
      required: ['project_id'],
    },
  },
  {
    name: 'clip_combine_prompt',
    description: 'Combine multiple HuminLoop clips into a single unified AI prompt.',
    inputSchema: {
      type: 'object',
      properties: { clip_ids: { type: 'array', items: { type: 'number' }, description: 'Array of clip IDs to combine' } },
      required: ['clip_ids'],
    },
  },
  {
    name: 'project_list',
    description: 'List all HuminLoop projects with clip counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project_get',
    description: 'Get a HuminLoop project by ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'project_create',
    description: 'Create a new HuminLoop project.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        repo_path: { type: 'string', description: 'Local repo path for auto-matching' },
        color: { type: 'string', description: 'Hex color (e.g. #3b82f6)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'category_list',
    description: 'List all HuminLoop categories.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'huminloop_health',
    description: 'Check if the HuminLoop Electron app is running and get its status.',
    inputSchema: { type: 'object', properties: {} },
  },

  // Workflow — runs locally, no HuminLoop HTTP call
  {
    name: 'session_context',
    description: 'Gather current git state and project context for the working directory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_read',
    description: 'Read the contents of .ai-workflow/context/SESSION.md from the project.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_status',
    description: 'Get comprehensive git status with branch, staged/unstaged changes, and ahead/behind counts.',
    inputSchema: { type: 'object', properties: {} },
  },

  // Project-Workspace Bridge
  {
    name: 'project_match',
    description: 'Auto-match the current workspace to a HuminLoop project by repo_path. Returns project info plus workflow context (SESSION.md, AUDIT_LOG.md).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pending_prompt',
    description: 'Read a pending IDE prompt staged by HuminLoop. Returns prompt text and optional screenshot image. Files are cleared after reading (one-shot delivery).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clip_get_prompt',
    description: 'Get the AI fix prompt (and optional screenshot) for a specific clip, or the latest clip with a prompt for the matched project.',
    inputSchema: {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Specific clip ID. If omitted, gets the latest clip with a prompt for the matched project.' },
        include_image: { type: 'boolean', description: 'Include the clip screenshot as an image (default: false)' },
      },
    },
  },
];

// ── Tool Handlers ──

const HANDLERS = {
  // ── Knowledge tools → HuminLoop HTTP API ──

  async clip_list(args) {
    const params = new URLSearchParams();
    if (args.project_id) params.set('project_id', args.project_id);
    if (args.unassigned) params.set('unassigned', 'true');
    const qs = params.toString();
    return textResult(await api('GET', `/api/clips${qs ? '?' + qs : ''}`));
  },

  async clip_get(args) {
    return textResult(await api('GET', `/api/clips/${encodeURIComponent(args.id)}`));
  },

  async clip_create(args) {
    const clip = {
      id: args.id,
      comment: args.comment || '',
      category: args.category || 'Uncategorized',
      tags: args.tags || [],
      project_id: args.project_id || null,
      window_title: args.window_title || null,
      process_name: args.process_name || null,
      timestamp: Date.now(),
      status: 'parked',
    };
    return textResult(await api('POST', '/api/clips', clip));
  },

  async clip_update(args) {
    const { id, ...updates } = args;
    return textResult(await api('PATCH', `/api/clips/${encodeURIComponent(id)}`, updates));
  },

  async clip_delete(args) {
    return textResult(await api('DELETE', `/api/clips/${encodeURIComponent(args.id)}`));
  },

  async clip_complete(args) {
    return textResult(await api('POST', `/api/clips/${encodeURIComponent(args.id)}/complete`, { archive: args.archive || false }));
  },

  async clip_search(args) {
    return textResult(await api('POST', '/api/ai/search', { query: args.query }));
  },

  async clip_summarize(args) {
    return textResult(await api('POST', '/api/ai/summarize', { project_id: args.project_id }));
  },

  async clip_combine_prompt(args) {
    return textResult(await api('POST', '/api/ai/combine', { clipIds: args.clip_ids }));
  },

  async project_list() {
    return textResult(await api('GET', '/api/projects'));
  },

  async project_get(args) {
    return textResult(await api('GET', `/api/projects/${args.id}`));
  },

  async project_create(args) {
    return textResult(await api('POST', '/api/projects', args));
  },

  async category_list() {
    return textResult(await api('GET', '/api/categories'));
  },

  async huminloop_health() {
    return textResult(await api('GET', '/api/health'));
  },

  // ── Workflow tools — run locally ──

  async session_context() {
    const git = (cmd) => { try { return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim(); } catch { return ''; } };

    const branch = git('git rev-parse --abbrev-ref HEAD');
    const lastCommit = git('git log --oneline -1');
    const recentCommits = git('git log --oneline -5');
    const status = git('git status --porcelain');
    const ahead = git('git rev-list @{u}..HEAD --count 2>/dev/null') || '0';
    const behind = git('git rev-list HEAD..@{u} --count 2>/dev/null') || '0';

    const staged = status.split('\n').filter(l => l && !l.startsWith('?') && !l.startsWith(' ')).length;
    const unstaged = status.split('\n').filter(l => l && l[1] === 'M').length;
    const untracked = status.split('\n').filter(l => l.startsWith('??')).length;

    return textResult({
      project_root: PROJECT_ROOT,
      branch,
      last_commit: lastCommit,
      recent_commits: recentCommits.split('\n').filter(Boolean),
      staged,
      unstaged,
      untracked,
      ahead: parseInt(ahead, 10),
      behind: parseInt(behind, 10),
    });
  },

  async session_read() {
    const sessionPath = path.join(PROJECT_ROOT, '.ai-workflow', 'context', 'SESSION.md');
    try {
      return textResult(fs.readFileSync(sessionPath, 'utf-8'));
    } catch {
      return textResult('No SESSION.md found at ' + sessionPath);
    }
  },

  // ── Project-Workspace Bridge tools ──

  async project_match() {
    const project = await matchProject();
    if (!project) return textResult({ matched: false, project_root: PROJECT_ROOT, message: 'No HuminLoop project matches this workspace. Create one with a repo_path matching: ' + PROJECT_ROOT });

    // Read local workflow context files
    const ctxDir = path.join(PROJECT_ROOT, '.ai-workflow', 'context');
    let session = null, auditLog = null;
    try { session = fs.readFileSync(path.join(ctxDir, 'SESSION.md'), 'utf-8').trim(); } catch {}
    try { auditLog = fs.readFileSync(path.join(ctxDir, 'AUDIT_LOG.md'), 'utf-8').trim(); } catch {}

    return textResult({ matched: true, project, session, auditLog });
  },

  async get_pending_prompt() {
    const ctxDir = path.join(PROJECT_ROOT, '.ai-workflow', 'context');

    // Scan for queued prompt files (FIFO — oldest first by filename)
    let promptFiles = [];
    try {
      const files = fs.readdirSync(ctxDir);
      promptFiles = files
        .filter(f => f.startsWith('IDE_PROMPT_') && f.endsWith('.md'))
        .sort(); // alphabetical = chronological due to timestamp in name
    } catch {
      // directory may not exist
    }

    // Also check legacy single file
    const legacyPath = path.join(ctxDir, 'IDE_PROMPT.md');
    const hasLegacy = fs.existsSync(legacyPath);

    if (promptFiles.length === 0 && !hasLegacy) {
      return textResult('No pending IDE prompt found. Use HuminLoop to send a prompt to IDE first.');
    }

    let promptPath, imagePath, promptId;

    if (promptFiles.length > 0) {
      // Use oldest queued file
      const fileName = promptFiles[0];
      promptPath = path.join(ctxDir, fileName);
      // Extract safe ID from filename: IDE_PROMPT_{safeId}.md
      const safeId = fileName.replace('IDE_PROMPT_', '').replace('.md', '');
      promptId = safeId;
      imagePath = path.join(ctxDir, `ide-prompt-image-${safeId}.png`);
    } else {
      // Legacy single file
      promptPath = legacyPath;
      imagePath = path.join(ctxDir, 'ide-prompt-image.png');
      promptId = null;
    }

    let promptText;
    try {
      promptText = fs.readFileSync(promptPath, 'utf-8');
    } catch {
      return textResult('No pending IDE prompt found.');
    }

    const content = [{ type: 'text', text: promptText }];

    // Include image if it exists
    try {
      const imgBuf = fs.readFileSync(imagePath);
      content.push(imageContent(imgBuf.toString('base64'), 'image/png'));
    } catch {}

    // Clean up (one-shot delivery)
    try { fs.unlinkSync(promptPath); } catch {}
    try { fs.unlinkSync(imagePath); } catch {}

    // Update prompt status to SENT via API
    if (promptId) {
      const idMatch = promptText.match(/^## Prompt ID: (.+)$/m);
      if (idMatch) {
        try {
          await api('PATCH', `/api/workflow/prompts/${encodeURIComponent(idMatch[1])}`, { status: 'SENT' });
        } catch (e) {
          console.error('[MCP] Failed to update prompt status:', e.message);
        }
      }
    }

    return { content };
  },

  async clip_get_prompt(args) {
    let clip;
    if (args.clip_id) {
      clip = await api('GET', `/api/clips/${encodeURIComponent(args.clip_id)}`);
    } else {
      // Find latest clip with a prompt for the matched project
      const project = await matchProject();
      if (!project) return errorResult('No HuminLoop project matches this workspace. Provide a clip_id or set up a project with repo_path.');
      const clips = await api('GET', `/api/clips?project_id=${project.id}`);
      clip = [...clips].reverse().find(c => c.aiFixPrompt);
      if (!clip) return textResult('No clips with AI prompts found for project: ' + project.name);
    }

    if (!clip.aiFixPrompt) return textResult('This clip has no AI fix prompt yet.');

    const content = [{ type: 'text', text: clip.aiFixPrompt }];

    if (args.include_image) {
      try {
        const imgData = await api('GET', `/api/clips/${encodeURIComponent(clip.id)}/image`);
        if (imgData.image) {
          const base64 = imgData.image.replace(/^data:image\/\w+;base64,/, '');
          content.push(imageContent(base64, 'image/png'));
        }
      } catch {}
    }

    return { content };
  },

  async git_status() {
    const git = (cmd) => { try { return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim(); } catch { return ''; } };

    const branch = git('git rev-parse --abbrev-ref HEAD');
    const status = git('git status --porcelain');
    const ahead = git('git rev-list @{u}..HEAD --count 2>/dev/null') || '0';
    const behind = git('git rev-list HEAD..@{u} --count 2>/dev/null') || '0';
    const lastCommit = git('git log --oneline -1');
    const dirty = status.length > 0;

    const lines = status.split('\n').filter(Boolean);
    const staged = lines.filter(l => 'MADRCU'.includes(l[0]) && l[0] !== '?').map(l => l.slice(3));
    const modified = lines.filter(l => l[1] === 'M').map(l => l.slice(3));
    const untracked = lines.filter(l => l.startsWith('??')).map(l => l.slice(3));

    let recommended_action = 'none';
    if (dirty && staged.length > 0) recommended_action = 'commit';
    else if (!dirty && parseInt(ahead, 10) > 0) recommended_action = 'push';
    else if (!dirty && parseInt(behind, 10) > 0) recommended_action = 'pull';

    return textResult({
      branch,
      last_commit: lastCommit,
      dirty,
      staged_files: staged,
      modified_files: modified,
      untracked_files: untracked,
      ahead: parseInt(ahead, 10),
      behind: parseInt(behind, 10),
      recommended_action,
    });
  },
};

// ── Server Setup ──

async function main() {
  const server = new Server(
    { name: 'huminloop', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLERS[name];
    if (!handler) return errorResult(`Unknown tool: ${name}`);
    try {
      // Send heartbeat on every tool call (fire-and-forget)
      sendHeartbeat();
      return await handler(args || {});
    } catch (e) {
      return errorResult(e.message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error('HuminLoop MCP server failed to start:', e.message);
  process.exit(1);
});
