// src/rules.js — Rule-based categorization engine
// Priority chain: user selection > repo_path auto-match > window rules > AI fallback
// Caches rules and projects in memory with 5-minute TTL to avoid DB hits on every save.

const db = require('./db');

// ── Cache ──

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cache = { projects: null, rules: null, timestamp: 0 };

async function getCached() {
  if (Date.now() - cache.timestamp > CACHE_TTL || !cache.projects) {
    cache.projects = await db.getProjects();
    cache.rules = await db.getWindowRules();
    cache.timestamp = Date.now();
  }
  return cache;
}

/** Call this when projects or rules change to force a refresh. */
function invalidateCache() {
  cache.timestamp = 0;
}

// ── Matching ──

async function autoMatchProject(windowTitle) {
  if (!windowTitle) return null;
  const { projects } = await getCached();
  const titleLower = windowTitle.toLowerCase().replace(/\\/g, '/');

  for (const p of projects) {
    if (!p.repo_path) continue;
    const repoNorm = p.repo_path.toLowerCase().replace(/\\/g, '/');
    const folderName = repoNorm.split('/').filter(Boolean).pop();
    if (folderName && titleLower.includes(folderName)) return p.id;
  }
  return null;
}

async function evaluateRules(windowTitle, processName) {
  const { rules } = await getCached();
  let categoryId = null;
  let projectId = null;

  for (const rule of rules) {
    const target =
      rule.match_field === 'process_name' ? processName :
      rule.match_field === 'both' ? `${windowTitle || ''} ${processName || ''}` :
      windowTitle;

    if (!target) continue;

    let matched = false;
    if (rule.match_type === 'contains') {
      matched = target.toLowerCase().includes(rule.pattern.toLowerCase());
    } else if (rule.match_type === 'startswith') {
      matched = target.toLowerCase().startsWith(rule.pattern.toLowerCase());
    } else if (rule.match_type === 'regex') {
      try { matched = new RegExp(rule.pattern, 'i').test(target); } catch { /* invalid regex */ }
    }

    if (matched) {
      if (!categoryId && rule.category_id) categoryId = rule.category_id;
      if (!projectId && rule.project_id) projectId = rule.project_id;
      if (categoryId && projectId) break;
    }
  }

  return { categoryId, projectId };
}

async function categorize(windowTitle, processName) {
  const autoProject = await autoMatchProject(windowTitle);
  const ruleResult = await evaluateRules(windowTitle, processName);

  let category = null;
  if (ruleResult.categoryId) {
    category = await db.getCategoryName(ruleResult.categoryId);
  }

  return {
    category,
    projectId: ruleResult.projectId || autoProject || null,
  };
}

module.exports = { categorize, autoMatchProject, evaluateRules, invalidateCache };
