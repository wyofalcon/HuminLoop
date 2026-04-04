// src/workflow-context.js — Read AI dev workflow context from a project's repo
const fs = require('fs');
const path = require('path');

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

module.exports = { readSessionContext, readAuditFindings, hasWorkflow };
