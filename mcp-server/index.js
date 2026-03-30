#!/usr/bin/env node
/**
 * Sciurus MCP Server — Protocol bridge between AI IDE agents and the Sciurus Electron app.
 *
 * Architecture:
 *   Claude Code (stdio) ←→ this process ←→ Sciurus Electron app (HTTP on localhost)
 *
 * Knowledge tools call the Sciurus HTTP API.
 * Workflow tools (session, git) run locally via child_process.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ──

const API_PORT = process.env.SCIURUS_API_PORT || '7277';
const API_HOST = process.env.SCIURUS_API_HOST || '127.0.0.1';
const API_BASE = `http://${API_HOST}:${API_PORT}`;
const PROJECT_ROOT = process.env.SCIURUS_PROJECT_ROOT
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
    throw new Error(`Sciurus app not reachable at ${API_BASE} — is it running? (${e.message})`);
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

// ── Tool Definitions ──

const TOOLS = [
  // Knowledge Capture
  {
    name: 'clip_list',
    description: 'List clips from Sciurus. Filter by project_id or get unassigned clips.',
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
    description: 'Get a single Sciurus clip by ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Clip ID' } },
      required: ['id'],
    },
  },
  {
    name: 'clip_create',
    description: 'Create a new Sciurus clip (screenshot note). Provide at least a comment or image.',
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
    description: 'Update fields on a Sciurus clip.',
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
    description: 'Soft-delete a Sciurus clip (moves to trash).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'clip_complete',
    description: 'Mark a Sciurus clip as completed. Optionally archive (trash) it.',
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
    description: 'AI-powered semantic search across all Sciurus clips.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Natural language search query' } },
      required: ['query'],
    },
  },
  {
    name: 'clip_summarize',
    description: 'Generate AI fix prompts for all notes in a Sciurus project.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'number', description: 'Project ID to summarize' } },
      required: ['project_id'],
    },
  },
  {
    name: 'project_list',
    description: 'List all Sciurus projects with clip counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project_get',
    description: 'Get a Sciurus project by ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'project_create',
    description: 'Create a new Sciurus project.',
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
    description: 'List all Sciurus categories.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sciurus_health',
    description: 'Check if the Sciurus Electron app is running and get its status.',
    inputSchema: { type: 'object', properties: {} },
  },

  // Workflow — runs locally, no Sciurus HTTP call
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
];

// ── Tool Handlers ──

const HANDLERS = {
  // ── Knowledge tools → Sciurus HTTP API ──

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

  async sciurus_health() {
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
    { name: 'sciurus', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLERS[name];
    if (!handler) return errorResult(`Unknown tool: ${name}`);
    try {
      return await handler(args || {});
    } catch (e) {
      return errorResult(e.message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error('Sciurus MCP server failed to start:', e.message);
  process.exit(1);
});
