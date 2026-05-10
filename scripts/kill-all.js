// Cross-platform stop for every HuminLoop-related process.
// POSIX: delegates to scripts/kill-all.sh (pgrep/kill).
// Windows: enumerates Win32_Process via PowerShell, taskkill survivors.
//
// Why this wrapper exists: Git Bash's pgrep cannot see native Windows
// processes, so the bash script silently exits "(nothing running)" while
// every electron.exe stays alive. Node + PowerShell can.

const { execSync, execFileSync, spawnSync } = require('child_process');
const path = require('path');

const FORCE = process.argv.includes('--force') || process.argv.includes('-9');

if (process.platform !== 'win32') {
  const r = spawnSync('bash', [path.join(__dirname, 'kill-all.sh'), ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

const PATTERNS = [
  /HuminLoop[\\/]scripts[\\/]launch\.js/i,
  /quickclip[\\/]scripts[\\/]launch\.js/i,
  /HuminLoop[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron/i,
  /quickclip[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron/i,
  /HuminLoop[\\/]mcp-server[\\/]index\.js/i,
  /quickclip[\\/]mcp-server[\\/]index\.js/i,
  /HuminLoop[\\/]src[\\/]main\.js/i,
  /quickclip[\\/]src[\\/]main\.js/i,
  /--user-data-dir=[^\s"]*huminloop/i,
  /--user-data-dir=[^\s"]*quickclip/i,
];

const SELF_PIDS = new Set([process.pid, process.ppid]);

function listProcesses() {
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  let out;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    console.error('Failed to enumerate processes via PowerShell:', e.message);
    process.exit(2);
  }
  let arr;
  try {
    arr = JSON.parse(out);
  } catch {
    return [];
  }
  return Array.isArray(arr) ? arr : [arr];
}

function findTargets() {
  return listProcesses().filter((p) => {
    if (!p || !p.CommandLine) return false;
    if (SELF_PIDS.has(p.ProcessId)) return false;
    return PATTERNS.some((rx) => rx.test(p.CommandLine));
  });
}

function killOne(pid, force) {
  const args = force ? ['/F', '/T', '/PID', String(pid)] : ['/T', '/PID', String(pid)];
  try {
    execFileSync('taskkill', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function format(p) {
  return `pid=${p.ProcessId} ${p.Name}`;
}

console.log('Stopping HuminLoop processes...');
const initial = findTargets();
if (!initial.length) {
  console.log('  (nothing running)');
  process.exit(0);
}

if (FORCE) {
  for (const t of initial) {
    console.log(`  [KILL] ${format(t)}`);
    killOne(t.ProcessId, true);
  }
} else {
  for (const t of initial) {
    console.log(`  [TERM] ${format(t)}`);
    killOne(t.ProcessId, false);
  }
  sleep(1000);
  const survivors = findTargets();
  for (const t of survivors) {
    console.log(`  [KILL] ${format(t)}`);
    killOne(t.ProcessId, true);
  }
}

let remaining = [];
for (let i = 0; i < 6; i++) {
  remaining = findTargets();
  if (!remaining.length) break;
  sleep(500);
}

if (remaining.length) {
  console.log('Some processes survived. Re-run with --force.');
  for (const t of remaining) console.log(`    ${format(t)}`);
  process.exit(1);
}

console.log('All HuminLoop processes stopped.');
