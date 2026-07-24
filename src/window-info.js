// src/window-info.js — Capture active window metadata (title + process)
// Cross-platform: Windows (PowerShell/Win32), Linux (xdotool/gdbus)
// Zero npm dependencies — uses native OS tools via child_process

const { execSync, execFileSync, execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { normalizeRepoPath, canonicalRepoPath } = require('./repo-path');

const NULLS = { title: null, processName: null, processPath: null };

// ── Windows ──

const PS_SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'get-window.ps1');

function ensureWindowsScript() {
  const dir = path.dirname(PS_SCRIPT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(PS_SCRIPT_PATH)) {
    fs.writeFileSync(PS_SCRIPT_PATH, `
Add-Type -Name U -Namespace W -MemberDefinition @"
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int c);
"@ -ErrorAction SilentlyContinue

$h = [W.U]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][W.U]::GetWindowText($h, $sb, 512)
$wpid = [uint32]0
[void][W.U]::GetWindowThreadProcessId($h, [ref]$wpid)
$p = Get-Process -Id $wpid -ErrorAction SilentlyContinue
"$($sb.ToString())|$($p.ProcessName)|$($p.Path)"
`, 'utf8');
  }
}

function getActiveWindowWindows() {
  ensureWindowsScript();
  const out = execFileSync('powershell', [
    '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass',
    '-File', PS_SCRIPT_PATH,
  ], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();

  const [title, processName, processPath] = out.split('|');
  return {
    title: title || null,
    processName: processName || null,
    processPath: processPath || null,
  };
}

// ── Linux ──

let linuxMethod = null; // cached detection: 'xdotool' | 'gdbus' | 'none'

function detectLinuxMethod() {
  if (linuxMethod !== null) return linuxMethod;

  // Check for xdotool first (works on X11, including WSLg)
  try {
    execSync('which xdotool', { encoding: 'utf8', timeout: 2000 });
    linuxMethod = 'xdotool';
    return linuxMethod;
  } catch {}

  // Check for gdbus (Wayland + GNOME)
  const sessionType = process.env.XDG_SESSION_TYPE || '';
  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  if (sessionType === 'wayland' && desktop.includes('gnome')) {
    try {
      execSync('which gdbus', { encoding: 'utf8', timeout: 2000 });
      linuxMethod = 'gdbus';
      return linuxMethod;
    } catch {}
  }

  console.log('[WindowInfo] No window info tool found. Install xdotool: sudo apt install xdotool');
  linuxMethod = 'none';
  return linuxMethod;
}

function getProcessInfo(pid) {
  if (!pid) return { processName: null, processPath: null };
  try {
    const processName = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    let processPath = null;
    try { processPath = fs.readlinkSync(`/proc/${pid}/exe`); } catch {}
    return { processName, processPath };
  } catch {
    return { processName: null, processPath: null };
  }
}

function getActiveWindowXdotool() {
  const winId = execSync('xdotool getactivewindow', { encoding: 'utf8', timeout: 2000 }).trim();
  const title = execSync(`xdotool getwindowname ${winId}`, { encoding: 'utf8', timeout: 2000 }).trim();
  const pid = execSync(`xdotool getwindowpid ${winId}`, { encoding: 'utf8', timeout: 2000 }).trim();
  const { processName, processPath } = getProcessInfo(pid);
  return { title: title || null, processName, processPath };
}

function getActiveWindowGdbus() {
  const jsCode = 'let w = global.display.focus_window; JSON.stringify({title: w.get_title(), pid: w.get_pid()})';
  const out = execSync(
    `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "${jsCode}"`,
    { encoding: 'utf8', timeout: 2000 }
  ).trim();
  // gdbus returns: (true, '{"title":"...","pid":1234}')
  const jsonMatch = out.match(/'({.*})'/);
  if (!jsonMatch) return NULLS;
  const data = JSON.parse(jsonMatch[1]);
  const { processName, processPath } = getProcessInfo(data.pid);
  return { title: data.title || null, processName, processPath };
}

function getActiveWindowLinux() {
  const method = detectLinuxMethod();
  if (method === 'xdotool') return getActiveWindowXdotool();
  if (method === 'gdbus') return getActiveWindowGdbus();
  return NULLS;
}

// ── IDE window enumeration ──
// Lists every open VS Code window so the viewer can offer "connect this
// project to that window". Inside WSL the interesting VS Code windows are
// usually Windows-host processes (invisible to xdotool), so WSL enumerates
// through powershell.exe interop in addition to xdotool.

const LIST_SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'list-windows.ps1');

function ensureListScript() {
  const dir = path.dirname(LIST_SCRIPT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(LIST_SCRIPT_PATH)) {
    fs.writeFileSync(LIST_SCRIPT_PATH, `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Run() {
    var rows = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      rows.Add(pid.ToString() + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
"@ -ErrorAction SilentlyContinue
$names = @{}
Get-Process | ForEach-Object { $names[$_.Id] = $_.ProcessName }
[WinEnum]::Run() | ForEach-Object {
  $parts = $_.Split('|', 2)
  $pn = $names[[int]$parts[0]]
  "$($parts[0])|$pn|$($parts[1])"
}
`, 'utf8');
  }
}

let _isWSL = null;
function isWSL() {
  if (_isWSL !== null) return _isWSL;
  try {
    _isWSL = process.platform === 'linux' && /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch { _isWSL = false; }
  return _isWSL;
}

/**
 * Parse a VS Code window title into its workspace folder.
 * "● index.js - HuminLoop [WSL: Ubuntu] - Visual Studio Code" →
 * { folder: 'HuminLoop', remote: 'WSL: Ubuntu' }. Returns null for
 * non-VS-Code titles.
 */
function parseVSCodeWindowTitle(title) {
  if (!title) return null;
  const t = String(title).trim().replace(/\s*\[Administrator\]$/i, '');
  const m = t.match(/^(.+)\s-\s(?:Visual Studio Code(?: - Insiders)?|VSCodium)$/);
  if (!m) return null;
  const parts = m[1].split(' - ');
  let folder = parts[parts.length - 1].trim().replace(/^●\s*/, '');
  let remote = null;
  const rm = folder.match(/^(.*?)\s*\[([^\]]+)\]$/);
  if (rm) { folder = rm[1].trim(); remote = rm[2].trim(); }
  folder = folder.replace(/\s*\(Workspace\)$/i, '');
  if (!folder) return null;
  return { folder, remote };
}

// Rows come back as "pid|processName|title"; titles may contain '|'.
function parseWindowsEnumOutput(out) {
  const wins = [];
  for (const line of String(out).split('\n')) {
    const row = line.trim();
    const a = row.indexOf('|');
    const b = row.indexOf('|', a + 1);
    if (a < 0 || b < 0) continue;
    const processName = row.slice(a + 1, b);
    const title = row.slice(b + 1);
    const parsed = parseVSCodeWindowTitle(title);
    if (parsed) wins.push({ title, processName: processName || null, ...parsed });
  }
  return wins;
}

function listWindowsHostWindows(shell) {
  return new Promise((resolve) => {
    try {
      ensureListScript();
      let scriptPath = LIST_SCRIPT_PATH;
      if (shell === 'powershell.exe') {
        // Host PowerShell needs the Windows (UNC) form of a WSL path.
        scriptPath = execFileSync('wslpath', ['-w', LIST_SCRIPT_PATH], { encoding: 'utf8', timeout: 3000 }).trim();
      }
      execFile(shell, [
        '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
      ], { encoding: 'utf8', timeout: 10000, windowsHide: true }, (err, out) => {
        if (err) return resolve([]);
        resolve(parseWindowsEnumOutput(out));
      });
    } catch { resolve([]); }
  });
}

function listXdotoolWindows() {
  return new Promise((resolve) => {
    if (detectLinuxMethod() !== 'xdotool') return resolve([]);
    exec('xdotool search --onlyvisible --name "Visual Studio Code" getwindowname %@', { encoding: 'utf8', timeout: 3000 }, (err, out) => {
      if (err) return resolve([]); // non-zero exit also means "no matches"
      const wins = [];
      for (const line of String(out).split('\n')) {
        const title = line.trim();
        const parsed = title && parseVSCodeWindowTitle(title);
        if (parsed) wins.push({ title, processName: null, ...parsed });
      }
      resolve(wins);
    });
  });
}

// ── VS Code Open-Workspace Paths ──
// Window titles only carry the workspace folder *name*. VS Code's storage.json
// (User/globalStorage) records the windows it actually has open — windowsState
// plus backupWorkspaces — with full folder URIs, so matching a title's folder
// name against those entries recovers the absolute repo path. Plain JSON,
// read-only; covers Linux-native installs and (under WSL) the Windows-host
// install whose windows arrive via the powershell.exe interop.

const VSCODE_VARIANTS = ['Code', 'Code - Insiders', 'VSCodium'];

function vscodeStorageFiles() {
  const files = [];
  const add = (root) => files.push(path.join(root, 'User', 'globalStorage', 'storage.json'));
  if (process.platform === 'win32' && process.env.APPDATA) {
    for (const v of VSCODE_VARIANTS) add(path.join(process.env.APPDATA, v));
  }
  if (process.platform === 'linux') {
    for (const v of VSCODE_VARIANTS) add(path.join(os.homedir(), '.config', v));
    if (isWSL()) {
      let users = [];
      try { users = fs.readdirSync('/mnt/c/Users'); } catch {}
      for (const u of users) {
        for (const v of VSCODE_VARIANTS) add(path.join('/mnt/c/Users', u, 'AppData', 'Roaming', v));
      }
    }
  }
  return files;
}

/**
 * Convert a VS Code workspace URI into a filesystem path usable by this
 * process. Returns { path, wsl } (wsl = lowercase distro when the folder lives
 * inside a WSL distro) or null for unreachable remotes (SSH, containers, vfs).
 */
function vscodeUriToPath(uri) {
  if (typeof uri !== 'string') return null;
  let m = uri.match(/^vscode-remote:\/\/([^/]+)(\/.*)$/);
  if (m) {
    const authority = decodeURIComponent(m[1]);
    if (!/^wsl\+/i.test(authority)) return null;
    return { path: decodeURIComponent(m[2]), wsl: authority.slice(4).toLowerCase() };
  }
  m = uri.match(/^file:\/\/([^/]*)(\/.*)$/);
  if (!m) return null;
  const p = decodeURIComponent(m[2]);
  if (m[1]) {
    // UNC authority (file://wsl.localhost/Distro/home/…) — fold to the Linux form.
    if (!/^wsl\.localhost$|^wsl\$$/i.test(m[1])) return null;
    const distro = (p.split('/')[1] || '').toLowerCase();
    return distro ? { path: normalizeRepoPath('//' + m[1] + p), wsl: distro } : null;
  }
  const drive = p.match(/^\/([a-zA-Z]):(\/.*)?$/);
  if (drive) {
    if (process.platform === 'win32') return { path: (drive[1].toUpperCase() + ':' + (drive[2] || '/')).replace(/\//g, '\\'), wsl: null };
    return { path: '/mnt/' + drive[1].toLowerCase() + (drive[2] || ''), wsl: null };
  }
  return { path: p, wsl: null };
}

/**
 * Ordered path candidates from every reachable storage.json: current windows
 * first (windowsState), then live backup registrations — backupWorkspaces is
 * updated the moment a window opens, so it covers windows newer than the last
 * windowsState flush. Deduped per (distro, canonical path).
 */
function collectVSCodePaths() {
  const candidates = [];
  const seen = new Set();
  const push = (uri, remoteAuthority) => {
    const conv = uri && vscodeUriToPath(uri);
    if (!conv || !conv.path) return;
    let wsl = conv.wsl;
    if (!wsl && typeof remoteAuthority === 'string' && /^wsl\+/i.test(remoteAuthority)) {
      wsl = decodeURIComponent(remoteAuthority).slice(4).toLowerCase();
    }
    const repo = normalizeRepoPath(conv.path); // also strips *.code-workspace files
    if (!repo) return;
    const key = (wsl || 'local') + '|' + canonicalRepoPath(repo);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: repo, wsl });
  };
  for (const file of vscodeStorageFiles()) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const ws = data.windowsState || {};
    for (const w of [ws.lastActiveWindow, ...(Array.isArray(ws.openedWindows) ? ws.openedWindows : [])]) {
      if (w) push(w.folder || (w.workspaceIdentifier || {}).configURIPath, w.remoteAuthority);
    }
    const b = data.backupWorkspaces || {};
    for (const f of (Array.isArray(b.folders) ? b.folders : [])) { if (f) push(f.folderUri, f.remoteAuthority); }
    for (const w of (Array.isArray(b.workspaces) ? b.workspaces : [])) { if (w) push(w.configURIPath, w.remoteAuthority); }
  }
  return candidates;
}

/**
 * Match one enumerated window to a candidate path by folder name. Local windows
 * only match local paths; "WSL: <distro>" windows only match WSL paths (same
 * distro preferred). First hit wins — candidates are ordered most-current-first.
 * Extra same-name hits come back as alternates so the UI can flag ambiguity.
 */
function resolveWindowPath(win, candidates) {
  if (!win || !win.folder) return null;
  const wslLabel = win.remote ? win.remote.match(/^WSL:\s*(.+)$/i) : null;
  if (win.remote && !wslLabel) return null; // SSH / container remote: no local path
  const name = win.folder.toLowerCase();
  let pool = candidates.filter((c) => {
    const base = c.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
    return base.toLowerCase() === name && (wslLabel ? !!c.wsl : !c.wsl);
  });
  if (wslLabel) {
    const exact = pool.filter((c) => c.wsl === wslLabel[1].trim().toLowerCase());
    if (exact.length) pool = exact;
  }
  if (!pool.length) return null;
  return { path: pool[0].path, alternates: pool.slice(1).map((c) => c.path) };
}

/**
 * List open VS Code windows across every reachable display server, each
 * annotated with its absolute workspace path when VS Code's own state can
 * resolve it (path + pathAlternates for same-name ambiguity). Never rejects.
 * @returns {Promise<Array<{title, folder, remote, processName, path?, pathAlternates?}>>}
 */
async function listIDEWindows() {
  const jobs = [];
  if (process.platform === 'win32') jobs.push(listWindowsHostWindows('powershell'));
  if (process.platform === 'linux') {
    jobs.push(listXdotoolWindows());
    if (isWSL()) jobs.push(listWindowsHostWindows('powershell.exe'));
  }
  const results = await Promise.all(jobs);
  const seen = new Set();
  const wins = results.flat().filter((w) => {
    if (seen.has(w.title)) return false;
    seen.add(w.title);
    return true;
  });
  let candidates = [];
  try { candidates = collectVSCodePaths(); } catch {}
  for (const w of wins) {
    const hit = resolveWindowPath(w, candidates);
    if (hit) {
      w.path = hit.path;
      if (hit.alternates.length) w.pathAlternates = hit.alternates;
    }
  }
  return wins;
}

// ── Public API ──

/**
 * Get the currently focused window's title and process name.
 * Must be called synchronously BEFORE opening the capture popup.
 *
 * @returns {{ title: string|null, processName: string|null, processPath: string|null }}
 */
function getActiveWindow() {
  try {
    if (process.platform === 'win32') return getActiveWindowWindows();
    if (process.platform === 'linux') return getActiveWindowLinux();
    // macOS: future support
    return NULLS;
  } catch (e) {
    console.error('[WindowInfo] Failed to get active window:', e.message);
    return NULLS;
  }
}

/**
 * Async variant for polling (demo activity tracker). The sync version blocks
 * the main-process event loop for the child process's lifetime (PowerShell
 * startup is hundreds of ms) — fine for one-shot capture, not for polling
 * while MediaRecorder chunks stream over IPC. Never rejects.
 */
function getActiveWindowAsync() {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        ensureWindowsScript();
        execFile('powershell', [
          '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass',
          '-File', PS_SCRIPT_PATH,
        ], { encoding: 'utf8', timeout: 3000, windowsHide: true }, (err, out) => {
          if (err) return resolve(NULLS);
          const [title, processName, processPath] = String(out).trim().split('|');
          resolve({ title: title || null, processName: processName || null, processPath: processPath || null });
        });
      } else if (process.platform === 'linux' && detectLinuxMethod() === 'xdotool') {
        // Chained: prints the active window's name, then its pid, one per line.
        exec('xdotool getactivewindow getwindowname getwindowpid', { encoding: 'utf8', timeout: 2000 }, (err, out) => {
          if (err) return resolve(NULLS);
          const lines = String(out).trim().split('\n');
          const { processName, processPath } = getProcessInfo(lines[1] && lines[1].trim());
          resolve({ title: (lines[0] || '').trim() || null, processName, processPath });
        });
      } else {
        // gdbus / unsupported: fall back to nothing rather than blocking.
        resolve(NULLS);
      }
    } catch {
      resolve(NULLS);
    }
  });
}

module.exports = { getActiveWindow, getActiveWindowAsync, listIDEWindows, parseVSCodeWindowTitle };
