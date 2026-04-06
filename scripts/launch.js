// scripts/launch.js — Launch Electron with ELECTRON_RUN_AS_NODE unset
// Fixes: VS Code / Claude Code shells set ELECTRON_RUN_AS_NODE=1,
// which makes Electron run as plain Node.js (no GUI modules).

delete process.env.ELECTRON_RUN_AS_NODE;

// --dev flag sets HUMINLOOP_DEV for dev mode
if (process.argv.includes('--dev')) {
  process.env.HUMINLOOP_DEV = '1';
}

const { spawn } = require('child_process');
const electron = require('electron');

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code));
