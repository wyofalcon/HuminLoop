/**
 * HuminLoop — SQLite data access layer
 * Zero-setup alternative to PostgreSQL for distribution to end users.
 * Uses better-sqlite3 (synchronous, bundled SQLite, no external deps).
 */

const path = require('path');

let db = null;
const categoryCache = new Map(); // name → id

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    repo_path   TEXT DEFAULT NULL,
    color       TEXT DEFAULT '#3b82f6',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clips (
    id            TEXT PRIMARY KEY,
    image         TEXT,
    comment       TEXT DEFAULT '',
    category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    tags          TEXT DEFAULT '[]',
    ai_summary    TEXT DEFAULT NULL,
    url           TEXT DEFAULT NULL,
    status        TEXT NOT NULL DEFAULT 'parked' CHECK (status IN ('active', 'parked')),
    completed_at  TEXT DEFAULT NULL,
    archived      INTEGER NOT NULL DEFAULT 0,
    ai_fix_prompt TEXT DEFAULT NULL,
    sent_to_ide_at TEXT DEFAULT NULL,
    deleted_at    TEXT DEFAULT NULL,
    timestamp     INTEGER NOT NULL,
    window_title  TEXT DEFAULT NULL,
    process_name  TEXT DEFAULT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clip_comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id     TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS demos (
    id                  TEXT PRIMARY KEY,
    project_id          INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title               TEXT DEFAULT '',
    description         TEXT DEFAULT '',
    video_path          TEXT DEFAULT NULL,
    audio_original_path TEXT DEFAULT NULL,
    audio_dubbed_path   TEXT DEFAULT NULL,
    poster_path         TEXT DEFAULT NULL,
    transcript          TEXT DEFAULT NULL,
    script              TEXT DEFAULT NULL,
    markers             TEXT DEFAULT '[]',
    speech_segments     TEXT NOT NULL DEFAULT '[]',
    activity_log        TEXT DEFAULT NULL,
    duration_ms         INTEGER NOT NULL DEFAULT 0,
    has_audio           INTEGER NOT NULL DEFAULT 0,
    audio_mode          TEXT NOT NULL DEFAULT 'original',
    source_type         TEXT NOT NULL DEFAULT 'screen',
    mime                TEXT DEFAULT 'video/webm',
    deleted_at          TEXT DEFAULT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS window_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern     TEXT NOT NULL,
    match_field TEXT NOT NULL DEFAULT 'window_title'
                CHECK (match_field IN ('window_title', 'process_name', 'both')),
    match_type  TEXT NOT NULL DEFAULT 'contains'
                CHECK (match_type IN ('contains', 'startswith', 'regex')),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    priority    INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);
  CREATE INDEX IF NOT EXISTS idx_clips_category ON clips(category_id);
  CREATE INDEX IF NOT EXISTS idx_clips_status ON clips(status);
  CREATE INDEX IF NOT EXISTS idx_clips_archived ON clips(archived);
  CREATE INDEX IF NOT EXISTS idx_clips_timestamp ON clips(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_clips_process ON clips(process_name);
  CREATE INDEX IF NOT EXISTS idx_clip_comments_clip ON clip_comments(clip_id);
  CREATE INDEX IF NOT EXISTS idx_window_rules_priority ON window_rules(priority DESC);
  CREATE INDEX IF NOT EXISTS idx_demos_project ON demos(project_id);
  CREATE INDEX IF NOT EXISTS idx_demos_deleted ON demos(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_demos_created ON demos(created_at DESC);
`;

const DEFAULT_CATEGORIES = [
  ['Uncategorized', 0], ['cvstomize.com', 1], ['PowerToys', 2],
  ['LLM Setup', 3], ['Hardware/GPU', 4], ['Ideas', 5], ['Code Patterns', 6],
];

const DEFAULT_SETTINGS = [
  ['general', '{"launchOnStartup": true, "openWindowOnLaunch": true, "minimizeToTray": true, "theme": "dark"}'],
  ['capture', '{"hotkey": "ctrl+shift+q", "watchClipboard": true, "pollInterval": 500, "autoCategory": true}'],
  ['ai', '{"enabled": true, "autoCategorizeonSave": true, "retryUncategorizedOnStartup": true}'],
  ['database', '{"host": "localhost", "port": 5432}'],
];

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function init(dbPath) {
  try {
    const Database = require('better-sqlite3');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');

    // Create tables
    db.exec(SCHEMA);

    // Seed defaults if empty
    const catCount = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
    if (catCount === 0) {
      const ins = db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)');
      for (const [name, order] of DEFAULT_CATEGORIES) ins.run(name, order);
    }

    const setCount = db.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
    if (setCount === 0) {
      const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      for (const [key, val] of DEFAULT_SETTINGS) ins.run(key, val);
    }

    // Migrations for existing databases
    runSqliteMigrations();

    await refreshCategoryCache();
    console.log(`[HuminLoop DB] SQLite ready: ${dbPath}`);
    return true;
  } catch (e) {
    console.error('[HuminLoop DB] SQLite init failed:', e.message);
    return false;
  }
}

function runSqliteMigrations() {
  const migrations = [
    `ALTER TABLE clips ADD COLUMN completed_at TEXT DEFAULT NULL`,
    `ALTER TABLE clips ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_clips_archived ON clips(archived)`,
    `ALTER TABLE clips ADD COLUMN ai_fix_prompt TEXT DEFAULT NULL`,
    `ALTER TABLE clips ADD COLUMN deleted_at TEXT DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_clips_deleted ON clips(deleted_at)`,
    `ALTER TABLE clips ADD COLUMN summarize_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE clips ADD COLUMN source TEXT NOT NULL DEFAULT 'full'`,
    `ALTER TABLE projects ADD COLUMN active_in_ide INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE projects ADD COLUMN ide TEXT DEFAULT NULL`,
    `ALTER TABLE clips ADD COLUMN sent_to_ide_at TEXT DEFAULT NULL`,
    `ALTER TABLE projects ADD COLUMN active_session_id TEXT DEFAULT NULL`,
    `ALTER TABLE projects ADD COLUMN last_heartbeat_at TEXT DEFAULT NULL`,
    `ALTER TABLE demos ADD COLUMN script TEXT DEFAULT NULL`,
    `ALTER TABLE demos ADD COLUMN speech_segments TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE demos ADD COLUMN activity_log TEXT DEFAULT NULL`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* column/index already exists */ }
  }
}

async function close() {
  if (db) {
    db.close();
    db = null;
  }
}

function isReady() {
  return db !== null;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

async function refreshCategoryCache() {
  const rows = db.prepare('SELECT id, name FROM categories ORDER BY sort_order').all();
  categoryCache.clear();
  for (const row of rows) categoryCache.set(row.name, row.id);
}

async function getCategoryId(name) {
  if (!name) return null;
  if (categoryCache.has(name)) return categoryCache.get(name);
  const row = db.prepare(
    `INSERT INTO categories (name, sort_order)
     VALUES (?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))
     ON CONFLICT (name) DO UPDATE SET name = name
     RETURNING id`
  ).get(name);
  categoryCache.set(name, row.id);
  return row.id;
}

async function getCategories() {
  const rows = db.prepare('SELECT name FROM categories ORDER BY sort_order').all();
  return rows.map(r => r.name);
}

async function saveCategory(name) {
  await getCategoryId(name);
}

async function deleteCategory(name) {
  if (name === 'Uncategorized') return;
  const uncatId = categoryCache.get('Uncategorized');
  db.prepare('UPDATE clips SET category_id = ? WHERE category_id = (SELECT id FROM categories WHERE name = ?)').run(uncatId, name);
  db.prepare('DELETE FROM categories WHERE name = ?').run(name);
  categoryCache.delete(name);
}

async function getCategoryName(id) {
  for (const [name, catId] of categoryCache) {
    if (catId === id) return name;
  }
  const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
  return row ? row.name : null;
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

const CLIPS_BASE_QUERY = `
  SELECT c.id, c.image, c.comment,
         cat.name AS category,
         c.project_id, p.name AS "projectName",
         c.tags, c.ai_summary AS "aiSummary",
         c.ai_fix_prompt AS "aiFixPrompt",
         c.sent_to_ide_at AS "sentToIdeAt",
         c.url, c.status, c.timestamp,
         c.completed_at AS "completedAt",
         c.archived,
         c.window_title AS "windowTitle",
         c.process_name AS "processName",
         c.deleted_at AS "deletedAt",
         c.summarize_count AS "summarizeCount",
         c.source,
         CASE WHEN COUNT(cc.id) = 0 THEN '[]'
              ELSE json_group_array(json_object('text', cc.text, 'ts', cc.ts))
         END AS comments
  FROM clips c
  LEFT JOIN categories cat ON c.category_id = cat.id
  LEFT JOIN projects p ON c.project_id = p.id
  LEFT JOIN clip_comments cc ON cc.clip_id = c.id
`;

const CLIPS_GROUP = `
  GROUP BY c.id, cat.name, p.name
  ORDER BY c.timestamp DESC
`;

function parseClipRow(row) {
  if (!row) return null;
  try { row.tags = JSON.parse(row.tags || '[]'); } catch { row.tags = []; }
  try { row.comments = JSON.parse(row.comments || '[]'); } catch { row.comments = []; }
  return row;
}

async function getClips(projectId, source) {
  const conditions = ['c.deleted_at IS NULL'];
  const params = [];

  if (projectId === null) {
    conditions.push('c.project_id IS NULL');
  } else if (projectId !== undefined) {
    conditions.push('c.project_id = ?');
    params.push(projectId);
  }

  if (source) {
    conditions.push('c.source = ?');
    params.push(source);
  }

  const rows = db.prepare(CLIPS_BASE_QUERY + ' WHERE ' + conditions.join(' AND ') + CLIPS_GROUP).all(...params);
  return rows.map(parseClipRow);
}

async function getClip(id) {
  const row = db.prepare(CLIPS_BASE_QUERY + ' WHERE c.id = ? ' + CLIPS_GROUP).get(id);
  return parseClipRow(row);
}

async function saveClip(clip) {
  const categoryId = await getCategoryId(clip.category || 'Uncategorized');
  const VALID_SOURCES = ['full', 'lite', 'focused'];
  const source = VALID_SOURCES.includes(clip.source) ? clip.source : 'full';
  db.prepare(
    `INSERT INTO clips (id, image, comment, category_id, project_id, tags, ai_summary, url, status, timestamp, source, window_title, process_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    clip.id,
    clip.image || null,
    clip.comment || '',
    categoryId,
    clip.project_id || null,
    JSON.stringify(clip.tags || []),
    clip.aiSummary || null,
    clip.url || null,
    clip.status || 'parked',
    clip.timestamp,
    source,
    clip.window_title || null,
    clip.process_name || null,
  );
  if (clip.comments && clip.comments.length > 0) {
    const ins = db.prepare('INSERT INTO clip_comments (clip_id, text, ts) VALUES (?, ?, ?)');
    for (const c of clip.comments) ins.run(clip.id, c.text, c.ts);
  }
  return true;
}

async function updateClip(id, updates) {
  const ALLOWED = ['category', 'tags', 'aiSummary', 'aiFixPrompt', 'url', 'status', 'comments', 'project_id', 'comment', 'completed_at', 'archived', 'summarize_count', 'sent_to_ide_at'];
  const setClauses = [];
  const params = [];

  for (const [key, val] of Object.entries(updates)) {
    if (!ALLOWED.includes(key)) continue;

    if (key === 'category') {
      const catId = await getCategoryId(val);
      setClauses.push('category_id = ?');
      params.push(catId);
    } else if (key === 'aiSummary') {
      setClauses.push('ai_summary = ?');
      params.push(val);
    } else if (key === 'aiFixPrompt') {
      setClauses.push('ai_fix_prompt = ?');
      params.push(val);
    } else if (key === 'tags') {
      setClauses.push('tags = ?');
      params.push(JSON.stringify(val));
    } else if (key === 'comments') {
      db.prepare('DELETE FROM clip_comments WHERE clip_id = ?').run(id);
      if (Array.isArray(val)) {
        const ins = db.prepare('INSERT INTO clip_comments (clip_id, text, ts) VALUES (?, ?, ?)');
        for (const c of val) ins.run(id, c.text, c.ts);
      }
      continue;
    } else if (key === 'project_id') {
      setClauses.push('project_id = ?');
      params.push(val);
    } else if (key === 'url') {
      setClauses.push('url = ?');
      params.push(val);
    } else if (key === 'status') {
      setClauses.push('status = ?');
      params.push(val);
    } else if (key === 'comment') {
      setClauses.push('comment = ?');
      params.push(val);
    } else if (key === 'completed_at') {
      setClauses.push('completed_at = ?');
      params.push(val);
    } else if (key === 'archived') {
      setClauses.push('archived = ?');
      params.push(val ? 1 : 0);
    } else if (key === 'summarize_count') {
      setClauses.push('summarize_count = ?');
      params.push(val);
    } else if (key === 'sent_to_ide_at') {
      setClauses.push('sent_to_ide_at = ?');
      params.push(val);
    }
  }

  if (setClauses.length > 0) {
    params.push(id);
    db.prepare(`UPDATE clips SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  }
  return true;
}

async function deleteClip(id) {
  db.prepare('UPDATE clips SET deleted_at = datetime(\'now\') WHERE id = ?').run(id);
  return true;
}

async function restoreClip(id) {
  db.prepare('UPDATE clips SET deleted_at = NULL WHERE id = ?').run(id);
  return true;
}

async function permanentDeleteClip(id) {
  db.prepare('DELETE FROM clips WHERE id = ?').run(id);
  return true;
}

async function getTrash() {
  const rows = db.prepare(CLIPS_BASE_QUERY + ' WHERE c.deleted_at IS NOT NULL ' + CLIPS_GROUP).all();
  return rows.map(parseClipRow);
}

async function purgeTrash(olderThanDays = 30) {
  const result = db.prepare(
    `DELETE FROM clips WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-' || ? || ' days')`
  ).run(olderThanDays);
  return result.changes;
}

async function migrateArchivedToTrash() {
  const result = db.prepare(
    `UPDATE clips SET deleted_at = datetime('now'), archived = 0 WHERE archived = 1 AND deleted_at IS NULL`
  ).run();
  if (result.changes > 0) console.log(`[HuminLoop DB] Migrated ${result.changes} archived clip(s) to trash`);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Demos (screen recordings + AI transcript / dubbing)
// ---------------------------------------------------------------------------

const DEMOS_BASE_QUERY = `
  SELECT d.id, d.project_id, p.name AS "projectName",
         d.title, d.description,
         d.video_path AS "videoPath",
         d.audio_original_path AS "audioOriginalPath",
         d.audio_dubbed_path AS "audioDubbedPath",
         d.poster_path AS "posterPath",
         d.transcript, d.script, d.markers,
         d.speech_segments AS "speechSegments",
         d.activity_log AS "activityLog",
         d.duration_ms AS "durationMs",
         d.has_audio AS "hasAudio",
         d.audio_mode AS "audioMode",
         d.source_type AS "sourceType",
         d.mime,
         d.deleted_at AS "deletedAt",
         d.created_at AS "createdAt",
         d.updated_at AS "updatedAt"
  FROM demos d
  LEFT JOIN projects p ON d.project_id = p.id
`;

// sqlite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" with no zone
// marker — Chromium's Date parser reads that as LOCAL time, skewing "time ago"
// by the UTC offset. Normalize to an explicit ISO-8601 UTC string.
function sqliteUtcToIso(s) {
  if (!s || typeof s !== 'string' || s.includes('T')) return s;
  return s.replace(' ', 'T') + 'Z';
}

function parseDemoRow(row) {
  if (!row) return null;
  try { row.transcript = row.transcript ? JSON.parse(row.transcript) : null; } catch { row.transcript = null; }
  try { row.script = row.script ? JSON.parse(row.script) : null; } catch { row.script = null; }
  try { row.markers = JSON.parse(row.markers || '[]'); } catch { row.markers = []; }
  try { row.speechSegments = JSON.parse(row.speechSegments || '[]'); } catch { row.speechSegments = []; }
  try { row.activityLog = row.activityLog ? JSON.parse(row.activityLog) : null; } catch { row.activityLog = null; }
  row.hasAudio = !!row.hasAudio;
  row.createdAt = sqliteUtcToIso(row.createdAt);
  row.updatedAt = sqliteUtcToIso(row.updatedAt);
  row.deletedAt = sqliteUtcToIso(row.deletedAt);
  return row;
}

async function getDemos(projectId) {
  const conditions = ['d.deleted_at IS NULL'];
  const params = [];
  if (projectId === null) {
    conditions.push('d.project_id IS NULL');
  } else if (projectId !== undefined) {
    conditions.push('d.project_id = ?');
    params.push(projectId);
  }
  const rows = db.prepare(DEMOS_BASE_QUERY + ' WHERE ' + conditions.join(' AND ') + ' ORDER BY d.created_at DESC').all(...params);
  return rows.map(parseDemoRow);
}

async function getDemo(id) {
  const row = db.prepare(DEMOS_BASE_QUERY + ' WHERE d.id = ?').get(id);
  return parseDemoRow(row);
}

async function saveDemo(demo) {
  db.prepare(
    `INSERT INTO demos (id, project_id, title, description, video_path, audio_original_path, audio_dubbed_path, poster_path, transcript, markers, speech_segments, activity_log, duration_ms, has_audio, audio_mode, source_type, mime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    demo.id,
    demo.project_id || null,
    demo.title || '',
    demo.description || '',
    demo.video_path || null,
    demo.audio_original_path || null,
    demo.audio_dubbed_path || null,
    demo.poster_path || null,
    demo.transcript ? JSON.stringify(demo.transcript) : null,
    JSON.stringify(demo.markers || []),
    JSON.stringify(demo.speech_segments || []),
    demo.activity_log ? JSON.stringify(demo.activity_log) : null,
    demo.duration_ms || 0,
    demo.has_audio ? 1 : 0,
    demo.audio_mode || 'original',
    demo.source_type || 'screen',
    demo.mime || 'video/webm',
  );
  return true;
}

// Columns that map 1:1 from an update key to a plain scalar column.
const DEMO_UPDATE_COLUMNS = {
  title: 'title', description: 'description',
  video_path: 'video_path', audio_original_path: 'audio_original_path',
  audio_dubbed_path: 'audio_dubbed_path', poster_path: 'poster_path',
  duration_ms: 'duration_ms', audio_mode: 'audio_mode',
  source_type: 'source_type', mime: 'mime', project_id: 'project_id',
};

async function updateDemo(id, updates) {
  const setClauses = [];
  const params = [];
  for (const [key, val] of Object.entries(updates)) {
    if (key === 'transcript' || key === 'script' || key === 'activity_log') {
      setClauses.push(`${key} = ?`);
      params.push(val == null ? null : JSON.stringify(val));
    } else if (key === 'markers' || key === 'speech_segments') {
      setClauses.push(`${key} = ?`);
      params.push(JSON.stringify(val || []));
    } else if (key === 'has_audio') {
      setClauses.push('has_audio = ?');
      params.push(val ? 1 : 0);
    } else if (DEMO_UPDATE_COLUMNS[key]) {
      setClauses.push(`${DEMO_UPDATE_COLUMNS[key]} = ?`);
      params.push(val);
    }
  }
  if (setClauses.length === 0) return false;
  setClauses.push(`updated_at = datetime('now')`);
  params.push(id);
  db.prepare(`UPDATE demos SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

async function deleteDemo(id) {
  db.prepare(`UPDATE demos SET deleted_at = datetime('now') WHERE id = ?`).run(id);
  return true;
}

async function restoreDemo(id) {
  db.prepare('UPDATE demos SET deleted_at = NULL WHERE id = ?').run(id);
  return true;
}

async function permanentDeleteDemo(id) {
  db.prepare('DELETE FROM demos WHERE id = ?').run(id);
  return true;
}

async function getDemoTrash() {
  const rows = db.prepare(DEMOS_BASE_QUERY + ' WHERE d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC').all();
  return rows.map(parseDemoRow);
}

// Returns the ids of purged demos so the caller can delete their media folders.
async function purgeDemoTrash(olderThanDays = 30) {
  const rows = db.prepare(
    `SELECT id FROM demos WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-' || ? || ' days')`
  ).all(olderThanDays);
  const ids = rows.map(r => r.id);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM demos WHERE id IN (${placeholders})`).run(...ids);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

async function addComment(clipId, text, ts) {
  db.prepare('INSERT INTO clip_comments (clip_id, text, ts) VALUES (?, ?, ?)').run(clipId, text, ts);
  return true;
}

async function deleteComment(commentId) {
  db.prepare('DELETE FROM clip_comments WHERE id = ?').run(commentId);
  return true;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async function getProjects() {
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM clips WHERE project_id = p.id AND deleted_at IS NULL) AS "clipCount"
    FROM projects p ORDER BY p.name
  `).all();
  return rows;
}

async function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
}

async function createProject(data) {
  return db.prepare(
    `INSERT INTO projects (name, description, repo_path, color, ide) VALUES (?, ?, ?, ?, ?) RETURNING *`
  ).get(data.name, data.description || '', data.repo_path || null, data.color || '#3b82f6', data.ide || null);
}

async function updateProject(id, data) {
  const fields = [];
  const params = [];

  if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
  if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
  if (data.repo_path !== undefined) { fields.push('repo_path = ?'); params.push(data.repo_path); }
  if (data.color !== undefined) { fields.push('color = ?'); params.push(data.color); }
  if (data.active_in_ide !== undefined) { fields.push('active_in_ide = ?'); params.push(data.active_in_ide ? 1 : 0); }
  if (data.ide !== undefined) { fields.push('ide = ?'); params.push(data.ide); }
  if (data.active_session_id !== undefined) { fields.push('active_session_id = ?'); params.push(data.active_session_id); }
  if (data.last_heartbeat_at !== undefined) { fields.push('last_heartbeat_at = ?'); params.push(data.last_heartbeat_at); }

  if (fields.length === 0) return null;

  params.push(id);
  return db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ? RETURNING *`).get(...params) || null;
}

async function deleteProject(id) {
  db.prepare('UPDATE clips SET project_id = NULL WHERE project_id = ?').run(id);
  db.prepare('UPDATE demos SET project_id = NULL WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return true;
}

// ---------------------------------------------------------------------------
// Window Rules
// ---------------------------------------------------------------------------

async function getWindowRules() {
  return db.prepare('SELECT * FROM window_rules ORDER BY priority DESC').all();
}

async function createWindowRule(rule) {
  return db.prepare(
    `INSERT INTO window_rules (pattern, match_field, match_type, category_id, project_id, priority)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
  ).get(rule.pattern, rule.match_field || 'window_title', rule.match_type || 'contains',
        rule.category_id || null, rule.project_id || null, rule.priority || 0);
}

async function deleteWindowRule(id) {
  db.prepare('DELETE FROM window_rules WHERE id = ?').run(id);
  return true;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

async function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = JSON.parse(row.value);
  return settings;
}

async function saveSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = ?`
  ).run(key, JSON.stringify(value), JSON.stringify(value));
  return true;
}

// ---------------------------------------------------------------------------
// Migration from electron-store
// ---------------------------------------------------------------------------

async function migrateFromStore(storeData) {
  const { clips, categories } = storeData;

  try {
    const migrate = db.transaction(() => {
      // Migrate categories
      const insCat = db.prepare(
        `INSERT OR IGNORE INTO categories (name, sort_order)
         VALUES (?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))`
      );
      for (const name of categories) insCat.run(name);

      // Build category map
      const catRows = db.prepare('SELECT id, name FROM categories').all();
      const catMap = new Map();
      for (const r of catRows) catMap.set(r.name, r.id);

      // Migrate clips
      const insClip = db.prepare(
        `INSERT OR IGNORE INTO clips (id, image, comment, category_id, tags, ai_summary, url, status, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insComment = db.prepare('INSERT INTO clip_comments (clip_id, text, ts) VALUES (?, ?, ?)');

      for (const clip of clips) {
        const catId = catMap.get(clip.category) || catMap.get('Uncategorized');
        insClip.run(
          clip.id, clip.image || null, clip.comment || '', catId,
          JSON.stringify(clip.tags || []), clip.aiSummary || null,
          clip.url || null, clip.status || 'parked', clip.timestamp,
        );
        if (clip.comments && clip.comments.length > 0) {
          for (const c of clip.comments) insComment.run(clip.id, c.text, c.ts);
        }
      }
    });

    migrate();
    await refreshCategoryCache();
    console.log(`[HuminLoop DB] Migrated ${clips.length} clips and ${categories.length} categories`);
    return true;
  } catch (err) {
    console.error('[HuminLoop DB] Migration failed:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------

function runRaw(sql, params = []) {
  return db.prepare(sql).run(...params);
}

module.exports = {
  init,
  close,
  isReady,
  runRaw,
  getClips,
  getClip,
  saveClip,
  updateClip,
  deleteClip,
  restoreClip,
  permanentDeleteClip,
  getTrash,
  purgeTrash,
  getDemos,
  getDemo,
  saveDemo,
  updateDemo,
  deleteDemo,
  restoreDemo,
  permanentDeleteDemo,
  getDemoTrash,
  purgeDemoTrash,
  getCategories,
  getCategoryId,
  getCategoryName,
  saveCategory,
  deleteCategory,
  refreshCategoryCache,
  getProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  addComment,
  deleteComment,
  getWindowRules,
  createWindowRule,
  deleteWindowRule,
  getSettings,
  getAllSettings,
  saveSetting,
  migrateFromStore,
  migrateArchivedToTrash,
};
