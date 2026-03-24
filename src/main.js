// src/main.js — Electron main process: tray, hotkey, IPC, clipboard watcher

// Clear before requiring electron — inherited from VS Code / Claude Code shell
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, Tray, Menu, clipboard, nativeImage, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const ai = require('./ai');
const sheets = require('./sheets');

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

// ── Constants ──

const CLIPBOARD_POLL_MS = 500;
const DEFAULT_CATEGORIES = [
  'Uncategorized', 'cvstomize.com', 'PowerToys', 'LLM Setup',
  'Hardware/GPU', 'Ideas', 'Code Patterns',
];
const ALLOWED_CLIP_FIELDS = [
  'category', 'tags', 'aiSummary', 'url', 'status', 'comments',
];

// Tiny 32x32 fallback icon (transparent PNG) for the system tray
const FALLBACK_TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0'
  + 'AAAAAXNSR0IArs4c6QAAAE1JREFUWGFoAAAADklEQVRIx2NgGAWjYBQMfQAABPAAATG1XiAAAAAASUVORK5CYII=';

// ── State ──

const store = new Store({ name: 'sciurus-data' });
let tray = null;
let mainWindow = null;
let captureWindow = null;
let clipboardWatcher = null;
let lastClipHash = null;
let watcherPaused = false;

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

// ── Windows ──

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 960, height: 700, show: false,
    title: 'Sciurus',
    backgroundColor: '#13131f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('close', (e) => { e.preventDefault(); mainWindow.hide(); });
}

function createCaptureWindow(imageDataURL) {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.focus();
    captureWindow.webContents.send('new-screenshot', imageDataURL);
    return;
  }
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  captureWindow = new BrowserWindow({
    width: 460, height: 520,
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
    if (imageDataURL) captureWindow.webContents.send('new-screenshot', imageDataURL);
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
      if (url) createCaptureWindow(url);
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
    { label: 'Quit', click: () => app.exit() },
  ]));
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
}

// ── Category Sync ──

/** Merge categories from Google Sheets into local store. */
async function syncCategories() {
  if (!sheets.isEnabled()) return;
  const sheetCats = await sheets.getCategories();
  if (!sheetCats || !sheetCats.length) return;
  const local = store.get('categories', DEFAULT_CATEGORIES);
  const merged = [...new Set([...local, ...sheetCats])];
  store.set('categories', merged);
  console.log(`[Sciurus] Categories synced: ${merged.length} total`);
}

// ── IPC Handlers ──

ipcMain.handle('get-clips', () => store.get('clips', []));
ipcMain.handle('get-categories', () => store.get('categories', DEFAULT_CATEGORIES));

ipcMain.handle('save-clip', (_, clip) => {
  if (!clip || typeof clip.id !== 'string') return false;
  const clips = store.get('clips', []);
  clips.unshift(clip);
  store.set('clips', clips);
  notifyMainWindow('clips-updated', clips);
  return true;
});

ipcMain.handle('update-clip', (_, id, updates) => {
  if (typeof id !== 'string' || !updates) return false;
  const safe = sanitizeUpdates(updates);
  const clips = store.get('clips', []);
  const idx = clips.findIndex((c) => c.id === id);
  if (idx !== -1) {
    clips[idx] = { ...clips[idx], ...safe };
    store.set('clips', clips);

    // Background sync to Sheets after AI categorization
    if (safe.category || safe.tags || safe.aiSummary) {
      sheets.saveClip(clips[idx]).catch((e) =>
        console.error('[Sheets] Background sync error:', e.message)
      );
    }
  }
  notifyMainWindow('clips-updated', clips);
  return true;
});

ipcMain.handle('delete-clip', (_, id) => {
  if (typeof id !== 'string') return false;
  const clips = store.get('clips', []).filter((c) => c.id !== id);
  store.set('clips', clips);
  notifyMainWindow('clips-updated', clips);
  return true;
});

ipcMain.handle('save-categories', (_, cats) => {
  if (!Array.isArray(cats)) return false;
  store.set('categories', cats);
  return true;
});

ipcMain.handle('ai-categorize', async (_, comment, imageData) => {
  const cats = store.get('categories', DEFAULT_CATEGORIES);
  return ai.categorize(comment, cats, imageData);
});

ipcMain.handle('ai-search', async (_, query) => {
  const clips = store.get('clips', []);
  return ai.search(query, clips);
});

ipcMain.handle('has-api-key', () => ai.isEnabled());

ipcMain.on('close-capture', () => {
  if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
});

ipcMain.on('open-capture', () => {
  createCaptureWindow(getClipboardImageURL());
});

// ── App Lifecycle ──

app.whenReady().then(async () => {
  createMainWindow();
  createTray();
  startClipboardWatcher();
  ai.init();
  sheets.init();
  await syncCategories();
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    createCaptureWindow(getClipboardImageURL());
  });
});

app.on('window-all-closed', (e) => e.preventDefault());

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (clipboardWatcher) clearInterval(clipboardWatcher);
});
