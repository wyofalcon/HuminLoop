/**
 * Sciurus — PostgreSQL data access layer
 * Replaces electron-store + Google Sheets with a local Docker PostgreSQL database.
 */

const { Pool } = require('pg');

let pool = null;
const categoryCache = new Map(); // name → id

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function init(maxAttempts = 15) {
  pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'sciurus',
    user: process.env.POSTGRES_USER || 'sciurus',
    password: process.env.POSTGRES_PASSWORD || 'sciurus_dev',
    max: 10,
    idleTimeoutMillis: 30000,
  });

  // Retry loop — Docker container may still be starting
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      console.log('[Sciurus DB] Connected to PostgreSQL');
      await runMigrations();
      await refreshCategoryCache();
      return true;
    } catch (err) {
      console.log(`[Sciurus DB] Connection attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) await sleep(2000);
    }
  }

  // Clean up the pool so it doesn't hang
  try { await pool.end(); } catch {}
  pool = null;
  console.error(`[Sciurus DB] Could not connect to PostgreSQL after ${maxAttempts} attempts`);
  return false;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function isReady() {
  return pool !== null;
}

// ---------------------------------------------------------------------------
// Migrations (safe to re-run — uses IF NOT EXISTS / IF NOT EXISTS)
// ---------------------------------------------------------------------------

async function runMigrations() {
  const migrations = [
    `ALTER TABLE clips ADD COLUMN IF NOT EXISTS window_title TEXT DEFAULT NULL`,
    `ALTER TABLE clips ADD COLUMN IF NOT EXISTS process_name VARCHAR(255) DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS window_rules (
       id          SERIAL PRIMARY KEY,
       pattern     VARCHAR(500) NOT NULL,
       match_field VARCHAR(20) NOT NULL DEFAULT 'window_title',
       match_type  VARCHAR(10) NOT NULL DEFAULT 'contains',
       category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
       project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
       priority    INTEGER DEFAULT 0,
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_clips_process ON clips(process_name)`,
    `CREATE INDEX IF NOT EXISTS idx_window_rules_priority ON window_rules(priority DESC)`,
    `ALTER TABLE clips ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NULL`,
    `ALTER TABLE clips ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_clips_archived ON clips(archived)`,
    `ALTER TABLE clips ADD COLUMN IF NOT EXISTS ai_fix_prompt TEXT DEFAULT NULL`,
    `ALTER TABLE clips ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_clips_deleted ON clips(deleted_at)`,
    `ALTER TABLE clips ADD COLUMN IF NOT EXISTS summarize_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE clips ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'full'`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS active_in_ide BOOLEAN NOT NULL DEFAULT FALSE`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) { /* already exists */ }
  }
  console.log('[Sciurus DB] Migrations complete');
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

async function refreshCategoryCache() {
  const { rows } = await pool.query('SELECT id, name FROM categories ORDER BY sort_order');
  categoryCache.clear();
  for (const row of rows) categoryCache.set(row.name, row.id);
}

async function getCategoryId(name) {
  if (!name) return null;
  if (categoryCache.has(name)) return categoryCache.get(name);
  // Insert if new
  const { rows } = await pool.query(
    `INSERT INTO categories (name, sort_order)
     VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name]
  );
  categoryCache.set(name, rows[0].id);
  return rows[0].id;
}

async function getCategories() {
  const { rows } = await pool.query('SELECT name FROM categories ORDER BY sort_order');
  return rows.map(r => r.name);
}

async function saveCategory(name) {
  await getCategoryId(name);
}

async function deleteCategory(name) {
  if (name === 'Uncategorized') return;
  const uncatId = categoryCache.get('Uncategorized');
  await pool.query(
    'UPDATE clips SET category_id = $1 WHERE category_id = (SELECT id FROM categories WHERE name = $2)',
    [uncatId, name]
  );
  await pool.query('DELETE FROM categories WHERE name = $1', [name]);
  categoryCache.delete(name);
}

async function getCategoryName(id) {
  for (const [name, catId] of categoryCache) {
    if (catId === id) return name;
  }
  const { rows } = await pool.query('SELECT name FROM categories WHERE id = $1', [id]);
  return rows[0] ? rows[0].name : null;
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
         c.url, c.status, c.timestamp,
         c.completed_at AS "completedAt",
         c.archived,
         c.window_title AS "windowTitle",
         c.process_name AS "processName",
         c.deleted_at AS "deletedAt",
         c.summarize_count AS "summarizeCount",
         c.source,
         COALESCE(
           json_agg(
             json_build_object('text', cc.text, 'ts', cc.ts)
             ORDER BY cc.ts
           ) FILTER (WHERE cc.id IS NOT NULL),
           '[]'
         ) AS comments
  FROM clips c
  LEFT JOIN categories cat ON c.category_id = cat.id
  LEFT JOIN projects p ON c.project_id = p.id
  LEFT JOIN clip_comments cc ON cc.clip_id = c.id
`;

const CLIPS_GROUP = `
  GROUP BY c.id, cat.name, p.name
  ORDER BY c.timestamp DESC
`;

async function getClips(projectId, source) {
  const conditions = ['c.deleted_at IS NULL'];
  const params = [];

  if (projectId === null) {
    conditions.push('c.project_id IS NULL');
  } else if (projectId !== undefined) {
    params.push(projectId);
    conditions.push(`c.project_id = $${params.length}`);
  }

  if (source) {
    params.push(source);
    conditions.push(`c.source = $${params.length}`);
  }

  const query = CLIPS_BASE_QUERY + ' WHERE ' + conditions.join(' AND ') + CLIPS_GROUP;
  const { rows } = await pool.query(query, params);
  return rows;
}

async function getClip(id) {
  const { rows } = await pool.query(
    CLIPS_BASE_QUERY + ' WHERE c.id = $1 ' + CLIPS_GROUP,
    [id]
  );
  return rows[0] || null;
}

async function saveClip(clip) {
  const categoryId = await getCategoryId(clip.category || 'Uncategorized');
  const VALID_SOURCES = ['full', 'lite'];
  const source = VALID_SOURCES.includes(clip.source) ? clip.source : 'full';
  await pool.query(
    `INSERT INTO clips (id, image, comment, category_id, project_id, tags, ai_summary, url, status, timestamp, source, window_title, process_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      clip.id,
      clip.image || null,
      clip.comment || '',
      categoryId,
      clip.project_id || null,
      clip.tags || [],
      clip.aiSummary || null,
      clip.url || null,
      clip.status || 'parked',
      clip.timestamp,
      source,
      clip.window_title || null,
      clip.process_name || null,
    ]
  );
  // Insert any initial comments
  if (clip.comments && clip.comments.length > 0) {
    for (const c of clip.comments) {
      await pool.query(
        'INSERT INTO clip_comments (clip_id, text, ts) VALUES ($1, $2, $3)',
        [clip.id, c.text, c.ts]
      );
    }
  }
  return true;
}

async function updateClip(id, updates) {
  const ALLOWED = ['category', 'tags', 'aiSummary', 'aiFixPrompt', 'url', 'status', 'comments', 'project_id', 'comment', 'completed_at', 'archived', 'summarize_count'];
  const setClauses = [];
  const params = [];
  let paramIdx = 1;

  for (const [key, val] of Object.entries(updates)) {
    if (!ALLOWED.includes(key)) continue;

    if (key === 'category') {
      const catId = await getCategoryId(val);
      setClauses.push(`category_id = $${paramIdx++}`);
      params.push(catId);
    } else if (key === 'aiSummary') {
      setClauses.push(`ai_summary = $${paramIdx++}`);
      params.push(val);
    } else if (key === 'aiFixPrompt') {
      setClauses.push(`ai_fix_prompt = $${paramIdx++}`);
      params.push(val);
    } else if (key === 'tags') {
      setClauses.push(`tags = $${paramIdx++}`);
      params.push(val);
    } else if (key === 'comments') {
      // Replace all comments — delete then re-insert
      await pool.query('DELETE FROM clip_comments WHERE clip_id = $1', [id]);
      if (Array.isArray(val)) {
        for (const c of val) {
          await pool.query(
            'INSERT INTO clip_comments (clip_id, text, ts) VALUES ($1, $2, $3)',
            [id, c.text, c.ts]
          );
        }
      }
      continue; // not a column on clips table
    } else if (key === 'project_id') {
      setClauses.push(`project_id = $${paramIdx++}`);
      params.push(val);
    } else if (key === 'url') {
      setClauses.push(`url = $${paramIdx++}`);
      params.push(val);
    } else if (key === 'status') {
      setClauses.push(`status = $${paramIdx++}`);
      params.push(val);
    } else if (key === 'comment') {
      setClauses.push(`comment = $${paramIdx++}`);
      params.push(val);
    } else if (key === 'completed_at') {
      setClauses.push(`completed_at = $${paramIdx++}`);
      params.push(val);
    } else if (key === 'archived') {
      setClauses.push(`archived = $${paramIdx++}`);
      params.push(!!val);
    } else if (key === 'summarize_count') {
      setClauses.push(`summarize_count = $${paramIdx++}`);
      params.push(val);
    }
  }

  if (setClauses.length > 0) {
    params.push(id);
    await pool.query(
      `UPDATE clips SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
      params
    );
  }

  return true;
}

async function deleteClip(id) {
  await pool.query('UPDATE clips SET deleted_at = NOW() WHERE id = $1', [id]);
  return true;
}

async function restoreClip(id) {
  await pool.query('UPDATE clips SET deleted_at = NULL WHERE id = $1', [id]);
  return true;
}

async function permanentDeleteClip(id) {
  await pool.query('DELETE FROM clips WHERE id = $1', [id]);
  return true;
}

async function getTrash() {
  const { rows } = await pool.query(
    CLIPS_BASE_QUERY + ' WHERE c.deleted_at IS NOT NULL ' + CLIPS_GROUP
  );
  return rows;
}

async function purgeTrash(olderThanDays = 30) {
  const { rowCount } = await pool.query(
    `DELETE FROM clips WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '1 day' * $1`,
    [olderThanDays]
  );
  return rowCount;
}

async function migrateArchivedToTrash() {
  const { rowCount } = await pool.query(
    `UPDATE clips SET deleted_at = NOW(), archived = false WHERE archived = true AND deleted_at IS NULL`
  );
  if (rowCount > 0) console.log(`[Sciurus DB] Migrated ${rowCount} archived clip(s) to trash`);
  return rowCount;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

async function addComment(clipId, text, ts) {
  await pool.query(
    'INSERT INTO clip_comments (clip_id, text, ts) VALUES ($1, $2, $3)',
    [clipId, text, ts]
  );
  return true;
}

async function deleteComment(commentId) {
  await pool.query('DELETE FROM clip_comments WHERE id = $1', [commentId]);
  return true;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async function getProjects() {
  const { rows } = await pool.query(`
    SELECT p.*,
           (SELECT COUNT(*) FROM clips WHERE project_id = p.id AND deleted_at IS NULL)::int AS "clipCount"
    FROM projects p
    ORDER BY p.name
  `);
  return rows;
}

async function getProject(id) {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createProject(data) {
  const { rows } = await pool.query(
    `INSERT INTO projects (name, description, repo_path, color)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.name, data.description || '', data.repo_path || null, data.color || '#3b82f6']
  );
  return rows[0];
}

async function updateProject(id, data) {
  const fields = [];
  const params = [];
  let idx = 1;

  if (data.name !== undefined) { fields.push(`name = $${idx++}`); params.push(data.name); }
  if (data.description !== undefined) { fields.push(`description = $${idx++}`); params.push(data.description); }
  if (data.repo_path !== undefined) { fields.push(`repo_path = $${idx++}`); params.push(data.repo_path); }
  if (data.color !== undefined) { fields.push(`color = $${idx++}`); params.push(data.color); }
  if (data.active_in_ide !== undefined) { fields.push(`active_in_ide = $${idx++}`); params.push(data.active_in_ide); }

  if (fields.length === 0) return null;

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE projects SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function deleteProject(id) {
  // Clips get project_id = NULL (move to General Notes)
  await pool.query('UPDATE clips SET project_id = NULL WHERE project_id = $1', [id]);
  await pool.query('DELETE FROM projects WHERE id = $1', [id]);
  return true;
}

// ---------------------------------------------------------------------------
// Window Rules
// ---------------------------------------------------------------------------

async function getWindowRules() {
  const { rows } = await pool.query('SELECT * FROM window_rules ORDER BY priority DESC');
  return rows;
}

async function createWindowRule(rule) {
  const { rows } = await pool.query(
    `INSERT INTO window_rules (pattern, match_field, match_type, category_id, project_id, priority)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [rule.pattern, rule.match_field || 'window_title', rule.match_type || 'contains',
     rule.category_id || null, rule.project_id || null, rule.priority || 0]
  );
  return rows[0];
}

async function deleteWindowRule(id) {
  await pool.query('DELETE FROM window_rules WHERE id = $1', [id]);
  return true;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings(key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}

async function getAllSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

async function saveSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, JSON.stringify(value)]
  );
  return true;
}

// ---------------------------------------------------------------------------
// Migration from electron-store
// ---------------------------------------------------------------------------

async function migrateFromStore(storeData) {
  const { clips, categories } = storeData;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Migrate categories
    for (const name of categories) {
      await client.query(
        `INSERT INTO categories (name, sort_order)
         VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))
         ON CONFLICT (name) DO NOTHING`,
        [name]
      );
    }

    // Refresh cache within transaction
    const catRows = (await client.query('SELECT id, name FROM categories')).rows;
    const catMap = new Map();
    for (const r of catRows) catMap.set(r.name, r.id);

    // Migrate clips
    for (const clip of clips) {
      const catId = catMap.get(clip.category) || catMap.get('Uncategorized');

      await client.query(
        `INSERT INTO clips (id, image, comment, category_id, tags, ai_summary, url, status, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          clip.id,
          clip.image || null,
          clip.comment || '',
          catId,
          clip.tags || [],
          clip.aiSummary || null,
          clip.url || null,
          clip.status || 'parked',
          clip.timestamp,
        ]
      );

      // Migrate thread comments
      if (clip.comments && clip.comments.length > 0) {
        for (const c of clip.comments) {
          await client.query(
            'INSERT INTO clip_comments (clip_id, text, ts) VALUES ($1, $2, $3)',
            [clip.id, c.text, c.ts]
          );
        }
      }
    }

    await client.query('COMMIT');
    await refreshCategoryCache();
    console.log(`[Sciurus DB] Migrated ${clips.length} clips and ${categories.length} categories`);
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Sciurus DB] Migration failed:', err.message);
    return false;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  init,
  close,
  isReady,
  // Clips
  getClips,
  getClip,
  saveClip,
  updateClip,
  deleteClip,
  restoreClip,
  permanentDeleteClip,
  getTrash,
  purgeTrash,
  // Categories
  getCategories,
  getCategoryId,
  getCategoryName,
  saveCategory,
  deleteCategory,
  refreshCategoryCache,
  // Projects
  getProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  // Comments
  addComment,
  deleteComment,
  // Window Rules
  getWindowRules,
  createWindowRule,
  deleteWindowRule,
  // Settings
  getSettings,
  getAllSettings,
  saveSetting,
  // Migration
  migrateFromStore,
  migrateArchivedToTrash,
};
