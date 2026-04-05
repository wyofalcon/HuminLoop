// src/main.js — Electron main process: tray, hotkey, IPC, clipboard watcher, PostgreSQL

// Clear before requiring electron — inherited from VS Code / Claude Code shell
delete process.env.ELECTRON_RUN_AS_NODE;

// Suppress EPIPE errors on stdout/stderr (happens when launched via pipe that closes early)
process.stdout?.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.stderr?.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

const { app, BrowserWindow, Tray, Menu, clipboard, nativeImage, globalShortcut, ipcMain, screen, dialog, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const ai = require('./ai');
const rules = require('./rules');
const { getActiveWindow } = require('./window-info');
const images = require('./images');
const workflowContext = require('./workflow-context');

// ── .env loader (manual — dotenv v17 changed its API) ──

const ENV_PATH = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

// ── Remove default Electron menu (links to Electron repo) ──
Menu.setApplicationMenu(null);

// ── Single Instance Lock ──
// When clicking the desktop icon again, focus the existing window instead of launching a second instance

if (app) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  }
}

// ── Constants ──

const CLIPBOARD_POLL_MS = 1000;
const DEFAULT_CATEGORIES = [
  'Uncategorized', 'cvstomize.com', 'PowerToys', 'LLM Setup',
  'Hardware/GPU', 'Ideas', 'Code Patterns',
];
const ALLOWED_CLIP_FIELDS = [
  'category', 'tags', 'aiSummary', 'aiFixPrompt', 'url', 'status', 'comments', 'project_id', 'comment',
  'window_title', 'process_name', 'completed_at', 'archived', 'summarize_count',
];

// Tiny 32x32 fallback icon (transparent PNG) for the system tray
const FALLBACK_TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0'
  + 'AAAAAXNSR0IArs4c6QAAAE1JREFUWGFoAAAADklEQVRIx2NgGAWjYBQMfQAABPAAATG1XiAAAAAASUVORK5CYII=';

// ── State ──

let tray = null;
let mainWindow = null;
let captureWindow = null;
let setupWindow = null;
let toolbarWindow = null;
let overlayWindow = null;
let preOverlayWindowMeta = null; // Window metadata captured before overlay opens
let clipboardWatcher = null;
let lastClipHash = null;
let watcherPaused = false;
let isQuitting = false;

// ── Helpers ──

/** Send an event to the main window if it exists. */
function notifyMainWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

/** Read the clipboard image and return a data URL, or null if empty. */
function getClipboardImageURL() {
  const img = clipboard.readImage();
  return img.isEmpty() ? null : img.toDataURL();
}

/** Hash the current clipboard image to detect changes. */
function getClipboardImageHash() {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  const size = img.getSize();
  const buf = img.toBitmap();
  return `${size.width}x${size.height}-${buf.slice(0, 32).toString('hex')}`;
}

/** Sanitize an update object to only include allowed clip fields. */
function sanitizeUpdates(updates) {
  const clean = {};
  for (const key of ALLOWED_CLIP_FIELDS) {
    if (key in updates) clean[key] = updates[key];
  }
  return clean;
}

async function getAppMode() {
  const mode = await db.getSettings('app_mode');
  return mode || 'full';
}

// ── First-Run Detection ──

function isFirstRun() {
  const envPath = path.join(__dirname, '..', '.env');
  // Also check if SQLite DB exists (for users who skipped Docker setup)
  let sqlitePath = null;
  try { sqlitePath = path.join(app.getPath('userData'), 'sciurus.db'); } catch {}
  return !fs.existsSync(envPath) && (!sqlitePath || !fs.existsSync(sqlitePath));
}

// ── Windows ──

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 580, height: 680, show: false,
    title: 'Sciurus — Setup',
    backgroundColor: '#13131f',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
  setupWindow.once('ready-to-show', () => {
    setupWindow.show();
    setupWindow.focus();
  });
  setupWindow.on('closed', () => { setupWindow = null; });
}

async function createMainWindow() {
  const mode = await getAppMode();
  const htmlFile = 'index.html';  // Both modes use same renderer; lite mode hides tabs via JS
  const windowSize = mode === 'lite' ? { width: 450, height: 600 } : { width: 1100, height: 750 };
  mainWindow = new BrowserWindow({
    width: windowSize.width, height: windowSize.height, show: false,
    title: 'Sciurus',
    backgroundColor: '#13131f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', htmlFile));
  if (process.env.SCIURUS_DEV === '1') mainWindow.webContents.openDevTools();
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

async function createCaptureWindow(imageDataURL, windowMeta = null) {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.show();
    captureWindow.focus();
    captureWindow.webContents.focus();
    captureWindow.webContents.send('new-screenshot', imageDataURL, windowMeta);
    return;
  }
  const mode = await getAppMode();
  const htmlFile = mode === 'lite' ? 'lite-capture.html' : 'capture.html';
  const captureSize = mode === 'lite' ? { width: 340, height: 420 } : { width: 460, height: 580 };
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  captureWindow = new BrowserWindow({
    width: captureSize.width, height: captureSize.height,
    x: screenW - (captureSize.width + 20), y: 20,
    frame: false, alwaysOnTop: true,
    resizable: true, skipTaskbar: true,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  captureWindow.loadFile(path.join(__dirname, '..', 'renderer', htmlFile));
  captureWindow.once('ready-to-show', () => {
    captureWindow.show();
    captureWindow.focus();
    captureWindow.webContents.focus();
    if (imageDataURL) captureWindow.webContents.send('new-screenshot', imageDataURL, windowMeta);
  });
  captureWindow.on('closed', () => { captureWindow = null; });
}

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
    const savedPos = await db.getSettings('toolbar_position');
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

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    if (toolbarWindow && !toolbarWindow.isDestroyed()) {
      toolbarWindow.webContents.send('draw-mode-exited');
    }
  });
}

function destroyOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.removeAllListeners('closed');
    overlayWindow.destroy();
    overlayWindow = null;
  }
}

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

ipcMain.handle('exit-draw-mode', () => {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.webContents.send('draw-mode-exited');
  }
  destroyOverlayWindow();
  preOverlayWindowMeta = null;
});

// ── Text Mode IPC Relay ──

ipcMain.on('toggle-text-mode', (_, enabled) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('text-mode-toggle', enabled);
  }
});

ipcMain.on('text-mode-changed', (_, enabled) => {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    if (!enabled) toolbarWindow.webContents.send('text-mode-exited');
  }
});

ipcMain.on('text-mode-exited', () => {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.webContents.send('text-mode-exited');
  }
});

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

ipcMain.handle('snippet-captured', async (_, dataUrl) => {
  // Notify toolbar that draw mode ended
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.webContents.send('draw-mode-exited');
  }
  // Destroy the overlay
  destroyOverlayWindow();

  // Send the snippet to the capture popup (same flow as clipboard watcher)
  const meta = preOverlayWindowMeta || { title: 'Screen Capture', processName: 'Sciurus Toolbar' };
  preOverlayWindowMeta = null;
  await createCaptureWindow(dataUrl, meta);
});

// ── Clipboard Watcher ──

function startClipboardWatcher() {
  lastClipHash = getClipboardImageHash();
  clipboardWatcher = setInterval(async () => {
    if (watcherPaused) return;
    const hash = getClipboardImageHash();
    if (hash && hash !== lastClipHash) {
      lastClipHash = hash;
      const url = getClipboardImageURL();
      if (url) {
        // Capture active window metadata BEFORE opening popup
        const windowMeta = getActiveWindow();
        console.log(`[Sciurus] Window context: ${windowMeta.processName} — ${windowMeta.title}`);
        await createCaptureWindow(url, windowMeta);
      }
    }
  }, CLIPBOARD_POLL_MS);
}

// ── System Tray ──

async function rebuildTrayMenu() {
  if (!tray) return;
  const mode = await getAppMode();
  const modeLabel = mode === 'lite' ? 'Switch to Full Mode' : 'Switch to Lite Mode';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Sciurus', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Quick Capture', click: async () => await createCaptureWindow(null) },
    { label: 'Show Toolbar', click: () => createToolbarWindow() },
    { type: 'separator' },
    { label: modeLabel, click: async () => {
      const current = await getAppMode();
      const next = current === 'lite' ? 'full' : 'lite';
      await db.saveSetting('app_mode', next);
      if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.destroy(); mainWindow = null; }
      if (captureWindow && !captureWindow.isDestroyed()) { captureWindow.destroy(); captureWindow = null; }
      await createMainWindow();
      mainWindow.show();
      rebuildTrayMenu();
    }},
    { label: 'Pause Watcher', type: 'checkbox', checked: false, click: (item) => { watcherPaused = item.checked; } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createFromDataURL(FALLBACK_TRAY_ICON);
  }
  tray = new Tray(icon);
  tray.setToolTip('Sciurus');
  rebuildTrayMenu();
  tray.on('click', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });
}

// ── Migration from electron-store ──

async function migrateIfNeeded() {
  try {
    const Store = require('electron-store');
    const oldStore = new Store({ name: 'sciurus-data' });
    const oldClips = oldStore.get('clips', []);
    if (oldClips.length === 0) return;

    // Check if DB already has clips (already migrated)
    const existing = await db.getClips();
    if (existing.length > 0) return;

    console.log(`[Sciurus] Migrating ${oldClips.length} clips from electron-store...`);
    const oldCategories = oldStore.get('categories', DEFAULT_CATEGORIES);
    const ok = await db.migrateFromStore({ clips: oldClips, categories: oldCategories });
    if (ok) console.log('[Sciurus] Migration complete.');
  } catch (e) {
    console.log('[Sciurus] No electron-store data to migrate (or already migrated).');
  }
}

// ── Auto-Categorize ──

/** Retry AI categorization for any uncategorized clips from previous sessions. */
async function retryUncategorized() {
  if (!ai.isEnabled()) return;
  const clips = await db.getClips();
  const pending = clips.filter((c) => c.category === 'Uncategorized' && (c.comment || c.image));
  if (!pending.length) return;
  console.log(`[Sciurus] Retrying AI for ${pending.length} uncategorized clip(s)...`);
  for (const clip of pending) {
    await autoCategorize(clip.id, clip.comment || '', clip.image);
  }
}

/** Run AI categorization in the background after a clip is saved. */
async function autoCategorize(clipId, comment, imageData, windowTitle = null, processName = null) {
  try {
    const cats = await db.getCategories();
    const projects = await db.getProjects();
    // Compress image before sending to AI — 60-70% smaller payload
    const compressedImage = imageData ? images.compressForAI(imageData) : null;
    const result = await ai.categorize(comment, cats, compressedImage, projects, { windowTitle, processName });
    if (!result) return;

    const updates = {};
    // Only override category if clip was Uncategorized (preserve rule assignments)
    const clip = await db.getClip(clipId);
    if (result.category && (!clip || clip.category === 'Uncategorized')) {
      updates.category = result.category;
    }
    if (result.tags) updates.tags = result.tags;
    if (result.summary) updates.aiSummary = result.summary;
    if (result.url) updates.url = result.url;

    // AI-suggested project assignment (only if clip isn't already assigned and not in lite mode)
    const currentMode = await getAppMode();
    if (result.project_id && (!clip || !clip.project_id) && currentMode !== 'lite') {
      // Verify the project actually exists
      const proj = await db.getProject(result.project_id);
      if (proj) {
        updates.project_id = result.project_id;
        console.log(`[Sciurus] AI assigned to project: ${proj.name}`);
      }
    }

    if (Object.keys(updates).length) {
      await db.updateClip(clipId, updates);

      // Add new category if needed
      if (result.category) {
        await db.saveCategory(result.category);
      }

      notifyMainWindow('clips-changed');
      if (updates.project_id) notifyMainWindow('projects-changed');
    }
    console.log(`[Sciurus] AI categorized: "${comment.slice(0, 30)}" → ${result.category}`);
    addAuditEntry('ai', `AI categorized clip ${clipId}: ${result.category}`);
  } catch (e) {
    console.error('[Sciurus] Auto-categorize failed:', e.message);
  }
}

/** Run AI lite prompt generation in the background after a clip is saved in Lite mode. */
async function autoCategorizeLite(clipId, comment, imageData, windowTitle, processName) {
  try {
    const projectId = await db.getSettings('lite_active_project');
    const project = projectId ? await db.getProject(projectId) : {};
    const session = project.repo_path ? workflowContext.readSessionContext(project.repo_path) : null;
    const audit = project.repo_path ? workflowContext.readAuditFindings(project.repo_path) : null;
    const compressedImage = imageData ? images.compressForAI(imageData) : null;
    const prompt = await ai.generateLitePrompt(
      comment, compressedImage,
      { windowTitle, processName },
      { name: project.name, description: project.description, repo_path: project.repo_path },
      { session, audit }
    );
    if (prompt) {
      await db.updateClip(clipId, { aiFixPrompt: prompt });
      notifyMainWindow('clips-changed');
      console.log(`[Sciurus] Lite prompt generated for clip ${clipId}`);
      addAuditEntry('ai', `Lite prompt generated for clip ${clipId}`);
    }
  } catch (e) {
    console.error('[Sciurus] Lite prompt generation failed:', e.message);
  }
}

// ── IPC Handlers: Clips ──

ipcMain.handle('get-clips', () => db.getClips());
ipcMain.handle('get-general-clips', () => db.getClips(null));
ipcMain.handle('get-clips-for-project', (_, projectId) => db.getClips(projectId));
ipcMain.handle('get-lite-clips', async () => {
  const projectId = await db.getSettings('lite_active_project');
  return db.getClips(projectId || undefined, 'lite');
});

ipcMain.handle('save-clip', async (_, clip) => {
  if (!clip || typeof clip.id !== 'string') return false;

  // Save image to disk, store flag in DB instead of full base64
  const imageData = clip.image;
  if (imageData) {
    images.saveImage(clip.id, imageData);
    clip.image = '__on_disk__';
  }

  // Lite mode: inject source and active project
  const mode = await getAppMode();
  if (mode === 'lite') {
    clip.source = 'lite';
    const liteProject = await db.getSettings('lite_active_project');
    if (liteProject && !clip.project_id) {
      clip.project_id = liteProject;
    }
  }

  // Rule-based categorization (before saving — so the clip gets correct initial values)
  if (clip.category === 'Uncategorized' || !clip.project_id) {
    const ruleResult = await rules.categorize(clip.window_title, clip.process_name, clip.comment);
    if (clip.category === 'Uncategorized' && ruleResult.category) {
      clip.category = ruleResult.category;
      console.log(`[Sciurus] Rules matched category: ${ruleResult.category}`);
    }
    if (!clip.project_id && ruleResult.projectId) {
      clip.project_id = ruleResult.projectId;
      console.log(`[Sciurus] Rules matched project ID: ${ruleResult.projectId}`);
    }
  }

  await db.saveClip(clip);
  notifyMainWindow('clips-changed');
  addAuditEntry('create', `Clip created: "${(clip.comment || '(screenshot)').slice(0, 50)}"`);

  // AI categorization — runs if clip has content and AI is enabled.
  // Even if rules assigned a category/project, AI enriches with summary, tags, and fix prompts.
  if ((clip.comment || imageData) && ai.isEnabled()) {
    console.log(`[Sciurus] Starting AI categorization for: "${(clip.comment || '(screenshot only)').slice(0, 30)}"`);
    // Always run standard categorization (summary, tags, category)
    autoCategorize(clip.id, clip.comment || '', imageData, clip.window_title, clip.process_name)
      .catch(e => console.error('[Sciurus] Auto-categorize background error:', e.message));
    // In lite mode, also generate the focused fix prompt
    if (mode === 'lite') {
      autoCategorizeLite(clip.id, clip.comment || '', imageData, clip.window_title, clip.process_name)
        .catch(e => console.error('[Sciurus] Lite prompt background error:', e.message));
    }
  } else if (!ai.isEnabled()) {
    console.log('[Sciurus] AI disabled — skipping categorization');
  }
  return true;
});

// Load image on demand from disk
ipcMain.handle('get-clip-image', (_, clipId) => {
  return images.loadImage(clipId);
});

// Copy a clip's image to the system clipboard
ipcMain.handle('copy-image-to-clipboard', (_, clipId) => {
  const dataUrl = images.loadImage(clipId);
  if (!dataUrl) return false;
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return false;
  clipboard.writeImage(img);
  return true;
});

ipcMain.handle('update-clip', async (_, id, updates) => {
  if (typeof id !== 'string' || !updates) return false;
  const safe = sanitizeUpdates(updates);
  await db.updateClip(id, safe);
  const fields = Object.keys(safe).join(', ');
  addAuditEntry('update', `Clip ${id} updated: ${fields}`);
  notifyMainWindow('clips-changed');

  // Auto re-run AI when comment or thread comments change
  if (ai.isEnabled() && ('comment' in safe || 'comments' in safe)) {
    const clip = await db.getClip(id);
    if (clip) {
      const imageData = images.loadImage(id);
      // Re-categorize (updates aiSummary, tags, category, etc.)
      autoCategorize(id, clip.comment || '', imageData, clip.windowTitle, clip.processName)
        .then(async () => {
          // Also regenerate aiFixPrompt if clip is in a project
          if (clip.project_id) {
            const compressed = imageData ? images.compressForAI(imageData) : null;
            const results = await ai.summarizeNotes([{ id, comment: clip.comment || '', imageDataURL: compressed }]);
            if (results.length > 0 && results[0].summary) {
              const count = (clip.summarizeCount || 0) + 1;
              await db.updateClip(id, { aiFixPrompt: results[0].summary, summarize_count: count });
              notifyMainWindow('clips-changed');
            }
          }
        })
        .catch((e) => console.error('[Sciurus] Auto AI re-categorize on edit error:', e.message));
    }
  }
  return true;
});

ipcMain.handle('delete-clip', async (_, id) => {
  if (typeof id !== 'string') return false;
  await db.deleteClip(id);
  addAuditEntry('delete', `Clip trashed: ${id}`);
  notifyMainWindow('clips-changed');
  notifyMainWindow('projects-changed');
  return true;
});

ipcMain.handle('get-trash', () => db.getTrash());

ipcMain.handle('restore-clip', async (_, id) => {
  if (typeof id !== 'string') return false;
  await db.restoreClip(id);
  notifyMainWindow('clips-changed');
  notifyMainWindow('projects-changed');
  return true;
});

ipcMain.handle('permanent-delete-clip', async (_, id) => {
  if (typeof id !== 'string') return false;
  images.deleteImage(id);
  await db.permanentDeleteClip(id);
  notifyMainWindow('clips-changed');
  return true;
});

ipcMain.handle('empty-trash', async () => {
  const trashed = await db.getTrash();
  for (const c of trashed) {
    images.deleteImage(c.id);
    await db.permanentDeleteClip(c.id);
  }
  notifyMainWindow('clips-changed');
  return true;
});

ipcMain.handle('assign-clip-to-project', async (_, clipId, projectId) => {
  await db.updateClip(clipId, { project_id: projectId });
  notifyMainWindow('clips-changed');
  notifyMainWindow('projects-changed');

  // Auto-generate fix prompt in background when assigning to a project
  if (projectId && ai.isEnabled()) {
    const clip = await db.getClip(clipId);
    if (clip && (clip.comment || clip.image) && !clip.aiFixPrompt) {
      const raw = images.loadImage(clipId);
      const compressed = raw ? images.compressForAI(raw) : null;
      ai.summarizeNotes([{ id: clip.id, comment: clip.comment || '', imageDataURL: compressed }]).then((results) => {
        if (results.length > 0 && results[0].summary) {
          db.updateClip(clipId, { aiFixPrompt: results[0].summary });
          notifyMainWindow('clips-changed');
        }
      }).catch((e) => console.error('[Sciurus] Fix prompt generation failed:', e.message));
    }
  }
  return true;
});

ipcMain.handle('complete-clip', async (_, clipId, archive) => {
  if (typeof clipId !== 'string') return false;
  const updates = { completed_at: new Date().toISOString() };
  if (archive) {
    // Archive option now sends to trash instead
    await db.updateClip(clipId, updates);
    await db.deleteClip(clipId);
    addAuditEntry('complete', `Clip completed + trashed: ${clipId}`);
  } else {
    await db.updateClip(clipId, updates);
    addAuditEntry('complete', `Clip completed: ${clipId}`);
  }
  notifyMainWindow('clips-changed');
  notifyMainWindow('projects-changed');
  return true;
});

ipcMain.handle('uncomplete-clip', async (_, clipId) => {
  if (typeof clipId !== 'string') return false;
  await db.updateClip(clipId, { completed_at: null });
  notifyMainWindow('clips-changed');
  return true;
});

// ── IPC Handlers: Categories ──

ipcMain.handle('get-categories', () => db.getCategories());

ipcMain.handle('save-categories', async (_, cats) => {
  if (!Array.isArray(cats)) return false;
  for (const name of cats) await db.saveCategory(name);
  return true;
});

// ── IPC Handlers: Projects ──

ipcMain.handle('get-projects', () => db.getProjects());
ipcMain.handle('get-project', (_, id) => db.getProject(id));

ipcMain.handle('create-project', async (_, data) => {
  const project = await db.createProject(data);
  rules.invalidateCache();
  notifyMainWindow('projects-changed');
  return project;
});

ipcMain.handle('update-project', async (_, id, data) => {
  const project = await db.updateProject(id, data);
  rules.invalidateCache();
  notifyMainWindow('projects-changed');
  return project;
});

ipcMain.handle('delete-project', async (_, id) => {
  await db.deleteProject(id);
  rules.invalidateCache();
  notifyMainWindow('projects-changed');
  notifyMainWindow('clips-changed');
  return true;
});

// ── IPC Handlers: Settings ──

ipcMain.handle('get-settings', () => db.getAllSettings());
ipcMain.handle('get-setting', (_, key) => db.getSettings(key));
ipcMain.handle('save-setting', async (_, key, value) => {
  await db.saveSetting(key, value);
  return true;
});

// ── IPC Handlers: AI ──

ipcMain.handle('ai-categorize', async (_, comment, imageData) => {
  const cats = await db.getCategories();
  const projects = await db.getProjects();
  return ai.categorize(comment, cats, imageData, projects);
});

ipcMain.handle('ai-search', async (_, query) => {
  const clips = await db.getClips();
  return ai.search(query, clips);
});

ipcMain.handle('has-api-key', () => ai.isEnabled());

ipcMain.handle('summarize-project', async (_, projectId) => {
  const projectClips = await db.getClips(projectId);
  const missing = projectClips.filter((c) => !c.aiFixPrompt && (c.comment || c.image));
  if (missing.length > 0 && ai.isEnabled()) {
    // Load and compress screenshots for each note so AI can analyze them
    const notesWithImages = missing.map((c) => {
      const raw = images.loadImage(c.id);
      return {
        id: c.id,
        comment: c.comment || '',
        imageDataURL: raw ? images.compressForAI(raw) : null,
      };
    });
    const generated = await ai.summarizeNotes(notesWithImages);
    for (const item of generated) {
      const clip = projectClips.find((c) => c.id === item.id);
      if (clip && item.summary) {
        clip.aiFixPrompt = item.summary;
        const newCount = (clip.summarizeCount || 0) + 1;
        clip.summarizeCount = newCount;
        await db.updateClip(clip.id, { aiFixPrompt: item.summary, summarize_count: newCount });
      }
    }
    notifyMainWindow('clips-changed');
  }
  return projectClips.map((c) => ({
    id: c.id,
    comment: c.comment || '',
    aiSummary: c.aiSummary || '',
    aiFixPrompt: c.aiFixPrompt || '',
    category: c.category || '',
    tags: c.tags || [],
    timestamp: c.timestamp,
    summarizeCount: c.summarizeCount || 0,
  }));
});

// ── IPC Handlers: AI Prompt ──

ipcMain.handle('get-prompt-blocks', () => ai.getPromptBlocks());

ipcMain.handle('save-prompt-blocks', async (_, enabled, custom) => {
  ai.setPromptBlocks(enabled, custom);
  await db.saveSetting('prompt_blocks', { enabled, custom });
  return ai.getPromptBlocks();
});

ipcMain.handle('reset-prompt-blocks', async () => {
  ai.resetPromptBlocks();
  await db.saveSetting('prompt_blocks', null);
  return ai.getPromptBlocks();
});

ipcMain.handle('add-custom-block', async (_, label, text) => {
  const blocks = ai.getPromptBlocks();
  const custom = blocks.custom.map(c => ({ id: c.id, label: c.label, text: c.text, enabled: c.enabled }));
  custom.push({ id: `custom_${Date.now()}`, label, text, enabled: true });
  const enabled = {};
  for (const b of blocks.blocks) enabled[b.id] = b.enabled;
  ai.setPromptBlocks(enabled, custom);
  await db.saveSetting('prompt_blocks', { enabled, custom });
  return ai.getPromptBlocks();
});

ipcMain.handle('get-app-version', () => {
  const pkg = require('../package.json');
  return { version: pkg.version, electron: process.versions.electron, node: process.versions.node };
});

// ── Audit Ledger ──

const MAX_AUDIT_ENTRIES = 200;
let auditLog = [];

async function loadAuditLog() {
  try {
    const stored = await db.getSettings('audit_log');
    if (stored && Array.isArray(stored.entries)) {
      auditLog = stored.entries;
    }
  } catch { /* first run — no log yet */ }
}

async function addAuditEntry(action, detail) {
  auditLog.unshift({ ts: Date.now(), action, detail });
  if (auditLog.length > MAX_AUDIT_ENTRIES) auditLog.length = MAX_AUDIT_ENTRIES;
  await db.saveSetting('audit_log', { entries: auditLog });
}

ipcMain.handle('get-audit-log', () => auditLog);
ipcMain.handle('clear-audit-log', async () => {
  auditLog = [];
  await db.saveSetting('audit_log', { entries: [] });
  return true;
});

ipcMain.handle('get-db-backend', () => db.getBackendName());

// Manual AI retrigger for a single clip
ipcMain.handle('retrigger-ai', async (_, clipId) => {
  if (typeof clipId !== 'string') return false;
  const clip = await db.getClip(clipId);
  if (!clip) return false;
  if (!ai.isEnabled()) return false;
  const imageData = images.loadImage(clipId);
  await autoCategorize(clipId, clip.comment || '', imageData, clip.windowTitle, clip.processName);
  return true;
});

// ── IPC Handlers: App Mode ──

ipcMain.handle('get-app-mode', async () => await getAppMode());

ipcMain.handle('toggle-app-mode', async () => {
  const current = await getAppMode();
  const next = current === 'lite' ? 'full' : 'lite';
  await db.saveSetting('app_mode', next);
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.destroy(); mainWindow = null; }
  if (captureWindow && !captureWindow.isDestroyed()) { captureWindow.destroy(); captureWindow = null; }
  await createMainWindow();
  mainWindow.show();
  rebuildTrayMenu();
  return next;
});

ipcMain.handle('set-lite-active-project', async (_, projectId) => {
  await db.saveSetting('lite_active_project', projectId);
  return true;
});

ipcMain.handle('toggle-project-ide', async (_, projectId) => {
  const project = await db.getProject(projectId);
  if (!project) return null;
  const newVal = !project.active_in_ide;
  await db.updateProject(projectId, { active_in_ide: newVal });
  notifyMainWindow('projects-changed');
  return newVal;
});

// ── IPC Handlers: Workflow ──

ipcMain.handle('get-workflow-status', async () => {
  const workflowDir = path.join(__dirname, '..', '.ai-workflow');
  const contextDir = path.join(workflowDir, 'context');
  const read = (f) => { try { return fs.readFileSync(path.join(contextDir, f), 'utf8').trim(); } catch { return null; } };
  return {
    relayMode: read('RELAY_MODE') || 'review',
    auditMode: read('AUDIT_WATCH_MODE') || 'off',
    session: read('SESSION.md'),
    hasWorkflow: fs.existsSync(workflowDir),
  };
});

ipcMain.handle('toggle-relay-mode', async () => {
  const contextDir = path.join(__dirname, '..', '.ai-workflow', 'context');
  const file = path.join(contextDir, 'RELAY_MODE');
  let current = 'review';
  try { current = fs.readFileSync(file, 'utf8').trim(); } catch {}
  const next = current === 'auto' ? 'review' : 'auto';
  fs.writeFileSync(file, next, 'utf8');
  return next;
});

ipcMain.handle('toggle-audit-watch', async () => {
  const contextDir = path.join(__dirname, '..', '.ai-workflow', 'context');
  const file = path.join(contextDir, 'AUDIT_WATCH_MODE');
  let current = 'off';
  try { current = fs.readFileSync(file, 'utf8').trim(); } catch {}
  const next = current === 'on' ? 'off' : 'on';
  fs.writeFileSync(file, next, 'utf8');
  return next;
});

ipcMain.handle('get-workflow-changelog', async () => {
  const p = path.join(__dirname, '..', '.ai-workflow', 'context', 'CHANGELOG.md');
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
});

ipcMain.handle('get-workflow-prompts', async () => {
  const p = path.join(__dirname, '..', '.ai-workflow', 'context', 'PROMPT_TRACKER.log');
  try {
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => {
      const parts = line.split('|');
      return { id: parts[0], status: parts[1], timestamp: parts[2], description: parts[3], type: parts[4] || 'CRAFTED', parentId: parts[5] || null };
    }).reverse();
  } catch { return []; }
});

ipcMain.handle('get-workflow-audits', async () => {
  const p = path.join(__dirname, '..', '.ai-workflow', 'context', 'AUDIT_LOG.md');
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
});

// ── IPC Handlers: Window Controls ──

ipcMain.on('close-capture', () => {
  if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
});

ipcMain.on('hide-main', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
});

ipcMain.on('open-capture', async () => {
  await createCaptureWindow(getClipboardImageURL());
});

// ── IPC Handlers: Setup Wizard ──

const { execSync, exec } = require('child_process');

ipcMain.handle('setup-check-docker', async () => {
  try {
    const out = execSync('docker --version', { encoding: 'utf8', timeout: 5000 });
    const match = out.match(/Docker version ([\d.]+)/);
    return { installed: true, version: match ? match[1] : '' };
  } catch {
    return { installed: false };
  }
});

ipcMain.handle('setup-check-db', async () => {
  try {
    const out = execSync('docker ps --filter name=sciurus-db --format "{{.Status}}"', { encoding: 'utf8', timeout: 5000 });
    return { running: out.trim().length > 0 };
  } catch {
    return { running: false };
  }
});

ipcMain.handle('setup-start-db', async () => {
  // Detect docker compose v2 (docker compose) vs v1 (docker-compose)
  let composeCmd = 'docker-compose';
  try {
    execSync('docker compose version', { encoding: 'utf8', timeout: 5000 });
    composeCmd = 'docker compose';
  } catch {}

  return new Promise((resolve) => {
    const composeFile = path.join(__dirname, '..', 'docker-compose.yml');
    exec(`${composeCmd} -f "${composeFile}" up -d`, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[Setup] docker compose failed:', stderr);
        resolve({ ok: false, error: stderr.split('\n')[0] || err.message });
      } else {
        // Wait a moment for the health check
        setTimeout(async () => {
          try {
            const ready = await db.init();
            resolve({ ok: ready });
          } catch {
            resolve({ ok: false, error: 'Database started but connection failed' });
          }
        }, 3000);
      }
    });
  });
});

ipcMain.handle('setup-check-credentials', async () => {
  const credPath = path.join(__dirname, '..', 'credentials.json');
  if (!fs.existsSync(credPath)) return { found: false };
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    return { found: true, projectId: creds.project_id || null };
  } catch {
    return { found: false };
  }
});

ipcMain.handle('setup-save-env', async (_, key, value) => {
  const envPath = path.join(__dirname, '..', '.env');
  // Validate key/value to prevent injection
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return false;
  const safeValue = String(value).replace(/[\r\n]/g, '').trim();
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }
  // Replace existing key or append
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${safeValue}`);
  } else {
    content = content.trimEnd() + `\n${key}=${safeValue}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
  // Also set in current process
  process.env[key] = safeValue;
  return true;
});

ipcMain.handle('setup-use-sqlite', async () => {
  process.env.DB_BACKEND = 'sqlite';
  try {
    const ok = await db.init();
    return { ok };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('setup-finish', async () => {
  const envPath = path.join(__dirname, '..', '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  // Always write hotkey default
  const defaults = { HOTKEY_COMBO: 'ctrl+shift+q' };

  // Only write PostgreSQL defaults if not using SQLite
  if (process.env.DB_BACKEND !== 'sqlite') {
    Object.assign(defaults, {
      DB_BACKEND: 'pg',
      POSTGRES_HOST: 'localhost',
      POSTGRES_PORT: '5433',
      POSTGRES_DB: 'sciurus',
      POSTGRES_USER: 'sciurus',
      POSTGRES_PASSWORD: 'sciurus_dev',
    });
  } else {
    if (!content.includes('DB_BACKEND=')) {
      content += `DB_BACKEND=sqlite\n`;
      process.env.DB_BACKEND = 'sqlite';
    }
  }

  for (const [k, v] of Object.entries(defaults)) {
    if (!content.includes(`${k}=`)) {
      content += `${k}=${v}\n`;
      process.env[k] = v;
    }
  }
  fs.writeFileSync(envPath, content, 'utf8');

  // Close setup window and launch the main app
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close();
  }
  await launchMainApp();
});

// ── Auto-launch on login ──

if (app.isPackaged && process.platform === 'win32') {
  app.setLoginItemSettings({ openAtLogin: true, name: 'Sciurus' });
}

// ── App Lifecycle ──

/** Launch the main app (called after setup or directly on normal start). */
async function launchMainApp() {
  // Initialize database BEFORE creating the window (renderer calls getClips on load)
  const dbReady = await db.init();
  if (!dbReady) {
    dialog.showErrorBox(
      'Sciurus — Database Error',
      'Could not initialize any database backend.\n\nEither:\n  • Start Docker: docker compose up -d\n  • Or install better-sqlite3: npm install\n\nThen restart Sciurus.'
    );
    isQuitting = true;
    app.quit();
    return;
  }
  console.log(`[Sciurus] Database backend: ${db.getBackendName()}`);

  // One-time migration from electron-store
  await migrateIfNeeded();

  if (!mainWindow) await createMainWindow();
  createTray();

  // Show the main window
  mainWindow.show();
  mainWindow.focus();

  startClipboardWatcher();
  createToolbarWindow();
  ai.init();

  // Load saved prompt block config from DB
  const savedBlocks = await db.getSettings('prompt_blocks');
  if (savedBlocks && savedBlocks.enabled) {
    ai.setPromptBlocks(savedBlocks.enabled, savedBlocks.custom || []);
    console.log('[Sciurus] Custom prompt config loaded from settings');
  }
  retryUncategorized();

  // Load audit log
  await loadAuditLog();

  // Start local HTTP API for MCP server / external tool access
  const { startApiServer } = require('./api-server');
  startApiServer({ db, ai, rules, images, sanitizeUpdates, autoCategorize, addAuditEntry });

  // Auto-purge trash items older than 30 days
  db.purgeTrash(30).then((n) => {
    if (n > 0) console.log(`[Sciurus] Purged ${n} old trashed clip(s)`);
  }).catch((e) => console.error('[Sciurus] Trash purge failed:', e.message));

  // One-time migration: move archived clips to trash
  db.migrateArchivedToTrash().catch((e) =>
    console.error('[Sciurus] Archive→Trash migration failed:', e.message)
  );

  const hotkey = process.env.HOTKEY_COMBO || 'CommandOrControl+Shift+Q';
  globalShortcut.register(hotkey, async () => {
    const windowMeta = getActiveWindow();
    await createCaptureWindow(getClipboardImageURL(), windowMeta);
  });
}

app.on('second-instance', () => {
  const win = mainWindow || setupWindow;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  if (isFirstRun()) {
    // Show setup wizard for new users
    createSetupWindow();
  } else {
    // Normal launch
    await launchMainApp();
  }
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  if (clipboardWatcher) clearInterval(clipboardWatcher);
  if (toolbarWindow && !toolbarWindow.isDestroyed()) toolbarWindow.destroy();
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  await db.close();
});
