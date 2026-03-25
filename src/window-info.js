// src/window-info.js — Capture active window metadata (title + process)
// Cross-platform: Windows (PowerShell/Win32), Linux (xdotool/gdbus)
// Zero npm dependencies — uses native OS tools via child_process

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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

module.exports = { getActiveWindow };
