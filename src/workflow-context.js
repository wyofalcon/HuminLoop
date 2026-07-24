// src/workflow-context.js — Read AI dev workflow context from a project's repo
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Read SESSION.md from a project's .ai-workflow/context/ directory.
 * Returns the file contents as a string, or null if not found.
 * @param {string} repoPath — absolute path to the project repository
 */
function readSessionContext(repoPath) {
  if (!repoPath) return null;
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'SESSION.md');
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Read AUDIT_LOG.md from a project's .ai-workflow/context/ directory.
 * Returns the file contents as a string, or null if not found.
 * @param {string} repoPath — absolute path to the project repository
 */
function readAuditFindings(repoPath) {
  if (!repoPath) return null;
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'AUDIT_LOG.md');
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Check if a project has an AI dev workflow set up.
 * @param {string} repoPath — absolute path to the project repository
 */
function hasWorkflow(repoPath) {
  if (!repoPath) return false;
  return fs.existsSync(path.join(repoPath, '.ai-workflow'));
}

/**
 * Get git state (branch, recent commits, dirty files) for a repo.
 * Returns null if repoPath is missing or git fails.
 * @param {string} repoPath — absolute path to the project repository
 */
function getGitState(repoPath) {
  if (!repoPath) return null;
  try {
    const opts = { cwd: repoPath, encoding: 'utf8', timeout: 5000 };
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    const logRaw = execSync('git log --oneline -5', opts).trim();
    const lastCommits = logRaw ? logRaw.split('\n').map(line => {
      const [hash, ...rest] = line.split(' ');
      return { hash, message: rest.join(' ') };
    }) : [];
    const statusRaw = execSync('git status --porcelain', opts).trim();
    const dirtyFiles = statusRaw ? statusRaw.split('\n').map(line => ({
      status: line.substring(0, 2).trim(),
      file: line.substring(3),
    })) : [];
    return { branch, lastCommits, dirtyFiles };
  } catch {
    return null;
  }
}

/**
 * Parse one PROMPT_TRACKER.log line: id|status|timestamp|description|type|parentId|files
 */
function parseTrackerLine(line) {
  const parts = line.split('|');
  return {
    id: parts[0], status: parts[1], timestamp: parts[2], description: parts[3],
    type: parts[4] || 'CRAFTED', parentId: parts[5] || null,
    files: parts[6] ? parts[6].split(',').filter(Boolean) : [],
  };
}

function readTrackerLines(repoPath) {
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'PROMPT_TRACKER.log');
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  return raw ? raw.split('\n').map(parseTrackerLine) : [];
}

/**
 * Read pending prompts from PROMPT_TRACKER.log.
 * Returns array of prompt objects with status !== DONE or FAILED.
 * @param {string} repoPath — absolute path to the project repository
 */
function getPendingPrompts(repoPath) {
  if (!repoPath) return [];
  try {
    return readTrackerLines(repoPath).filter(p => p.status !== 'DONE' && p.status !== 'FAILED');
  } catch {
    return [];
  }
}

/**
 * Read relay mode from RELAY_MODE file. Returns 'review' as default.
 * @param {string} repoPath — absolute path to the project repository
 */
function readRelayMode(repoPath) {
  if (!repoPath) return 'review';
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'RELAY_MODE');
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || 'review';
  } catch {
    return 'review';
  }
}

function readAuditMode(repoPath) {
  if (!repoPath) return 'off';
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'AUDIT_WATCH_MODE');
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || 'off';
  } catch {
    return 'off';
  }
}

function setRelayMode(repoPath, mode) {
  if (!repoPath || !mode) return null;
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'RELAY_MODE');
  fs.writeFileSync(filePath, mode, 'utf8');
  return mode;
}

function setAuditMode(repoPath, mode) {
  if (!repoPath || !mode) return null;
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'AUDIT_WATCH_MODE');
  fs.writeFileSync(filePath, mode, 'utf8');
  return mode;
}

function readChangelog(repoPath) {
  if (!repoPath) return null;
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'CHANGELOG.md');
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readAllPrompts(repoPath) {
  if (!repoPath) return [];
  try {
    return readTrackerLines(repoPath).reverse();
  } catch {
    return [];
  }
}

function updatePromptTracker(repoPath, promptId, newStatus, files = null) {
  if (!repoPath || !promptId) return false;
  const trackerPath = path.join(repoPath, '.ai-workflow', 'context', 'PROMPT_TRACKER.log');
  try {
    const raw = fs.readFileSync(trackerPath, 'utf8');
    const lines = raw.split('\n');
    let touched = false;
    const newLines = lines.map(line => {
      if (line.startsWith(promptId + '|')) {
        const parts = line.split('|');
        parts[1] = newStatus;
        if (files) {
          while (parts.length < 7) parts.push('');
          parts[6] = Array.isArray(files) ? files.join(',') : files;
        }
        touched = true;
        return parts.join('|');
      }
      return line;
    });
    if (!touched) return false;
    fs.writeFileSync(trackerPath, newLines.join('\n'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Assemble a full workflow context bundle for a clip + project.
 * Used by Bundle & Send (Task 4) to build IDE context payloads.
 * @param {string} repoPath — absolute path to the project repository
 * @param {object} clip — clip record
 * @param {object} project — project record
 */
function assembleBundle(repoPath, clip, project) {
  return {
    userIntent: clip.comment || '',
    aiInterpretation: clip.aiFixPrompt || null,
    project: { name: project.name, repoPath: project.repo_path, description: project.description },
    git: getGitState(repoPath),
    session: readSessionContext(repoPath),
    auditFindings: readAuditFindings(repoPath),
    pendingPrompts: getPendingPrompts(repoPath),
    relayMode: readRelayMode(repoPath),
  };
}

/**
 * Get the path to the bundled workflow templates directory.
 * Checks dev path first (project root), then packaged resources path.
 */
function getTemplateDir() {
  const appDir = path.join(__dirname, '..');
  const devPath = path.join(appDir, 'workflow-templates');
  if (fs.existsSync(devPath)) return devPath;
  const resourcesPath = path.join(process.resourcesPath || appDir, 'workflow-templates');
  if (fs.existsSync(resourcesPath)) return resourcesPath;
  return devPath;
}

// Git hooks installed into project repos. prepare-commit-msg marks tracked
// prompts DONE on commit; post-commit refreshes SESSION.md so the IDE AI and
// the Workflow tab always see current git state.
const HOOK_NAMES = ['prepare-commit-msg', 'post-commit'];

/**
 * Install one HuminLoop git hook into a project repo.
 * Appends to an existing hook if present, otherwise creates a new one.
 * Idempotent via marker comment.
 * @param {string} repoPath — absolute path to the project repository
 * @param {string} templateDir — path to the workflow-templates directory
 * @param {string} hookName — hook filename (e.g. 'prepare-commit-msg')
 * @returns {boolean} true if the hook was installed or appended
 */
function installGitHook(repoPath, templateDir, hookName = 'prepare-commit-msg') {
  const hooksDir = path.join(repoPath, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) return false;

  const hookPath = path.join(hooksDir, hookName);
  const templateHook = path.join(templateDir, 'hooks', hookName);
  if (!fs.existsSync(templateHook)) return false;

  const hookContent = fs.readFileSync(templateHook, 'utf8');
  const marker = '# --- HuminLoop Dev Workflow ---';

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(marker)) return false;
    fs.appendFileSync(hookPath, `\n\n${marker}\n${hookContent}\n`, 'utf8');
  } else {
    fs.writeFileSync(hookPath, `#!/bin/bash\n\n${marker}\n${hookContent}\n`, 'utf8');
  }

  try { fs.chmodSync(hookPath, '755'); } catch {}
  return true;
}

function installGitHooks(repoPath, templateDir) {
  return HOOK_NAMES.filter(h => installGitHook(repoPath, templateDir, h));
}

const WORKFLOW_DIRS = ['instructions', 'context', 'scripts', 'config'];

function contextFileDefaults(repoPath, projectName) {
  const now = new Date().toISOString();
  let branch = 'main';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
  } catch {}
  return {
    'SESSION.md': `# Session Context\n\n- Branch: ${branch}\n- Initialized: ${now}\n- Project: ${projectName}\n`,
    'PROMPT_TRACKER.log': '',
    'RELAY_MODE': 'review',
    'AUDIT_WATCH_MODE': 'off',
    'CHANGELOG.md': `# Changelog\n\nInitialized ${now}\n`,
    'AUDIT_LOG.md': `# Audit Log\n`,
  };
}

/**
 * Scaffold a full .ai-workflow directory for a project from bundled templates.
 * Creates directory structure, copies/substitutes templates, initializes context files,
 * writes API port config, and installs the git hooks.
 * If .ai-workflow already exists, repairs it instead (fills in anything missing
 * without touching existing files).
 * @param {string} repoPath — absolute path to the project repository
 * @param {string} projectName — display name of the project
 * @param {number} apiPort — HuminLoop API port (default 7277)
 * @returns {{ success: boolean, reason?: string, repaired?: string[] }}
 */
function scaffoldWorkflow(repoPath, projectName, apiPort = 7277) {
  if (!repoPath) return { success: false, reason: 'no_repo_path' };
  if (!fs.existsSync(repoPath)) return { success: false, reason: 'repo_path_not_found' };
  try {
    if (!fs.statSync(repoPath).isDirectory()) return { success: false, reason: 'repo_path_not_directory' };
  } catch {
    return { success: false, reason: 'repo_path_inaccessible' };
  }
  const workflowDir = path.join(repoPath, '.ai-workflow');
  if (fs.existsSync(workflowDir)) {
    return repairWorkflow(repoPath, projectName, apiPort);
  }

  const templateDir = getTemplateDir();

  WORKFLOW_DIRS.forEach(d => fs.mkdirSync(path.join(workflowDir, d), { recursive: true }));

  // Copy and substitute instruction templates
  const instructionFiles = ['SHARED.md', 'ARCHITECT.md', 'BUILDER.md', 'REVIEWER.md', 'SCREENER.md'];
  instructionFiles.forEach(f => {
    const src = path.join(templateDir, 'instructions', f);
    if (fs.existsSync(src)) {
      let content = fs.readFileSync(src, 'utf8');
      content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
      content = content.replace(/\{\{REPO_PATH\}\}/g, repoPath);
      fs.writeFileSync(path.join(workflowDir, 'instructions', f), content, 'utf8');
    }
  });

  // Copy scripts
  const scriptsDir = path.join(templateDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    fs.readdirSync(scriptsDir).forEach(f => {
      fs.copyFileSync(path.join(scriptsDir, f), path.join(workflowDir, 'scripts', f));
    });
  }

  // Initialize context files
  const defaults = contextFileDefaults(repoPath, projectName);
  for (const [f, content] of Object.entries(defaults)) {
    fs.writeFileSync(path.join(workflowDir, 'context', f), content, 'utf8');
  }

  // Write API port config
  fs.writeFileSync(path.join(workflowDir, 'config', 'api-port'), String(apiPort), 'utf8');

  installGitHooks(repoPath, templateDir);

  return { success: true };
}

/**
 * Repair an existing .ai-workflow directory: create any missing subdirectories
 * and context files, write config/api-port if absent, and install any missing
 * git hooks. Never overwrites existing files. Heals hand-bootstrapped or
 * partially-migrated workflow dirs (e.g. missing PROMPT_TRACKER.log or hooks).
 * @returns {{ success: boolean, reason?: string, repaired: string[] }}
 */
function repairWorkflow(repoPath, projectName, apiPort = 7277) {
  if (!repoPath) return { success: false, reason: 'no_repo_path', repaired: [] };
  const workflowDir = path.join(repoPath, '.ai-workflow');
  if (!fs.existsSync(workflowDir)) return { success: false, reason: 'not_initialized', repaired: [] };

  const repaired = [];
  const templateDir = getTemplateDir();

  WORKFLOW_DIRS.forEach(d => {
    const p = path.join(workflowDir, d);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      repaired.push(`created ${d}/`);
    }
  });

  const defaults = contextFileDefaults(repoPath, projectName);
  for (const [f, content] of Object.entries(defaults)) {
    const p = path.join(workflowDir, 'context', f);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, content, 'utf8');
      repaired.push(`created context/${f}`);
    }
  }

  const portFile = path.join(workflowDir, 'config', 'api-port');
  if (!fs.existsSync(portFile)) {
    fs.writeFileSync(portFile, String(apiPort), 'utf8');
    repaired.push('created config/api-port');
  }

  installGitHooks(repoPath, templateDir).forEach(h => repaired.push(`installed ${h} hook`));

  return { success: true, repaired };
}

module.exports = {
  readSessionContext, readAuditFindings, hasWorkflow,
  getGitState, getPendingPrompts, readRelayMode, assembleBundle,
  scaffoldWorkflow, repairWorkflow,
  readAuditMode, setRelayMode, setAuditMode,
  readChangelog, readAllPrompts, updatePromptTracker,
};
