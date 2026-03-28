/**
 * Sciurus — Database backend switcher
 * Tries PostgreSQL first (for dev/power users with Docker).
 * Falls back to SQLite (zero-setup, for distributed builds).
 * Set DB_BACKEND=pg or DB_BACKEND=sqlite in .env to force one.
 */

const path = require('path');
const { app } = require('electron');

let backend = null;
let backendName = 'none';

async function init() {
  const force = process.env.DB_BACKEND; // 'pg', 'sqlite', or undefined (auto)

  // Try PostgreSQL
  if (force !== 'sqlite') {
    try {
      const pg = require('./db-pg');
      // In auto mode, only try 3 attempts (~6s) so we fall back quickly.
      // If explicitly set to pg, give it the full 15 attempts.
      const attempts = force === 'pg' ? 15 : 3;
      const ok = await pg.init(attempts);
      if (ok) {
        backend = pg;
        backendName = 'postgresql';
        console.log('[Sciurus DB] Using PostgreSQL backend');
        return true;
      }
    } catch (e) {
      console.log('[Sciurus DB] PostgreSQL unavailable:', e.message);
    }
  }

  // Fall back to SQLite
  if (force !== 'pg') {
    try {
      const sqlite = require('./db-sqlite');
      const dbPath = path.join(app.getPath('userData'), 'sciurus.db');
      const ok = await sqlite.init(dbPath);
      if (ok) {
        backend = sqlite;
        backendName = 'sqlite';
        console.log('[Sciurus DB] Using SQLite backend');
        return true;
      }
    } catch (e) {
      console.log('[Sciurus DB] SQLite unavailable:', e.message);
    }
  }

  return false;
}

function getBackendName() {
  return backendName;
}

module.exports = {
  init,
  getBackendName,
  close: (...a) => backend.close(...a),
  isReady: () => backend !== null && backend.isReady(),
  // Clips
  getClips: (...a) => backend.getClips(...a),
  getClip: (...a) => backend.getClip(...a),
  saveClip: (...a) => backend.saveClip(...a),
  updateClip: (...a) => backend.updateClip(...a),
  deleteClip: (...a) => backend.deleteClip(...a),
  restoreClip: (...a) => backend.restoreClip(...a),
  permanentDeleteClip: (...a) => backend.permanentDeleteClip(...a),
  getTrash: (...a) => backend.getTrash(...a),
  purgeTrash: (...a) => backend.purgeTrash(...a),
  // Categories
  getCategories: (...a) => backend.getCategories(...a),
  getCategoryId: (...a) => backend.getCategoryId(...a),
  getCategoryName: (...a) => backend.getCategoryName(...a),
  saveCategory: (...a) => backend.saveCategory(...a),
  deleteCategory: (...a) => backend.deleteCategory(...a),
  refreshCategoryCache: (...a) => backend.refreshCategoryCache(...a),
  // Projects
  getProjects: (...a) => backend.getProjects(...a),
  getProject: (...a) => backend.getProject(...a),
  createProject: (...a) => backend.createProject(...a),
  updateProject: (...a) => backend.updateProject(...a),
  deleteProject: (...a) => backend.deleteProject(...a),
  // Comments
  addComment: (...a) => backend.addComment(...a),
  deleteComment: (...a) => backend.deleteComment(...a),
  // Window Rules
  getWindowRules: (...a) => backend.getWindowRules(...a),
  createWindowRule: (...a) => backend.createWindowRule(...a),
  deleteWindowRule: (...a) => backend.deleteWindowRule(...a),
  // Settings
  getSettings: (...a) => backend.getSettings(...a),
  getAllSettings: (...a) => backend.getAllSettings(...a),
  saveSetting: (...a) => backend.saveSetting(...a),
  // Migration
  migrateFromStore: (...a) => backend.migrateFromStore(...a),
  migrateArchivedToTrash: (...a) => backend.migrateArchivedToTrash(...a),
};
