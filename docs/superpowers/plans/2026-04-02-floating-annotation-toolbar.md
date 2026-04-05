# Floating Annotation Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a floating always-on-top toolbar with ZoomIT-style screen annotation (3 colors) and region-select snippet capture that feeds directly into Sciurus.

**Architecture:** Two new Electron `BrowserWindow` instances — a compact draggable toolbar and a fullscreen transparent overlay for drawing/capture. The overlay uses an HTML5 `<canvas>` for freehand annotation. Screenshots are captured via `desktopCapturer` in main process, composited with canvas annotations, then cropped to a user-selected region and sent to the existing capture popup via IPC.

**Tech Stack:** Electron 33 (`BrowserWindow`, `desktopCapturer`, `screen`, `ipcMain`), HTML5 Canvas API, existing Sciurus IPC/preload patterns.

**Spec:** `docs/superpowers/specs/2026-04-02-floating-annotation-toolbar-design.md`

**No test suite exists in this project.** Testing is done manually via `npm run dev` + DevTools console. Each task ends with a manual verification step instead of automated tests.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `renderer/toolbar.html` | Toolbar window markup — drag bar, project name, color dots, buttons, minimize/close |
| `renderer/toolbar.css` | Toolbar styling — dark rounded bar, color dots, minimize pill state |
| `renderer/toolbar.js` | Toolbar logic — button handlers, IPC calls, minimize/restore toggle, project name fetch |
| `renderer/overlay.html` | Overlay window markup — full-viewport canvas + region-select UI |
| `renderer/overlay.css` | Overlay styling — transparent body, canvas fill, region-select scrim + crosshair |
| `renderer/overlay.js` | Canvas drawing engine, color/keyboard handling, region-select drag, screenshot compositing, IPC |

### Modified Files

| File | Changes |
|------|---------|
| `src/main.js` | Add `toolbarWindow` and `overlayWindow` state vars. Add `createToolbarWindow()`, `createOverlayWindow()`, `destroyOverlayWindow()`. Add 8 new IPC handlers. Add `desktopCapturer` import. Launch toolbar in `launchMainApp()`. Add "Show Toolbar" to tray menu. Store/restore toolbar position via settings. |
| `src/preload.js` | Add 10 new methods + 3 event listeners to `window.quickclip` context bridge |

---

## Task 1: Toolbar Window — HTML, CSS, JS (Static Shell)

**Files:**
- Create: `renderer/toolbar.html`
- Create: `renderer/toolbar.css`
- Create: `renderer/toolbar.js`

- [ ] **Step 1: Create `renderer/toolbar.html`**

```html
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:;">
<title>Sciurus Toolbar</title>
<link rel="stylesheet" href="toolbar.css">
</head><body>

<div class="toolbar drag" id="toolbar">
  <span class="project-name" id="projectName">No project</span>
  <div class="color-dots nd">
    <button class="dot dot-red" onclick="enterDraw('red')" title="Draw — Red (delete/error)"></button>
    <button class="dot dot-green" onclick="enterDraw('green')" title="Draw — Green (add/insert)"></button>
    <button class="dot dot-pink" onclick="enterDraw('pink')" title="Draw — Pink (reference)"></button>
  </div>
  <button class="tb-btn nd" onclick="openSciurus()" title="Open Sciurus main window">Sciurus</button>
  <button class="tb-btn tb-capture nd" onclick="captureSnippet()" title="Capture a screen region">Capture</button>
  <button class="tb-icon nd" onclick="minimizeToolbar()" title="Minimize toolbar">&#x2212;</button>
  <button class="tb-icon nd" onclick="closeToolbar()" title="Close toolbar">&#x2715;</button>
</div>

<div class="pill nd hidden" id="pill" onclick="restoreToolbar()" title="Click to restore toolbar">
  <span class="pill-icon">&#x1F43F;</span>
</div>

<script src="toolbar.js"></script>
</body></html>
```

- [ ] **Step 2: Create `renderer/toolbar.css`**

```css
:root {
  --bg-card: #1a1a2e;
  --text-primary: #e8e8f4;
  --text-dim: #4a5568;
  --border-subtle: #ffffff08;
  --radius-sm: 8px;
  --radius-md: 12px;
  --transition-fast: 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  background: transparent;
  overflow: hidden;
}

.drag { -webkit-app-region: drag; }
.nd { -webkit-app-region: no-drag; }
.hidden { display: none !important; }

/* ── Toolbar Bar ── */

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 6px 12px;
  height: 40px;
  user-select: none;
}

/* ── Project Name ── */

.project-name {
  font-size: 12px;
  color: var(--text-dim);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-name.active {
  color: var(--text-primary);
}

/* ── Color Dots ── */

.color-dots {
  display: flex;
  gap: 6px;
  align-items: center;
}

.dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color var(--transition-fast), transform var(--transition-fast);
}
.dot:hover { transform: scale(1.2); }
.dot-red { background: #ff0000; }
.dot-green { background: #00ff00; }
.dot-pink { background: #ff69b4; }
.dot.active { border-color: #fff; transform: scale(1.2); }

/* ── Buttons ── */

.tb-btn {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--transition-fast);
}
.tb-btn:hover { background: #ffffff10; }
.tb-capture {
  background: #6366f120;
  border-color: #6366f140;
}
.tb-capture:hover { background: #6366f140; }

.tb-icon {
  font-size: 14px;
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px 4px;
  line-height: 1;
  transition: color var(--transition-fast);
}
.tb-icon:hover { color: var(--text-primary); }

/* ── Minimized Pill ── */

.pill {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform var(--transition-fast);
  user-select: none;
  -webkit-app-region: drag;
}
.pill:hover { transform: scale(1.1); }
.pill-icon { font-size: 16px; }
```

- [ ] **Step 3: Create `renderer/toolbar.js`**

```javascript
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

function enterDraw(color) {
  window.quickclip.enterDrawMode(color);
}

// ── Actions ──

function openSciurus() {
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
```

- [ ] **Step 4: Verify files exist and have no syntax errors**

Run: `node -e "const fs=require('fs'); ['toolbar.html','toolbar.css','toolbar.js'].forEach(f => { const p='renderer/'+f; if(fs.existsSync(p)) console.log('OK: '+p); else console.log('MISSING: '+p); });"`
Expected: All three show OK.

- [ ] **Step 5: Commit**

```bash
git add renderer/toolbar.html renderer/toolbar.css renderer/toolbar.js
git commit -m "feat(toolbar): add static toolbar window HTML, CSS, JS"
```

---

## Task 2: Preload — Toolbar & Overlay IPC Methods

**Files:**
- Modify: `src/preload.js:1-83`

- [ ] **Step 1: Add toolbar and overlay IPC methods to preload.js**

Add the following entries inside the `contextBridge.exposeInMainWorld('quickclip', { ... })` object, after the existing `// App info` section (after line 68) and before the `// Events` section:

```javascript
  // Toolbar
  enterDrawMode: (color) => ipcRenderer.invoke('enter-draw-mode', color),
  exitDrawMode: () => ipcRenderer.invoke('exit-draw-mode'),
  takeSnippet: () => ipcRenderer.invoke('take-snippet'),
  getToolbarProject: () => ipcRenderer.invoke('get-toolbar-project'),
  showMain: () => ipcRenderer.send('show-main'),
  minimizeToolbar: () => ipcRenderer.send('minimize-toolbar'),
  restoreToolbar: () => ipcRenderer.send('restore-toolbar'),
  closeToolbar: () => ipcRenderer.send('close-toolbar'),

  // Overlay events (main → renderer)
  onColorChange: (cb) => ipcRenderer.on('set-color', (_, color) => cb(color)),
  onEnterRegionSelect: (cb) => ipcRenderer.on('enter-region-select', (_, screenshotDataUrl) => cb(screenshotDataUrl)),
```

- [ ] **Step 2: Verify preload.js parses without errors**

Run: `node -e "try { require('./src/preload.js'); } catch(e) { if(e.message.includes('contextBridge')) console.log('OK — contextBridge error expected outside Electron'); else throw e; }"`
Expected: "OK — contextBridge error expected outside Electron" (file parses fine, just can't run outside Electron).

- [ ] **Step 3: Commit**

```bash
git add src/preload.js
git commit -m "feat(preload): add toolbar and overlay IPC methods"
```

---

## Task 3: Main Process — Toolbar Window Creation & IPC

**Files:**
- Modify: `src/main.js:60-70` (state vars), `src/main.js:210-225` (tray menu), `src/main.js:870-910` (launch sequence)

- [ ] **Step 1: Add state variables for toolbar and overlay windows**

In `src/main.js`, after line 65 (`let setupWindow = null;`), add:

```javascript
let toolbarWindow = null;
let overlayWindow = null;
let preOverlayWindowMeta = null; // Window metadata captured before overlay opens
```

- [ ] **Step 2: Add `desktopCapturer` to the Electron require**

In `src/main.js` line 10, change the require to include `desktopCapturer`:

```javascript
const { app, BrowserWindow, Tray, Menu, clipboard, nativeImage, globalShortcut, ipcMain, screen, dialog, desktopCapturer } = require('electron');
```

- [ ] **Step 3: Add `createToolbarWindow()` function**

Add this after the `createCaptureWindow` function (after line 186):

```javascript
// ── Annotation Toolbar ──

async function createToolbarWindow() {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.show();
    toolbarWindow.focus();
    return;
  }
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  const tbWidth = 450;
  const tbHeight = 44;
  // Default position: top-center of screen
  let x = Math.round((screenW - tbWidth) / 2);
  let y = 10;
  // Restore saved position if available
  try {
    const savedPos = await db.getSetting('toolbar_position');
    if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
      x = savedPos.x;
      y = savedPos.y;
    }
  } catch {}
  toolbarWindow = new BrowserWindow({
    width: tbWidth, height: tbHeight,
    x, y,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  toolbarWindow.loadFile(path.join(__dirname, '..', 'renderer', 'toolbar.html'));
  toolbarWindow.setAlwaysOnTop(true, 'floating');

  // Save position when toolbar is moved
  toolbarWindow.on('moved', () => {
    if (toolbarWindow && !toolbarWindow.isDestroyed()) {
      const [px, py] = toolbarWindow.getPosition();
      db.saveSetting('toolbar_position', { x: px, y: py }).catch(() => {});
    }
  });

  toolbarWindow.on('closed', () => { toolbarWindow = null; });
}
```

- [ ] **Step 4: Add toolbar IPC handlers**

Add these after the new `createToolbarWindow` function:

```javascript
ipcMain.on('show-main', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

ipcMain.on('minimize-toolbar', () => {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.setSize(40, 40);
    toolbarWindow.setResizable(false);
  }
});

ipcMain.on('restore-toolbar', () => {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.setSize(450, 44);
    toolbarWindow.setResizable(false);
  }
});

ipcMain.on('close-toolbar', () => {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.hide();
  }
});

ipcMain.handle('get-toolbar-project', async () => {
  // Read the project name from package.json in the working directory
  // (the project the workflow is attached to)
  const pkgPath = path.join(__dirname, '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.productName || pkg.name || null;
  } catch {
    return null;
  }
});
```

- [ ] **Step 5: Add "Show Toolbar" to tray menu**

In `src/main.js`, in the `createTray()` function, add a new menu item after the "Quick Capture" item (after line 216):

Change:
```javascript
    { label: 'Quick Capture', click: () => createCaptureWindow(null) },
    { type: 'separator' },
```

To:
```javascript
    { label: 'Quick Capture', click: () => createCaptureWindow(null) },
    { label: 'Show Toolbar', click: () => createToolbarWindow() },
    { type: 'separator' },
```

- [ ] **Step 6: Launch toolbar on app start**

In `src/main.js`, in the `launchMainApp()` function, after `startClipboardWatcher();` (after line 894), add:

```javascript
  createToolbarWindow();
```

- [ ] **Step 7: Clean up toolbar on quit**

In `src/main.js`, in the `app.on('will-quit', ...)` handler (around line 951), add before `await db.close();`:

```javascript
  if (toolbarWindow && !toolbarWindow.isDestroyed()) toolbarWindow.destroy();
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
```

- [ ] **Step 8: Verify — launch app and confirm toolbar appears**

Run: `npm run dev`
Expected: App launches, toolbar appears as a small dark floating bar at the top-center of the screen. It should be draggable, stay on top, and show "Sciurus!" as the project name. The Sciurus button should open the main window. Minimize should shrink to a pill, clicking the pill should restore. Close should hide the toolbar. "Show Toolbar" in tray menu should bring it back.

- [ ] **Step 9: Commit**

```bash
git add src/main.js
git commit -m "feat(toolbar): add toolbar window creation, IPC handlers, tray menu, auto-launch"
```

---

## Task 4: Overlay Window — HTML, CSS, Drawing Canvas

**Files:**
- Create: `renderer/overlay.html`
- Create: `renderer/overlay.css`
- Create: `renderer/overlay.js`

- [ ] **Step 1: Create `renderer/overlay.html`**

```html
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:;">
<title>Sciurus Overlay</title>
<link rel="stylesheet" href="overlay.css">
</head><body>
<canvas id="drawCanvas"></canvas>

<!-- Region select UI (hidden until snippet mode) -->
<div id="regionUI" class="region-ui hidden">
  <canvas id="regionCanvas"></canvas>
  <div id="regionHint" class="region-hint">Click and drag to select a region. Esc to cancel.</div>
</div>

<script src="overlay.js"></script>
</body></html>
```

- [ ] **Step 2: Create `renderer/overlay.css`**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: transparent;
  overflow: hidden;
  cursor: crosshair;
}

/* ── Drawing Canvas ── */

#drawCanvas {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
}

/* ── Region Select ── */

.region-ui {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 10;
}

.region-ui #regionCanvas {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  cursor: crosshair;
}

.region-hint {
  position: fixed;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  padding: 8px 16px;
  border-radius: 8px;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  z-index: 20;
  pointer-events: none;
}

.hidden { display: none !important; }
```

- [ ] **Step 3: Create `renderer/overlay.js` — drawing engine**

```javascript
// renderer/overlay.js — Fullscreen transparent overlay for annotation + region capture

const COLORS = {
  red: '#ff0000',
  green: '#00ff00',
  pink: '#ff69b4',
};

// ── State ──

let activeColor = 'red';
let isDrawing = false;
let isRegionMode = false;
let regionStart = null;
let regionRect = null;
let screenshotDataUrl = null; // Set when entering region-select mode

// ── Drawing Canvas ──

const drawCanvas = document.getElementById('drawCanvas');
const drawCtx = drawCanvas.getContext('2d');

function resizeDrawCanvas() {
  drawCanvas.width = window.innerWidth;
  drawCanvas.height = window.innerHeight;
}
resizeDrawCanvas();
window.addEventListener('resize', resizeDrawCanvas);

function setPenStyle() {
  drawCtx.strokeStyle = COLORS[activeColor] || COLORS.red;
  drawCtx.lineWidth = 3;
  drawCtx.lineCap = 'round';
  drawCtx.lineJoin = 'round';
}

// ── Mouse Drawing ──

drawCanvas.addEventListener('mousedown', (e) => {
  if (isRegionMode) return;
  if (e.button === 2) {
    // Right-click exits draw mode
    window.quickclip.exitDrawMode();
    return;
  }
  isDrawing = true;
  setPenStyle();
  drawCtx.beginPath();
  drawCtx.moveTo(e.clientX, e.clientY);
});

drawCanvas.addEventListener('mousemove', (e) => {
  if (!isDrawing || isRegionMode) return;
  drawCtx.lineTo(e.clientX, e.clientY);
  drawCtx.stroke();
});

drawCanvas.addEventListener('mouseup', () => {
  isDrawing = false;
});

// Prevent context menu on right-click
drawCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Keyboard Shortcuts ──

document.addEventListener('keydown', (e) => {
  if (isRegionMode) {
    if (e.key === 'Escape') {
      exitRegionMode();
    }
    return;
  }
  if (e.key === 'Escape') {
    window.quickclip.exitDrawMode();
  } else if (e.key === '1') {
    activeColor = 'red';
  } else if (e.key === '2') {
    activeColor = 'green';
  } else if (e.key === '3') {
    activeColor = 'pink';
  } else if (e.key === 's' || e.key === 'S') {
    window.quickclip.takeSnippet();
  }
});

// ── IPC: Color change from toolbar ──

window.quickclip.onColorChange((color) => {
  if (COLORS[color]) activeColor = color;
});

// ── Region Select Mode ──

const regionUI = document.getElementById('regionUI');
const regionCanvas = document.getElementById('regionCanvas');
const regionCtx = regionCanvas.getContext('2d');

window.quickclip.onEnterRegionSelect((dataUrl) => {
  screenshotDataUrl = dataUrl;
  enterRegionMode();
});

function enterRegionMode() {
  isRegionMode = true;
  regionCanvas.width = window.innerWidth;
  regionCanvas.height = window.innerHeight;

  // Draw the screenshot + annotations composited as the background
  const img = new Image();
  img.onload = () => {
    // Draw screenshot
    regionCtx.drawImage(img, 0, 0, regionCanvas.width, regionCanvas.height);
    // Draw annotations on top
    regionCtx.drawImage(drawCanvas, 0, 0);
    // Apply dark scrim
    regionCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    regionCtx.fillRect(0, 0, regionCanvas.width, regionCanvas.height);

    // Hide the draw canvas, show region UI
    drawCanvas.style.display = 'none';
    regionUI.classList.remove('hidden');
  };
  img.src = screenshotDataUrl;
}

function exitRegionMode() {
  isRegionMode = false;
  regionUI.classList.add('hidden');
  drawCanvas.style.display = 'block';
  regionStart = null;
  regionRect = null;
  // If there were no annotations, just close
  if (isCanvasEmpty()) {
    window.quickclip.exitDrawMode();
  }
}

function isCanvasEmpty() {
  const pixels = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height).data;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] > 0) return false;
  }
  return true;
}

// ── Region Drag ──

regionCanvas.addEventListener('mousedown', (e) => {
  regionStart = { x: e.clientX, y: e.clientY };
  regionRect = null;
});

regionCanvas.addEventListener('mousemove', (e) => {
  if (!regionStart) return;
  regionRect = {
    x: Math.min(regionStart.x, e.clientX),
    y: Math.min(regionStart.y, e.clientY),
    w: Math.abs(e.clientX - regionStart.x),
    h: Math.abs(e.clientY - regionStart.y),
  };
  redrawRegion();
});

regionCanvas.addEventListener('mouseup', () => {
  if (regionRect && regionRect.w > 10 && regionRect.h > 10) {
    cropAndSend();
  }
  regionStart = null;
});

function redrawRegion() {
  // Redraw the composited image with scrim
  const img = new Image();
  img.onload = () => {
    regionCtx.clearRect(0, 0, regionCanvas.width, regionCanvas.height);
    regionCtx.drawImage(img, 0, 0, regionCanvas.width, regionCanvas.height);
    regionCtx.drawImage(drawCanvas, 0, 0);
    regionCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    regionCtx.fillRect(0, 0, regionCanvas.width, regionCanvas.height);

    if (regionRect) {
      // Clear the scrim inside the selected rectangle to show the bright region
      regionCtx.clearRect(regionRect.x, regionRect.y, regionRect.w, regionRect.h);
      regionCtx.drawImage(img, regionRect.x, regionRect.y, regionRect.w, regionRect.h,
        regionRect.x, regionRect.y, regionRect.w, regionRect.h);
      // Draw annotations inside region
      regionCtx.drawImage(drawCanvas, regionRect.x, regionRect.y, regionRect.w, regionRect.h,
        regionRect.x, regionRect.y, regionRect.w, regionRect.h);
      // Selection border
      regionCtx.strokeStyle = '#fff';
      regionCtx.lineWidth = 2;
      regionCtx.setLineDash([6, 3]);
      regionCtx.strokeRect(regionRect.x, regionRect.y, regionRect.w, regionRect.h);
      regionCtx.setLineDash([]);
    }
  };
  img.src = screenshotDataUrl;
}

function cropAndSend() {
  // Create a crop canvas with the selected region
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = regionRect.w;
  cropCanvas.height = regionRect.h;
  const cropCtx = cropCanvas.getContext('2d');

  // Draw screenshot region
  const img = new Image();
  img.onload = () => {
    cropCtx.drawImage(img, regionRect.x, regionRect.y, regionRect.w, regionRect.h,
      0, 0, regionRect.w, regionRect.h);
    // Draw annotation region on top
    cropCtx.drawImage(drawCanvas, regionRect.x, regionRect.y, regionRect.w, regionRect.h,
      0, 0, regionRect.w, regionRect.h);
    // Send as data URL
    const dataUrl = cropCanvas.toDataURL('image/png');
    window.quickclip.snippetCaptured(dataUrl);
  };
  img.src = screenshotDataUrl;
}
```

- [ ] **Step 4: Verify files exist**

Run: `node -e "const fs=require('fs'); ['overlay.html','overlay.css','overlay.js'].forEach(f => { const p='renderer/'+f; if(fs.existsSync(p)) console.log('OK: '+p); else console.log('MISSING: '+p); });"`
Expected: All three show OK.

- [ ] **Step 5: Commit**

```bash
git add renderer/overlay.html renderer/overlay.css renderer/overlay.js
git commit -m "feat(overlay): add fullscreen draw overlay with canvas drawing and region select"
```

---

## Task 5: Preload — Add `snippetCaptured` method

**Files:**
- Modify: `src/preload.js`

- [ ] **Step 1: Add `snippetCaptured` to preload.js**

In the Toolbar section added in Task 2, add after the `closeToolbar` line:

```javascript
  snippetCaptured: (dataUrl) => ipcRenderer.invoke('snippet-captured', dataUrl),
```

- [ ] **Step 2: Commit**

```bash
git add src/preload.js
git commit -m "feat(preload): add snippetCaptured IPC method"
```

---

## Task 6: Main Process — Overlay Window Creation & Draw Mode IPC

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Add `createOverlayWindow()` and `destroyOverlayWindow()`**

Add after the toolbar IPC handlers (added in Task 3):

```javascript
// ── Draw Overlay ──

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.focus();
    return;
  }
  const display = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setFullScreen(true);
  // Prevent the overlay from being ignored by the WM
  overlayWindow.setIgnoreMouseEvents(false);

  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function destroyOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
}
```

- [ ] **Step 2: Add draw mode IPC handlers**

Add after the overlay creation functions:

```javascript
ipcMain.handle('enter-draw-mode', (_, color) => {
  // Capture window metadata BEFORE overlay covers the screen
  preOverlayWindowMeta = getActiveWindow();
  createOverlayWindow();
  // Send the initial color to the overlay once it's ready
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.once('did-finish-load', () => {
      overlayWindow.webContents.send('set-color', color);
    });
  }
});

ipcMain.handle('exit-draw-mode', () => {
  destroyOverlayWindow();
  preOverlayWindowMeta = null;
});

ipcMain.handle('take-snippet', async () => {
  // Use desktopCapturer to grab the screen
  // First hide the overlay so it's not captured
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }

  // Small delay to let the overlay hide
  await new Promise((resolve) => setTimeout(resolve, 100));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: screen.getPrimaryDisplay().size,
  });

  // Restore overlay visibility
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    overlayWindow.setFullScreen(true);
  }

  if (sources.length === 0) return;
  const screenshot = sources[0].thumbnail.toDataURL();

  // Send screenshot to overlay for region selection
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('enter-region-select', screenshot);
  }
});

ipcMain.handle('snippet-captured', (_, dataUrl) => {
  // Destroy the overlay
  destroyOverlayWindow();

  // Send the snippet to the capture popup (same flow as clipboard watcher)
  const meta = preOverlayWindowMeta || { title: 'Screen Capture', processName: 'Sciurus Toolbar' };
  preOverlayWindowMeta = null;
  createCaptureWindow(dataUrl, meta);
});
```

- [ ] **Step 3: Verify — test full flow**

Run: `npm run dev`
Expected:
1. Click a color dot on the toolbar → fullscreen transparent overlay appears, cursor is crosshair
2. Draw freehand with the mouse → colored lines appear on screen
3. Press `1`/`2`/`3` → pen color changes for next stroke
4. Press `Esc` → overlay closes, annotations disappear
5. Click color dot again, draw, then press `S` → screen briefly flashes (overlay hides/shows), dark scrim appears with annotations, drag a rectangle → capture popup opens with the cropped annotated screenshot
6. Press `Esc` during region select → returns to draw mode (or closes if canvas was empty)
7. Right-click during draw mode → overlay closes

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat(overlay): add overlay window creation, draw mode and snippet capture IPC"
```

---

## Task 7: Toolbar Color Dot Feedback During Draw Mode

**Files:**
- Modify: `renderer/toolbar.js`

The toolbar's color dots should highlight the active color when draw mode is active, and the toolbar should still be usable during draw mode for color switching and capture.

- [ ] **Step 1: Add active state tracking and color switch IPC to toolbar.js**

Replace the `enterDraw` function and add draw mode state tracking:

```javascript
let drawModeActive = false;
let activeDrawColor = null;

function enterDraw(color) {
  drawModeActive = true;
  activeDrawColor = color;
  updateColorDots();
  window.quickclip.enterDrawMode(color);
}

function switchColor(color) {
  if (drawModeActive) {
    activeDrawColor = color;
    updateColorDots();
    // Send color change to overlay via main process
    window.quickclip.enterDrawMode(color);
  } else {
    enterDraw(color);
  }
}

function updateColorDots() {
  document.querySelectorAll('.dot').forEach((dot) => {
    dot.classList.remove('active');
  });
  if (activeDrawColor) {
    const dotClass = 'dot-' + activeDrawColor;
    const dot = document.querySelector('.' + dotClass);
    if (dot) dot.classList.add('active');
  }
}

// Listen for draw mode exit (overlay closed via Esc/right-click)
window.quickclip.onDrawModeExited(() => {
  drawModeActive = false;
  activeDrawColor = null;
  updateColorDots();
});
```

- [ ] **Step 2: Update toolbar.html onclick handlers to use `switchColor`**

In `renderer/toolbar.html`, change the three dot buttons:

```html
    <button class="dot dot-red" onclick="switchColor('red')" title="Draw — Red (delete/error)"></button>
    <button class="dot dot-green" onclick="switchColor('green')" title="Draw — Green (add/insert)"></button>
    <button class="dot dot-pink" onclick="switchColor('pink')" title="Draw — Pink (reference)"></button>
```

- [ ] **Step 3: Add `onDrawModeExited` to preload.js**

In `src/preload.js`, in the overlay events section, add:

```javascript
  onDrawModeExited: (cb) => ipcRenderer.on('draw-mode-exited', () => cb()),
```

- [ ] **Step 4: Emit `draw-mode-exited` to toolbar when overlay closes**

In `src/main.js`, update the `exit-draw-mode` handler and the overlay `closed` event to notify the toolbar:

In the `ipcMain.handle('exit-draw-mode', ...)` handler, add before `destroyOverlayWindow()`:

```javascript
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.webContents.send('draw-mode-exited');
  }
```

In the `createOverlayWindow()` function, update the `closed` handler:

```javascript
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    if (toolbarWindow && !toolbarWindow.isDestroyed()) {
      toolbarWindow.webContents.send('draw-mode-exited');
    }
  });
```

Also, in the `enter-draw-mode` handler, when the overlay already exists (re-entering with a different color), send the color change to the existing overlay instead of creating a new one:

Replace the `ipcMain.handle('enter-draw-mode', ...)` handler with:

```javascript
ipcMain.handle('enter-draw-mode', (_, color) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // Overlay already open — just switch color
    overlayWindow.webContents.send('set-color', color);
    return;
  }
  // Capture window metadata BEFORE overlay covers the screen
  preOverlayWindowMeta = getActiveWindow();
  createOverlayWindow();
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.once('did-finish-load', () => {
      overlayWindow.webContents.send('set-color', color);
    });
  }
});
```

- [ ] **Step 5: Verify — toolbar color feedback**

Run: `npm run dev`
Expected: Click red dot → dot gets white ring, overlay opens. Click green dot on toolbar → green dot gets ring, red loses it, overlay pen switches to green. Press Esc → all dots lose active state.

- [ ] **Step 6: Commit**

```bash
git add renderer/toolbar.html renderer/toolbar.js src/preload.js src/main.js
git commit -m "feat(toolbar): add active color feedback and draw mode state sync"
```

---

## Task 8: Region Select — Direct Capture (No Draw Mode)

**Files:**
- Modify: `src/main.js`, `renderer/overlay.js`

When the user clicks "Capture" on the toolbar without entering draw mode, it should go straight to region-select (no drawing canvas, no annotations).

- [ ] **Step 1: Update `take-snippet` handler for direct capture**

The existing `take-snippet` handler in `src/main.js` already handles the screenshot and sends it to the overlay. But when there's no overlay, we need to create one and go straight to region mode.

Replace the `ipcMain.handle('take-snippet', ...)` handler with:

```javascript
ipcMain.handle('take-snippet', async () => {
  // Capture window metadata before anything else
  if (!preOverlayWindowMeta) {
    preOverlayWindowMeta = getActiveWindow();
  }

  // Hide overlay if it exists (so it's not in the screenshot)
  const hadOverlay = overlayWindow && !overlayWindow.isDestroyed();
  if (hadOverlay) {
    overlayWindow.hide();
  }

  // Small delay to let windows hide
  await new Promise((resolve) => setTimeout(resolve, 100));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: screen.getPrimaryDisplay().size,
  });

  if (sources.length === 0) {
    if (hadOverlay && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show();
      overlayWindow.setFullScreen(true);
    }
    return;
  }
  const screenshot = sources[0].thumbnail.toDataURL();

  if (hadOverlay && overlayWindow && !overlayWindow.isDestroyed()) {
    // Existing overlay — switch to region select with annotations preserved
    overlayWindow.show();
    overlayWindow.setFullScreen(true);
    overlayWindow.webContents.send('enter-region-select', screenshot);
  } else {
    // No overlay — create one and go straight to region select
    createOverlayWindow();
    overlayWindow.webContents.once('did-finish-load', () => {
      overlayWindow.webContents.send('enter-region-select', screenshot);
    });
  }
});
```

- [ ] **Step 2: Handle direct region select in overlay.js (no annotations)**

The overlay.js `enterRegionMode` function already handles this — when there are no annotations on the drawCanvas, `isCanvasEmpty()` returns true, and `exitRegionMode()` closes the overlay. The compositing step will just show the screenshot without annotations, which is correct.

No code changes needed — verify this works.

- [ ] **Step 3: Verify — direct capture without draw mode**

Run: `npm run dev`
Expected: Click "Capture" on toolbar (without clicking any color dot first) → screen briefly flashes, then dark scrim appears with region-select cursor. Drag a rectangle → capture popup opens with the cropped screenshot (no annotations). Press Esc → overlay closes.

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat(toolbar): support direct capture without entering draw mode"
```

---

## Task 9: Region Select Redraw Optimization

**Files:**
- Modify: `renderer/overlay.js`

The current `redrawRegion()` creates a new `Image` object on every mouse move, which causes flickering. Cache the composited image.

- [ ] **Step 1: Cache the composited image in overlay.js**

Add a cached image variable at the top of the state section:

```javascript
let compositedImage = null; // Cached Image for region select redraws
```

Update `enterRegionMode()` to cache the composited image:

```javascript
function enterRegionMode() {
  isRegionMode = true;
  regionCanvas.width = window.innerWidth;
  regionCanvas.height = window.innerHeight;

  const img = new Image();
  img.onload = () => {
    // Create a composited offscreen canvas (screenshot + annotations)
    const offscreen = document.createElement('canvas');
    offscreen.width = regionCanvas.width;
    offscreen.height = regionCanvas.height;
    const offCtx = offscreen.getContext('2d');
    offCtx.drawImage(img, 0, 0, offscreen.width, offscreen.height);
    offCtx.drawImage(drawCanvas, 0, 0);

    // Cache as an image for fast redraws
    compositedImage = new Image();
    compositedImage.onload = () => {
      // Initial draw with scrim
      regionCtx.drawImage(compositedImage, 0, 0);
      regionCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      regionCtx.fillRect(0, 0, regionCanvas.width, regionCanvas.height);

      drawCanvas.style.display = 'none';
      regionUI.classList.remove('hidden');
    };
    compositedImage.src = offscreen.toDataURL();
  };
  img.src = screenshotDataUrl;
}
```

Replace `redrawRegion()` to use the cached image:

```javascript
function redrawRegion() {
  if (!compositedImage) return;
  regionCtx.clearRect(0, 0, regionCanvas.width, regionCanvas.height);
  // Draw composited image with scrim
  regionCtx.drawImage(compositedImage, 0, 0);
  regionCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  regionCtx.fillRect(0, 0, regionCanvas.width, regionCanvas.height);

  if (regionRect) {
    // Clear scrim in selection and show bright region
    regionCtx.clearRect(regionRect.x, regionRect.y, regionRect.w, regionRect.h);
    regionCtx.drawImage(compositedImage, regionRect.x, regionRect.y, regionRect.w, regionRect.h,
      regionRect.x, regionRect.y, regionRect.w, regionRect.h);
    // Dashed selection border
    regionCtx.strokeStyle = '#fff';
    regionCtx.lineWidth = 2;
    regionCtx.setLineDash([6, 3]);
    regionCtx.strokeRect(regionRect.x, regionRect.y, regionRect.w, regionRect.h);
    regionCtx.setLineDash([]);
  }
}
```

Update `cropAndSend()` to use cached image:

```javascript
function cropAndSend() {
  if (!compositedImage) return;
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = regionRect.w;
  cropCanvas.height = regionRect.h;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.drawImage(compositedImage, regionRect.x, regionRect.y, regionRect.w, regionRect.h,
    0, 0, regionRect.w, regionRect.h);
  const dataUrl = cropCanvas.toDataURL('image/png');
  window.quickclip.snippetCaptured(dataUrl);
}
```

Update `exitRegionMode()` to clear the cache:

```javascript
function exitRegionMode() {
  isRegionMode = false;
  regionUI.classList.add('hidden');
  drawCanvas.style.display = 'block';
  regionStart = null;
  regionRect = null;
  compositedImage = null;
  if (isCanvasEmpty()) {
    window.quickclip.exitDrawMode();
  }
}
```

- [ ] **Step 2: Verify — smooth region select dragging**

Run: `npm run dev`
Expected: Enter draw mode, draw some annotations, press S. The region-select overlay should be smooth when dragging — no flickering, the selected bright rectangle updates in real time.

- [ ] **Step 3: Commit**

```bash
git add renderer/overlay.js
git commit -m "perf(overlay): cache composited image for smooth region select redraws"
```

---

## Task 10: End-to-End Verification

- [ ] **Step 1: Verify `db.getSetting` exists for position persistence**

Run: `node -e "const lines = require('fs').readFileSync('src/db.js','utf8'); console.log(lines.includes('getSetting') ? 'OK: getSetting exists' : 'MISSING: getSetting');"`
If missing, check `db-pg.js` and `db-sqlite.js` for the pattern. The settings are stored as a JSON object — `getSetting(key)` should return the parsed value. If the method doesn't exist, add a `getSetting` wrapper to `db.js` that calls the backend's `getSettings()` and extracts the key.

- [ ] **Step 2: Full flow verification**

Run: `npm run dev`

Verify all of these:
1. Toolbar appears at top-center on launch
2. Toolbar shows project name ("Sciurus!")
3. Toolbar is draggable, stays on top of other windows
4. Clicking a color dot → fullscreen overlay, crosshair cursor, freehand drawing works
5. Keys `1`/`2`/`3` switch pen color during draw mode
6. `Esc` exits draw mode, `right-click` exits draw mode
7. `S` during draw mode → screenshot captured, region-select scrim appears
8. Drag rectangle → capture popup opens with annotated cropped image
9. "Capture" button without draw mode → direct region select
10. "Sciurus" button opens main window
11. Minimize (−) → small pill icon; click pill → toolbar restores
12. Close (×) → toolbar hidden; tray menu "Show Toolbar" brings it back
13. Drag toolbar to new position, restart app → toolbar remembers position

- [ ] **Step 3: Fix any issues found during verification, commit**

```bash
git add -A
git commit -m "feat(toolbar): floating annotation toolbar — end-to-end verified"
```

---

## Summary

| Task | What it builds |
|------|---------------|
| 1 | Static toolbar UI (HTML/CSS/JS) |
| 2 | Preload IPC methods for toolbar + overlay |
| 3 | Toolbar window creation, IPC handlers, tray menu, auto-launch |
| 4 | Overlay UI with drawing canvas + region select |
| 5 | Preload `snippetCaptured` method |
| 6 | Overlay window creation, draw mode, and screenshot capture IPC |
| 7 | Active color dot feedback + draw mode state sync |
| 8 | Direct capture (Capture button without draw mode) |
| 9 | Region select redraw optimization (cached composited image) |
| 10 | End-to-end verification of full flow |
