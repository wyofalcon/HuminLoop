// src/main.js — Electron main process: tray, hotkey, IPC, clipboard watcher, PostgreSQL

// Clear before requiring electron — inherited from VS Code / Claude Code shell
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, Tray, Menu, clipboard, nativeImage, globalShortcut, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const ai = require('./ai');
const rules = require('./rules');
const { getActiveWindow } = require('./window-info');
const images = require('./images');

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
  'category', 'tags', 'aiSummary', 'url', 'status', 'comments', 'project_id', 'comment',
  'window_title', 'process_name',
];

// Tiny 32x32 fallback icon (transparent PNG) for the system tray
const FALLBACK_TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0'
  + 'AAAAAXNSR0IArs4c6QAAAE1JREFUWGFoAAAADklEQVRIx2NgGAWjYBQMfQAABPAAATG1XiAAAAAASUVORK5CYII=';

// ── State ──

let tray = null;
let mainWindow = null;
let captureWindow = null;
let setupWindow = null;
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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 750, show: false,
    title: 'Sciurus',
    backgroundColor: '#13131f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createCaptureWindow(imageDataURL, windowMeta = null) {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.show();
    captureWindow.focus();
    captureWindow.webContents.focus();
    captureWindow.webContents.send('new-screenshot', imageDataURL, windowMeta);
    return;
  }
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  captureWindow = new BrowserWindow({
    width: 460, height: 580,
    x: screenW - 480, y: 20,
    frame: false, alwaysOnTop: true,
    resizable: true, skipTaskbar: true,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  captureWindow.loadFile(path.join(__dirname, '..', 'renderer', 'capture.html'));
  captureWindow.once('ready-to-show', () => {
    captureWindow.show();
    captureWindow.focus();
    captureWindow.webContents.focus();
    if (imageDataURL) captureWindow.webContents.send('new-screenshot', imageDataURL, windowMeta);
  });
  captureWindow.on('closed', () => { captureWindow = null; });
}

// ── Clipboard Watcher ──

function startClipboardWatcher() {
  lastClipHash = getClipboardImageHash();
  clipboardWatcher = setInterval(() => {
    if (watcherPaused) return;
    const hash = getClipboardImageHash();
    if (hash && hash !== lastClipHash) {
      lastClipHash = hash;
      const url = getClipboardImageURL();
      if (url) {
        // Capture active window metadata BEFORE opening popup
        const windowMeta = getActiveWindow();
        console.log(`[Sciurus] Window context: ${windowMeta.processName} — ${windowMeta.title}`);
        createCaptureWindow(url, windowMeta);
      }
    }
  }, CLIPBOARD_POLL_MS);
}

// ── System Tray ──

function createTray() {
  const icon = nativeImage.createFromDataURL(FALLBACK_TRAY_ICON);
  tray = new Tray(icon);
  tray.setToolTip('Sciurus');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Sciurus', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Quick Capture', click: () => createCaptureWindow(null) },
    { type: 'separator' },
    { label: 'Pause Watcher', type: 'checkbox', checked: false, click: (item) => {
      watcherPaused = item.checked;
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
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
  const pending = clips.filter((c) => c.category === 'Uncategorized' && c.comment);
  if (!pending.length) return;
  console.log(`[Sciurus] Retrying AI for ${pending.length} uncategorized clip(s)...`);
  for (const clip of pending) {
    await autoCategorize(clip.id, clip.comment, clip.image);
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
    if (result.category) updates.category = result.category;
    if (result.tags) updates.tags = result.tags;
    if (result.summary) updates.aiSummary = result.summary;
    if (result.url) updates.url = result.url;

    // AI-suggested project assignment (only if clip isn't already assigned)
    const clip = await db.getClip(clipId);
    if (result.project_id && (!clip || !clip.project_id)) {
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
  } catch (e) {
    console.error('[Sciurus] Auto-categorize failed:', e.message);
  }
}

// ── IPC Handlers: Clips ──

ipcMain.handle('get-clips', () => db.getClips());
ipcMain.handle('get-general-clips', () => db.getClips(null));
ipcMain.handle('get-clips-for-project', (_, projectId) => db.getClips(projectId));

ipcMain.handle('save-clip', async (_, clip) => {
  if (!clip || typeof clip.id !== 'string') return false;

  // Save image to disk, store flag in DB instead of full base64
  const imageData = clip.image;
  if (imageData) {
    images.saveImage(clip.id, imageData);
    clip.image = '__on_disk__';
  }

  // Rule-based categorization (before saving — so the clip gets correct initial values)
  if (clip.category === 'Uncategorized' || !clip.project_id) {
    const ruleResult = await rules.categorize(clip.window_title, clip.process_name);
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

  // AI categorization as fallback — only if still uncategorized after rules
  if (clip.category === 'Uncategorized' && clip.comment && ai.isEnabled()) {
    console.log(`[Sciurus] Starting AI categorization for: "${clip.comment.slice(0, 30)}"`);
    autoCategorize(clip.id, clip.comment, imageData, clip.window_title, clip.process_name);
  }
  return true;
});

// Load image on demand from disk
ipcMain.handle('get-clip-image', (_, clipId) => {
  return images.loadImage(clipId);
});

ipcMain.handle('update-clip', async (_, id, updates) => {
  if (typeof id !== 'string' || !updates) return false;
  const safe = sanitizeUpdates(updates);
  await db.updateClip(id, safe);
  notifyMainWindow('clips-changed');
  return true;
});

ipcMain.handle('delete-clip', async (_, id) => {
  if (typeof id !== 'string') return false;
  images.deleteImage(id);
  await db.deleteClip(id);
  notifyMainWindow('clips-changed');
  return true;
});

ipcMain.handle('assign-clip-to-project', async (_, clipId, projectId) => {
  await db.updateClip(clipId, { project_id: projectId });
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

ipcMain.handle('get-app-version', () => {
  const pkg = require('../package.json');
  return { version: pkg.version, electron: process.versions.electron, node: process.versions.node };
});

ipcMain.handle('get-db-backend', () => db.getBackendName());

// ── IPC Handlers: Window Controls ──

ipcMain.on('close-capture', () => {
  if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
});

ipcMain.on('hide-main', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
});

ipcMain.on('open-capture', () => {
  createCaptureWindow(getClipboardImageURL());
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
  return new Promise((resolve) => {
    const composeFile = path.join(__dirname, '..', 'docker-compose.yml');
    exec(`docker-compose -f "${composeFile}" up -d`, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[Setup] docker-compose failed:', stderr);
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
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }
  // Replace existing key or append
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
  // Also set in current process
  process.env[key] = value;
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

if (app.isPackaged) {
  app.setLoginItemSettings({ openAtLogin: true, name: 'Sciurus' });
}

// ── App Lifecycle ──

/** Launch the main app (called after setup or directly on normal start). */
async function launchMainApp() {
  if (!mainWindow) createMainWindow();
  createTray();

  // Initialize database (waits for Docker PostgreSQL)
  const dbReady = await db.init();
  if (!dbReady) {
    dialog.showErrorBox(
      'Sciurus — Database Error',
      'Could not initialize any database backend.\n\nEither:\n  • Start Docker: docker-compose up -d\n  • Or install better-sqlite3: npm install\n\nThen restart Sciurus.'
    );
    isQuitting = true;
    app.quit();
    return;
  }
  console.log(`[Sciurus] Database backend: ${db.getBackendName()}`);

  // One-time migration from electron-store
  await migrateIfNeeded();

  // Show the main window
  mainWindow.show();
  mainWindow.focus();

  startClipboardWatcher();
  ai.init();
  retryUncategorized();

  const hotkey = process.env.HOTKEY_COMBO || 'CommandOrControl+Shift+Q';
  globalShortcut.register(hotkey, () => {
    const windowMeta = getActiveWindow();
    createCaptureWindow(getClipboardImageURL(), windowMeta);
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
  await db.close();
});
