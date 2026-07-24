// src/repo-path.js — single source of truth for repo_path cleanup + comparison.
// Every repo_path that gets stored goes through normalizeRepoPath(); every
// equality check between two repo paths goes through repoPathsEqual(). The MCP
// server (mcp-server/index.js) keeps its own copy of this logic because it is a
// standalone package that runs outside the Electron process — keep the two in sync.

function normalizeRepoPath(p) {
  if (!p) return p;
  p = p.replace(/^["']|["']$/g, '').trim(); // strip wrapping quotes
  p = p.replace(/[\\/][^\\/]+\.code-workspace$/i, ''); // strip workspace file
  // WSL UNC paths from Windows tooling resolve to the same place as the Linux
  // path. Canonicalize to the Linux form so a Windows-side MCP and a Linux-side
  // capture both match the same project row.
  const wslMatch = p.replace(/\\/g, '/').match(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i);
  if (wslMatch) p = wslMatch[1] || '/';
  return p;
}

// Comparison form: normalized, forward slashes, no trailing slash, lowercase.
// Never store this form — it loses case, which matters on Linux filesystems.
function canonicalRepoPath(p) {
  const n = normalizeRepoPath(p);
  return (n || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function repoPathsEqual(a, b) {
  const ca = canonicalRepoPath(a);
  return !!ca && ca === canonicalRepoPath(b);
}

module.exports = { normalizeRepoPath, canonicalRepoPath, repoPathsEqual };
