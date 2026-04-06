// renderer/toolbar.js — Floating annotation toolbar logic

const toolbar = document.getElementById('toolbar');
const pill = document.getElementById('pill');
const projectNameEl = document.getElementById('projectName');

let isMinimized = false;

// ── Project Name ──

async function loadProjectName() {
  const name = await window.quickclip.getToolbarProject();
  if (name) {
    projectNameEl.textContent = name;
    projectNameEl.classList.add('active');
  } else {
    projectNameEl.textContent = 'No project';
    projectNameEl.classList.remove('active');
  }
}

// ── Draw Mode ──

let drawModeActive = false;
let activeDrawColor = null;
let textModeActive = false;

function switchColor(color) {
  activeDrawColor = color;
  updateColorDots();
  if (drawModeActive) {
    // Overlay already open — just switch color
    window.quickclip.enterDrawMode(color);
  } else {
    drawModeActive = true;
    window.quickclip.enterDrawMode(color);
  }
}

function updateColorDots() {
  document.querySelectorAll('.dot').forEach((dot) => dot.classList.remove('active'));
  if (activeDrawColor) {
    const dot = document.querySelector('.dot-' + activeDrawColor);
    if (dot) dot.classList.add('active');
  }
}

// Listen for draw mode exit (overlay closed via Esc/right-click)
window.quickclip.onDrawModeExited(() => {
  drawModeActive = false;
  activeDrawColor = null;
  updateColorDots();
  // Also reset text mode if draw mode fully exits
  textModeActive = false;
  document.getElementById('textBtn').classList.remove('active');
});

// ── Text Mode ──

function toggleTextMode() {
  textModeActive = !textModeActive;
  document.getElementById('textBtn').classList.toggle('active', textModeActive);
  window.quickclip.toggleTextMode(textModeActive);
}

window.quickclip.onTextModeExited(() => {
  textModeActive = false;
  document.getElementById('textBtn').classList.remove('active');
});

// ── Actions ──

function openHuminLoop() {
  window.quickclip.showMain();
}

function captureSnippet() {
  window.quickclip.takeSnippet();
}

// ── Minimize / Restore ──

function minimizeToolbar() {
  toolbar.classList.add('hidden');
  pill.classList.remove('hidden');
  isMinimized = true;
  window.quickclip.minimizeToolbar();
}

function restoreToolbar() {
  pill.classList.add('hidden');
  toolbar.classList.remove('hidden');
  isMinimized = false;
  window.quickclip.restoreToolbar();
}

function closeToolbar() {
  window.quickclip.closeToolbar();
}

// ── Init ──

loadProjectName();

// Refresh project name when main window notifies of changes
window.quickclip.onProjectsChanged(() => loadProjectName());
