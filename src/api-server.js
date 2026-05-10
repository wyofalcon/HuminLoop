/**
 * HuminLoop — Local HTTP API Server
 * Mirrors IPC handlers so external tools (MCP servers, CLIs) can access HuminLoop.
 * Binds to 127.0.0.1 only — localhost access only, no auth needed.
 *
 * Usage: called from main.js after DB and AI are initialized.
 *   const { startApiServer } = require('./api-server');
 *   startApiServer({ db, ai, rules, images, sanitizeUpdates, autoCategorize, addAuditEntry });
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const workflowContext = require('./workflow-context');

// Normalize repo_path: strip quotes from "Copy as Path", strip .code-workspace
// filename, and canonicalize WSL UNC paths (\\wsl.localhost\<distro>\... or
// \\wsl$\<distro>\...) to their underlying Linux path.
function normalizeRepoPath(p) {
  if (!p) return p;
  p = p.replace(/^["']|["']$/g, '').trim();
  p = p.replace(/[\\/][^\\/]+\.code-workspace$/i, '');
  const wslMatch = p.replace(/\\/g, '/').match(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i);
  if (wslMatch) p = wslMatch[1] || '/';
  return p;
}

const PORT = parseInt(process.env.HUMINLOOP_API_PORT || '7277', 10);

// ── Route Matching ──

/**
 * Simple route matcher. Supports :param placeholders.
 * Returns { params } on match, null otherwise.
 */
function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return { params };
}

/** Parse JSON request body. */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** Send JSON response. */
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Send error response. */
function error(res, message, status = 400) {
  json(res, { error: message }, status);
}

// ── Server ──

// ── IDE Heartbeat Tracking ──
const ideHeartbeats = new Map(); // projectId → { lastSeen: timestamp, ide: string }
const HEARTBEAT_TIMEOUT = 60_000; // 60 seconds
const HEARTBEAT_CHECK_INTERVAL = 15_000;

function startApiServer(deps) {
  const { db, ai, rules, images, sanitizeUpdates, autoCategorize, addAuditEntry } = deps;
  const { notifyMainWindow, proposeWorkspace, showMainWindow, initWorkflow } = deps;

  // Resolve a project's repo_path from a query string (?projectId=N).
  // Returns { project, repoPath } or sends 400/404 and returns null.
  async function resolveProjectFromQuery(url, res) {
    const projectId = parseInt(url.searchParams.get('projectId'), 10);
    if (!projectId) { error(res, 'projectId query parameter required'); return null; }
    const project = await db.getProject(projectId);
    if (!project) { error(res, 'Project not found', 404); return null; }
    if (!project.repo_path) { error(res, 'Project has no repo_path', 422); return null; }
    return { project, repoPath: project.repo_path };
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers for local dev tools
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;
    const method = req.method;
    let m; // route match

    try {
      // ── Health ──
      if (method === 'GET' && pathname === '/api/health') {
        const pkg = require('../package.json');
        return json(res, {
          status: 'ok',
          db: db.getBackendName(),
          ai: ai.isEnabled(),
          version: pkg.version,
        });
      }

      // ── Clips ──

      // GET /api/clips/trash — must come before /api/clips/:id
      if (method === 'GET' && pathname === '/api/clips/trash') {
        return json(res, await db.getTrash());
      }

      if (method === 'GET' && pathname === '/api/clips') {
        const projectId = url.searchParams.get('project_id');
        const unassigned = url.searchParams.get('unassigned');
        if (unassigned === 'true') return json(res, await db.getClips(null));
        if (projectId) return json(res, await db.getClips(parseInt(projectId, 10)));
        return json(res, await db.getClips());
      }

      if (method === 'POST' && pathname === '/api/clips') {
        const clip = await parseBody(req);
        if (!clip || typeof clip.id !== 'string') return error(res, 'clip.id required');

        // Save image to disk if provided
        const imageData = clip.image;
        if (imageData && imageData !== '__on_disk__') {
          images.saveImage(clip.id, imageData);
          clip.image = '__on_disk__';
        }

        // Rule-based categorization
        if (clip.category === 'Uncategorized' || !clip.project_id) {
          const ruleResult = await rules.categorize(clip.window_title, clip.process_name, clip.comment);
          if (clip.category === 'Uncategorized' && ruleResult.category) clip.category = ruleResult.category;
          if (!clip.project_id && ruleResult.projectId) clip.project_id = ruleResult.projectId;
        }

        await db.saveClip(clip);
        addAuditEntry('create', `Clip created via API: "${(clip.comment || '(screenshot)').slice(0, 50)}"`);

        // Background AI categorization
        if ((clip.comment || imageData) && ai.isEnabled()) {
          autoCategorize(clip.id, clip.comment || '', imageData, clip.window_title, clip.process_name)
            .catch(e => console.error('[HuminLoop API] Auto-categorize error:', e.message));
        }
        return json(res, { success: true, id: clip.id }, 201);
      }

      // POST /api/clips/:id/complete
      if (method === 'POST' && (m = matchRoute('/api/clips/:id/complete', pathname))) {
        const body = await parseBody(req);
        const updates = { completed_at: new Date().toISOString() };
        if (body.archive) {
          await db.updateClip(m.params.id, updates);
          await db.deleteClip(m.params.id);
          addAuditEntry('complete', `Clip completed + trashed via API: ${m.params.id}`);
        } else {
          await db.updateClip(m.params.id, updates);
          addAuditEntry('complete', `Clip completed via API: ${m.params.id}`);
        }
        return json(res, { success: true });
      }

      // POST /api/clips/:id/uncomplete
      if (method === 'POST' && (m = matchRoute('/api/clips/:id/uncomplete', pathname))) {
        await db.updateClip(m.params.id, { completed_at: null });
        return json(res, { success: true });
      }

      // POST /api/clips/:id/restore
      if (method === 'POST' && (m = matchRoute('/api/clips/:id/restore', pathname))) {
        await db.restoreClip(m.params.id);
        return json(res, { success: true });
      }

      // GET /api/clips/:id/image — serve clip screenshot as data URL
      if (method === 'GET' && (m = matchRoute('/api/clips/:id/image', pathname))) {
        const dataUrl = images.loadImage(m.params.id);
        if (!dataUrl) return error(res, 'Image not found', 404);
        return json(res, { image: dataUrl });
      }

      // POST /api/clips/:id/send-to-ide — stage prompt + image in project workspace
      if (method === 'POST' && (m = matchRoute('/api/clips/:id/send-to-ide', pathname))) {
        const clip = await db.getClip(m.params.id);
        if (!clip) return error(res, 'Clip not found', 404);
        if (!clip.aiFixPrompt) return error(res, 'Clip has no AI prompt yet');
        if (!clip.project_id) return error(res, 'Clip not assigned to a project');
        const project = await db.getProject(clip.project_id);
        if (!project || !project.repo_path) return error(res, 'Project has no repo_path');

        const contextDir = path.join(project.repo_path, '.ai-workflow', 'context');
        if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });

        // Write prompt
        fs.writeFileSync(path.join(contextDir, 'IDE_PROMPT.md'), clip.aiFixPrompt, 'utf8');

        // Write image if available
        const body = await parseBody(req);
        if (body.include_image !== false) {
          const dataUrl = images.loadImage(m.params.id);
          if (dataUrl) {
            const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(path.join(contextDir, 'ide-prompt-image.png'), Buffer.from(base64, 'base64'));
          }
        }

        await db.updateClip(m.params.id, { sent_to_ide_at: new Date().toISOString() });
        addAuditEntry('send-to-ide', `Clip ${m.params.id} prompt staged for IDE at ${project.repo_path}`);
        return json(res, { success: true, path: project.repo_path });
      }

      // DELETE /api/clips/:id/permanent
      if (method === 'DELETE' && (m = matchRoute('/api/clips/:id/permanent', pathname))) {
        images.deleteImage(m.params.id);
        await db.permanentDeleteClip(m.params.id);
        return json(res, { success: true });
      }

      // GET /api/clips/:id
      if (method === 'GET' && (m = matchRoute('/api/clips/:id', pathname))) {
        const clip = await db.getClip(m.params.id);
        if (!clip) return error(res, 'Clip not found', 404);
        return json(res, clip);
      }

      // PATCH /api/clips/:id
      if (method === 'PATCH' && (m = matchRoute('/api/clips/:id', pathname))) {
        const updates = await parseBody(req);
        const safe = sanitizeUpdates(updates);
        await db.updateClip(m.params.id, safe);
        addAuditEntry('update', `Clip ${m.params.id} updated via API: ${Object.keys(safe).join(', ')}`);
        return json(res, { success: true });
      }

      // DELETE /api/clips/:id
      if (method === 'DELETE' && (m = matchRoute('/api/clips/:id', pathname))) {
        await db.deleteClip(m.params.id);
        addAuditEntry('delete', `Clip trashed via API: ${m.params.id}`);
        return json(res, { success: true });
      }

      // ── Projects ──

      if (method === 'GET' && pathname === '/api/projects') {
        return json(res, await db.getProjects());
      }

      if (method === 'POST' && pathname === '/api/projects') {
        const data = await parseBody(req);
        if (data.repo_path) data.repo_path = normalizeRepoPath(data.repo_path);
        const project = await db.createProject(data);
        rules.invalidateCache();
        return json(res, project, 201);
      }

      if (method === 'GET' && (m = matchRoute('/api/projects/:id', pathname))) {
        const project = await db.getProject(parseInt(m.params.id, 10));
        if (!project) return error(res, 'Project not found', 404);
        return json(res, project);
      }

      if (method === 'PATCH' && (m = matchRoute('/api/projects/:id', pathname))) {
        const data = await parseBody(req);
        if (data.repo_path) data.repo_path = normalizeRepoPath(data.repo_path);
        const project = await db.updateProject(parseInt(m.params.id, 10), data);
        rules.invalidateCache();
        return json(res, project);
      }

      if (method === 'DELETE' && (m = matchRoute('/api/projects/:id', pathname))) {
        await db.deleteProject(parseInt(m.params.id, 10));
        rules.invalidateCache();
        return json(res, { success: true });
      }

      // ── Workspace Auto-Register Proposal ──

      if (method === 'POST' && pathname === '/api/workspace/propose') {
        if (!proposeWorkspace) return error(res, 'Workspace proposals not available', 503);
        const body = await parseBody(req);
        const result = await proposeWorkspace({ root: body.root, name: body.name });
        return json(res, result);
      }

      if (method === 'POST' && pathname === '/api/window/show') {
        const ok = showMainWindow ? showMainWindow() : false;
        return json(res, { shown: !!ok });
      }

      // ── IDE Heartbeat ──
      // One IDE session may own a project at a time. The MCP server sends a stable
      // session_id derived from PID + hostname + workspace root. If a different
      // session_id heartbeats while the current owner is still recent (< 60s), we
      // reject with 409 so the second IDE knows it's a duplicate.

      if (method === 'POST' && (m = matchRoute('/api/projects/:id/heartbeat', pathname))) {
        const projectId = parseInt(m.params.id, 10);
        const project = await db.getProject(projectId);
        if (!project) return error(res, 'Project not found', 404);
        const body = await parseBody(req);
        const ide = body.ide || 'unknown';
        const sessionId = body.session_id || null;

        const now = Date.now();
        const existing = ideHeartbeats.get(projectId);
        const ownerSession = project.active_session_id || existing?.sessionId || null;
        const ownerFresh = existing && (now - existing.lastSeen) < HEARTBEAT_TIMEOUT;

        if (sessionId && ownerSession && ownerSession !== sessionId && ownerFresh) {
          if (notifyMainWindow) {
            notifyMainWindow('ide-collision', {
              project_id: projectId,
              project_name: project.name,
              owner_ide: existing?.ide || project.ide,
              rejected_ide: ide,
            });
          }
          return json(res, {
            error: 'project_busy',
            owner_session_id: ownerSession,
            owner_ide: existing?.ide || project.ide,
            message: `Project ${projectId} is already claimed by another IDE session.`,
          }, 409);
        }

        ideHeartbeats.set(projectId, { lastSeen: now, ide, sessionId });
        const updates = {
          last_heartbeat_at: new Date(now).toISOString(),
          active_session_id: sessionId,
        };
        if (!project.active_in_ide || project.ide !== ide) {
          updates.active_in_ide = true;
          updates.ide = ide;
        }
        await db.updateProject(projectId, updates);
        if (notifyMainWindow) notifyMainWindow('projects-changed');
        return json(res, { ok: true, active_in_ide: true, session_id: sessionId });
      }

      if (method === 'GET' && pathname === '/api/ide/connections') {
        const connections = [];
        for (const [pid, info] of ideHeartbeats) {
          const age = Date.now() - info.lastSeen;
          if (age < HEARTBEAT_TIMEOUT) connections.push({ project_id: pid, ide: info.ide, session_id: info.sessionId || null, age_ms: age });
        }
        return json(res, connections);
      }

      // ── Categories ──

      if (method === 'GET' && pathname === '/api/categories') {
        return json(res, await db.getCategories());
      }

      // ── Settings ──

      if (method === 'GET' && pathname === '/api/settings') {
        return json(res, await db.getAllSettings());
      }

      if (method === 'GET' && (m = matchRoute('/api/settings/:key', pathname))) {
        return json(res, await db.getSettings(m.params.key));
      }

      if (method === 'PUT' && (m = matchRoute('/api/settings/:key', pathname))) {
        const body = await parseBody(req);
        await db.saveSetting(m.params.key, body.value !== undefined ? body.value : body);
        return json(res, { success: true });
      }

      // ── AI ──

      if (method === 'GET' && pathname === '/api/ai/status') {
        return json(res, { enabled: ai.isEnabled() });
      }

      if (method === 'POST' && pathname === '/api/ai/search') {
        const { query } = await parseBody(req);
        if (!query) return error(res, 'query required');
        const clips = await db.getClips();
        const results = await ai.search(query, clips);
        return json(res, { results });
      }

      if (method === 'POST' && pathname === '/api/ai/summarize') {
        const { project_id } = await parseBody(req);
        if (!project_id) return error(res, 'project_id required');

        const projectClips = await db.getClips(parseInt(project_id, 10));
        const missing = projectClips.filter(c => !c.aiFixPrompt && (c.comment || c.image));

        if (missing.length > 0 && ai.isEnabled()) {
          const notesWithImages = missing.map(c => {
            const raw = images.loadImage(c.id);
            return { id: c.id, comment: c.comment || '', imageDataURL: raw ? images.compressForAI(raw) : null };
          });
          const generated = await ai.summarizeNotes(notesWithImages);
          for (const item of generated) {
            const clip = projectClips.find(c => c.id === item.id);
            if (clip && item.summary) {
              clip.aiFixPrompt = item.summary;
              const newCount = (clip.summarizeCount || 0) + 1;
              clip.summarizeCount = newCount;
              await db.updateClip(clip.id, { aiFixPrompt: item.summary, summarize_count: newCount });
            }
          }
        }

        return json(res, projectClips.map(c => ({
          id: c.id, comment: c.comment || '', aiSummary: c.aiSummary || '',
          aiFixPrompt: c.aiFixPrompt || '', category: c.category || '',
          tags: c.tags || [], timestamp: c.timestamp, summarizeCount: c.summarizeCount || 0,
        })));
      }

      if (method === 'POST' && pathname === '/api/ai/combine') {
        const { clipIds } = await parseBody(req);
        if (!Array.isArray(clipIds) || clipIds.length === 0) return error(res, 'clipIds array required');

        const allClips = await db.getClips();
        const selected = allClips.filter(c => clipIds.includes(c.id));
        if (selected.length === 0) return error(res, 'No matching clips found');

        const notes = selected.map(c => {
          const raw = images.loadImage(c.id);
          return { id: c.id, comment: c.comment || '', imageDataURL: raw ? images.compressForAI(raw) : null };
        });

        const prompt = await ai.generateCombinedPrompt(notes);
        return json(res, { prompt });
      }

      if (method === 'POST' && pathname === '/api/ai/combine-and-send') {
        const { clipIds, project_id } = await parseBody(req);
        if (!Array.isArray(clipIds) || clipIds.length === 0) return error(res, 'clipIds array required');
        if (!project_id) return error(res, 'project_id required');
        const project = await db.getProject(parseInt(project_id, 10));
        if (!project || !project.repo_path) return error(res, 'Project has no repo_path');

        const allClips = await db.getClips();
        const selected = allClips.filter(c => clipIds.includes(c.id));
        if (selected.length === 0) return error(res, 'No matching clips found');

        const notes = selected.map(c => {
          const raw = images.loadImage(c.id);
          return { id: c.id, comment: c.comment || '', imageDataURL: raw ? images.compressForAI(raw) : null };
        });

        const prompt = await ai.generateCombinedPrompt(notes);
        if (!prompt) return error(res, 'AI prompt generation failed');

        const contextDir = path.join(project.repo_path, '.ai-workflow', 'context');
        if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });
        fs.writeFileSync(path.join(contextDir, 'IDE_PROMPT.md'), prompt, 'utf8');

        const sentAt = new Date().toISOString();
        for (const c of selected) {
          await db.updateClip(c.id, { sent_to_ide_at: sentAt });
        }
        addAuditEntry('send-to-ide', `Combined ${selected.length} clips staged for IDE at ${project.repo_path}`);
        return json(res, { success: true, prompt, path: project.repo_path });
      }

      // ── Workflow (per-project) ──
      // All /api/workflow/* endpoints require ?projectId=N. The handlers resolve
      // the project's repo_path and read from {repo_path}/.ai-workflow/context/.

      if (method === 'GET' && pathname === '/api/workflow/status') {
        const ctx = await resolveProjectFromQuery(url, res);
        if (!ctx) return;
        return json(res, {
          relayMode: workflowContext.readRelayMode(ctx.repoPath),
          auditMode: workflowContext.readAuditMode(ctx.repoPath),
          session: workflowContext.readSessionContext(ctx.repoPath),
          hasWorkflow: workflowContext.hasWorkflow(ctx.repoPath),
        });
      }

      if (method === 'GET' && pathname === '/api/workflow/changelog') {
        const ctx = await resolveProjectFromQuery(url, res);
        if (!ctx) return;
        return json(res, { content: workflowContext.readChangelog(ctx.repoPath) });
      }

      if (method === 'GET' && pathname === '/api/workflow/prompts') {
        const ctx = await resolveProjectFromQuery(url, res);
        if (!ctx) return;
        return json(res, workflowContext.readAllPrompts(ctx.repoPath));
      }

      if (method === 'GET' && pathname === '/api/workflow/audits') {
        const ctx = await resolveProjectFromQuery(url, res);
        if (!ctx) return;
        return json(res, { content: workflowContext.readAuditFindings(ctx.repoPath) });
      }

      if (method === 'POST' && (m = matchRoute('/api/projects/:id/toggle-relay-mode', pathname))) {
        const project = await db.getProject(parseInt(m.params.id, 10));
        if (!project?.repo_path) return error(res, 'Project has no repo_path', 422);
        const current = workflowContext.readRelayMode(project.repo_path);
        const next = current === 'auto' ? 'review' : 'auto';
        workflowContext.setRelayMode(project.repo_path, next);
        return json(res, { mode: next });
      }

      if (method === 'POST' && (m = matchRoute('/api/projects/:id/toggle-audit-watch', pathname))) {
        const project = await db.getProject(parseInt(m.params.id, 10));
        if (!project?.repo_path) return error(res, 'Project has no repo_path', 422);
        const current = workflowContext.readAuditMode(project.repo_path);
        const next = current === 'on' ? 'off' : 'on';
        workflowContext.setAuditMode(project.repo_path, next);
        return json(res, { mode: next });
      }

      if (method === 'POST' && (m = matchRoute('/api/projects/:id/init-workflow', pathname))) {
        if (!initWorkflow) return error(res, 'init-workflow not available', 503);
        const result = await initWorkflow(parseInt(m.params.id, 10));
        return json(res, result);
      }

      // PATCH /api/workflow/prompts/:id — update prompt status. Scans all projects'
      // PROMPT_TRACKER.log files for the given prompt id; first match wins.
      if (method === 'PATCH' && (m = matchRoute('/api/workflow/prompts/:id', pathname))) {
        const body = await parseBody(req);
        const newStatus = body.status;
        if (!newStatus) return error(res, 'status required');

        const validStatuses = ['CRAFTED', 'BUNDLED', 'SENT', 'BUILDING', 'DONE', 'FAILED', 'QUEUED'];
        if (!validStatuses.includes(newStatus)) return error(res, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);

        const promptId = decodeURIComponent(m.params.id);
        const projects = await db.getProjects();
        for (const p of projects) {
          if (!p.repo_path) continue;
          if (workflowContext.updatePromptTracker(p.repo_path, promptId, newStatus, body.files)) {
            return json(res, { success: true, id: promptId, status: newStatus, project_id: p.id });
          }
        }
        return error(res, 'Prompt not found in any project tracker', 404);
      }

      // ── 404 ──
      error(res, `Not found: ${method} ${pathname}`, 404);

    } catch (e) {
      console.error(`[HuminLoop API] ${method} ${pathname} error:`, e.message);
      error(res, e.message, 500);
    }
  });

  // Expire stale IDE heartbeats
  setInterval(async () => {
    const now = Date.now();
    for (const [pid, info] of ideHeartbeats) {
      if (now - info.lastSeen >= HEARTBEAT_TIMEOUT) {
        ideHeartbeats.delete(pid);
        try {
          const project = await db.getProject(pid);
          if (project && project.active_in_ide) {
            await db.updateProject(pid, { active_in_ide: false, ide: null, active_session_id: null });
            if (notifyMainWindow) notifyMainWindow('projects-changed');
            console.log(`[HuminLoop API] IDE heartbeat expired for project ${pid}`);
          }
        } catch (e) {
          console.error(`[HuminLoop API] Heartbeat expiry error for project ${pid}:`, e.message);
        }
      }
    }
  }, HEARTBEAT_CHECK_INTERVAL);

  // On startup, clear any stale active_in_ide flags left from before heartbeat system
  (async () => {
    try {
      const projects = await db.getProjects();
      for (const p of projects) {
        if (p.active_in_ide && !ideHeartbeats.has(p.id)) {
          await db.updateProject(p.id, { active_in_ide: false, ide: null, active_session_id: null });
          console.log(`[HuminLoop API] Cleared stale IDE flag for project ${p.id} (${p.name})`);
        }
      }
      if (notifyMainWindow) notifyMainWindow('projects-changed');
    } catch (e) {
      console.error('[HuminLoop API] Stale IDE cleanup error:', e.message);
    }
  })();

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[HuminLoop API] Listening on http://127.0.0.1:${PORT}`);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.warn(`[HuminLoop API] Port ${PORT} already in use — API server disabled`);
    } else {
      console.error('[HuminLoop API] Server error:', e.message);
    }
  });

  return server;
}

module.exports = { startApiServer };
