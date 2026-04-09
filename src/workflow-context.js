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
 * Read pending prompts from PROMPT_TRACKER.log.
 * Returns array of prompt objects with status !== DONE or FAILED.
 * @param {string} repoPath — absolute path to the project repository
 */
function getPendingPrompts(repoPath) {
  if (!repoPath) return [];
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'PROMPT_TRACKER.log');
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const parts = line.split('|');
      return {
        id: parts[0], status: parts[1], timestamp: parts[2], description: parts[3],
        type: parts[4] || 'CRAFTED', parentId: parts[5] || null,
        files: parts[6] ? parts[6].split(',').filter(Boolean) : [],
      };
    }).filter(p => p.status !== 'DONE' && p.status !== 'FAILED');
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

module.exports = {
  readSessionContext, readAuditFindings, hasWorkflow,
  getGitState, getPendingPrompts, readRelayMode, assembleBundle,
};
