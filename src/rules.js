// src/rules.js — Rule-based categorization engine
// Priority chain: user selection > repo_path auto-match > process rules > comment keywords > window rules > AI fallback
// Goal: categorize as much as possible WITHOUT an API call.

const db = require('./db');

// ── Cache ──

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cache = { projects: null, rules: null, categories: null, timestamp: 0 };

async function getCached() {
  if (Date.now() - cache.timestamp > CACHE_TTL || !cache.projects) {
    cache.projects = await db.getProjects();
    cache.rules = await db.getWindowRules();
    cache.categories = await db.getCategories();
    cache.timestamp = Date.now();
  }
  return cache;
}

function invalidateCache() {
  cache.timestamp = 0;
}

// ── Built-in Process → Category Map ──
// Common apps/processes → likely category. Users never need to configure these.

const PROCESS_CATEGORY_MAP = {
  // Browsers
  'chrome': 'Web',
  'msedge': 'Web',
  'firefox': 'Web',
  'brave': 'Web',
  'opera': 'Web',
  // Dev tools
  'code': 'Dev Tools',
  'Code': 'Dev Tools',
  'devenv': 'Dev Tools',
  'idea64': 'Dev Tools',
  'webstorm64': 'Dev Tools',
  'pycharm64': 'Dev Tools',
  'rider64': 'Dev Tools',
  // Terminal
  'WindowsTerminal': 'Dev Tools',
  'powershell': 'Dev Tools',
  'cmd': 'Dev Tools',
  'bash': 'Dev Tools',
  'wt': 'Dev Tools',
  'alacritty': 'Dev Tools',
  'kitty': 'Dev Tools',
  // Design
  'figma': 'Design',
  'Figma': 'Design',
  'photoshop': 'Design',
  'illustrator': 'Design',
  // Communication
  'slack': 'Communication',
  'Slack': 'Communication',
  'discord': 'Communication',
  'Discord': 'Communication',
  'teams': 'Communication',
  'ms-teams': 'Communication',
  // Docs
  'WINWORD': 'Docs',
  'EXCEL': 'Docs',
  'POWERPNT': 'Docs',
  'notepad': 'Docs',
  'Obsidian': 'Docs',
  'notion': 'Docs',
  // System
  'explorer': 'System',
  'taskmgr': 'System',
  'mmc': 'System',
  'regedit': 'System',
  'nautilus': 'System',
  'dolphin': 'System',
};

// ── Built-in Window Title Keyword → Category Map ──
// Scans window title for keywords that strongly indicate a category.

const TITLE_KEYWORD_MAP = [
  // Project-specific sites (check first — most specific)
  { keywords: ['cvstomize', 'cvstomize.com'], category: 'cvstomize.com' },
  // Dev
  { keywords: ['github.com', 'gitlab.com', 'bitbucket.org'], category: 'Code Patterns' },
  { keywords: ['stack overflow', 'stackoverflow.com'], category: 'Code Patterns' },
  { keywords: ['docker', 'container', 'kubernetes', 'k8s'], category: 'Dev Tools' },
  { keywords: ['npm', 'node_modules', 'package.json'], category: 'Dev Tools' },
  { keywords: ['.py ', '.js ', '.ts ', '.go ', '.rs ', '.java '], category: 'Code Patterns' },
  // Hardware
  { keywords: ['gpu', 'nvidia', 'amd radeon', 'cuda', 'vram', 'driver'], category: 'Hardware/GPU' },
  { keywords: ['bios', 'uefi', 'motherboard', 'ram', 'memory'], category: 'Hardware/GPU' },
  // AI/LLM
  { keywords: ['ollama', 'llama', 'gemini', 'chatgpt', 'claude', 'openai', 'hugging face', 'model'], category: 'LLM Setup' },
  { keywords: ['vertex ai', 'ai studio', 'transformer'], category: 'LLM Setup' },
  // PowerToys
  { keywords: ['powertoys', 'fancyzones', 'powerrename'], category: 'PowerToys' },
];

// ── Comment Keyword → Category Map ──
// If the user typed certain words in their note, we can guess the category.

const COMMENT_KEYWORD_MAP = [
  { keywords: ['bug', 'error', 'crash', 'fix', 'broken', 'failed', 'exception', 'stack trace'], category: 'Troubleshooting' },
  { keywords: ['install', 'setup', 'config', 'configure', 'env', 'environment'], category: 'Dev Tools' },
  { keywords: ['gpu', 'nvidia', 'driver', 'cuda', 'vram'], category: 'Hardware/GPU' },
  { keywords: ['idea', 'maybe', 'could we', 'what if', 'brainstorm'], category: 'Ideas' },
  { keywords: ['shortcut', 'hotkey', 'keybind', 'keyboard'], category: 'Shortcuts & Hotkeys' },
  { keywords: ['powertoys', 'fancy zones', 'power rename'], category: 'PowerToys' },
  { keywords: ['ollama', 'llm', 'gemini', 'chatgpt', 'claude', 'ai model', 'prompt'], category: 'LLM Setup' },
];

// ── Matching Functions ──

/** Match project by repo folder name in window title. */
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

  // Also try matching project NAME in window title
  for (const p of projects) {
    if (p.name && titleLower.includes(p.name.toLowerCase())) return p.id;
  }

  return null;
}

/** Match category by process name. */
function matchByProcess(processName) {
  if (!processName) return null;
  return PROCESS_CATEGORY_MAP[processName] || null;
}

/** Match category by keywords in window title. */
function matchByTitleKeywords(windowTitle) {
  if (!windowTitle) return null;
  const titleLower = windowTitle.toLowerCase();
  for (const rule of TITLE_KEYWORD_MAP) {
    if (rule.keywords.some(kw => titleLower.includes(kw.toLowerCase()))) {
      return rule.category;
    }
  }
  return null;
}

/** Match category by keywords in the user's comment. */
function matchByComment(comment) {
  if (!comment) return null;
  const commentLower = comment.toLowerCase();
  for (const rule of COMMENT_KEYWORD_MAP) {
    if (rule.keywords.some(kw => commentLower.includes(kw.toLowerCase()))) {
      return rule.category;
    }
  }
  return null;
}

/** Ensure the category exists (create if needed from built-in maps). */
async function ensureCategoryExists(categoryName) {
  if (!categoryName) return null;
  const { categories } = await getCached();
  // Check if it already exists (case-insensitive)
  const match = categories.find(c => c.toLowerCase() === categoryName.toLowerCase());
  if (match) return match;
  // Create the new category
  await db.saveCategory(categoryName);
  invalidateCache();
  return categoryName;
}

/** Evaluate user-defined window_rules table. */
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
      try {
        if (!rule._compiledRegex) rule._compiledRegex = new RegExp(rule.pattern, 'i');
        matched = rule._compiledRegex.test(target);
      } catch { /* invalid regex */ }
    }

    if (matched) {
      if (!categoryId && rule.category_id) categoryId = rule.category_id;
      if (!projectId && rule.project_id) projectId = rule.project_id;
      if (categoryId && projectId) break;
    }
  }

  return { categoryId, projectId };
}

// ── Main Entry Point ──

/**
 * Run the full rule-based categorization pipeline.
 * Tries multiple strategies in order. Returns as soon as one matches.
 *
 * @param {string|null} windowTitle
 * @param {string|null} processName
 * @param {string|null} comment - the user's note text
 * @returns {Promise<{ category: string|null, projectId: number|null }>}
 */
async function categorize(windowTitle, processName, comment) {
  // 1. Auto-match project from repo_path or project name in title
  const autoProject = await autoMatchProject(windowTitle);

  // 2. Evaluate explicit user-defined window rules (highest priority for category)
  const ruleResult = await evaluateRules(windowTitle, processName);
  let category = null;
  if (ruleResult.categoryId) {
    category = await db.getCategoryName(ruleResult.categoryId);
  }

  // 3. Match category by title keywords FIRST (most specific — e.g., "cvstomize.com")
  if (!category) {
    const titleCat = matchByTitleKeywords(windowTitle);
    if (titleCat) category = await ensureCategoryExists(titleCat);
  }

  // 4. Match category by comment keywords (e.g., "bug" → Troubleshooting)
  if (!category) {
    const commentCat = matchByComment(comment);
    if (commentCat) category = await ensureCategoryExists(commentCat);
  }

  // 5. Match category by process name LAST (broadest — e.g., "chrome" → Web)
  if (!category) {
    const processCat = matchByProcess(processName);
    if (processCat) category = await ensureCategoryExists(processCat);
  }

  return {
    category,
    projectId: ruleResult.projectId || autoProject || null,
  };
}

module.exports = { categorize, autoMatchProject, evaluateRules, invalidateCache };
