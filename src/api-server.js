/**
 * Sciurus — Local HTTP API Server
 * Mirrors IPC handlers so external tools (MCP servers, CLIs) can access Sciurus.
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

const PORT = parseInt(process.env.SCIURUS_API_PORT || '7277', 10);

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

function startApiServer(deps) {
  const { db, ai, rules, images, sanitizeUpdates, autoCategorize, addAuditEntry } = deps;

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
            .catch(e => console.error('[Sciurus API] Auto-categorize error:', e.message));
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
        const project = await db.updateProject(parseInt(m.params.id, 10), data);
        rules.invalidateCache();
        return json(res, project);
      }

      if (method === 'DELETE' && (m = matchRoute('/api/projects/:id', pathname))) {
        await db.deleteProject(parseInt(m.params.id, 10));
        rules.invalidateCache();
        return json(res, { success: true });
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

      // ── Workflow ──

      if (method === 'GET' && pathname === '/api/workflow/status') {
        const workflowDir = path.join(__dirname, '..', '.ai-workflow');
        const contextDir = path.join(workflowDir, 'context');
        const read = (f) => { try { return fs.readFileSync(path.join(contextDir, f), 'utf8').trim(); } catch { return null; } };
        return json(res, {
          relayMode: read('RELAY_MODE') || 'review',
          auditMode: read('AUDIT_WATCH_MODE') || 'off',
          session: read('SESSION.md'),
          hasWorkflow: fs.existsSync(workflowDir),
        });
      }

      if (method === 'GET' && pathname === '/api/workflow/changelog') {
        const p = path.join(__dirname, '..', '.ai-workflow', 'context', 'CHANGELOG.md');
        try { return json(res, { content: fs.readFileSync(p, 'utf8') }); }
        catch { return json(res, { content: null }); }
      }

      if (method === 'GET' && pathname === '/api/workflow/prompts') {
        const p = path.join(__dirname, '..', '.ai-workflow', 'context', 'PROMPT_TRACKER.log');
        try {
          const raw = fs.readFileSync(p, 'utf8').trim();
          if (!raw) return json(res, []);
          const prompts = raw.split('\n').map((line) => {
            const parts = line.split('|');
            return { id: parts[0], status: parts[1], timestamp: parts[2], description: parts[3], type: parts[4] || 'CRAFTED', parentId: parts[5] || null };
          }).reverse();
          return json(res, prompts);
        } catch { return json(res, []); }
      }

      if (method === 'GET' && pathname === '/api/workflow/audits') {
        const p = path.join(__dirname, '..', '.ai-workflow', 'context', 'AUDIT_LOG.md');
        try { return json(res, { content: fs.readFileSync(p, 'utf8') }); } catch { return json(res, { content: null }); }
      }

      // ── 404 ──
      error(res, `Not found: ${method} ${pathname}`, 404);

    } catch (e) {
      console.error(`[Sciurus API] ${method} ${pathname} error:`, e.message);
      error(res, e.message, 500);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Sciurus API] Listening on http://127.0.0.1:${PORT}`);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.warn(`[Sciurus API] Port ${PORT} already in use — API server disabled`);
    } else {
      console.error('[Sciurus API] Server error:', e.message);
    }
  });

  return server;
}

module.exports = { startApiServer };
