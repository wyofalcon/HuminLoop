# HuminLoop Lite Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable "Lite" mode to HuminLoop — a single-clip-at-a-time UI focused on fast AI prompt generation from annotated screenshots.

**Architecture:** Same Electron app with a mode toggle (`app_mode` setting). Lite mode uses separate renderer files (`lite-index.*`, `lite-capture.*`) while sharing all main process modules (db, ai, rules, images). A new `source` column on clips lets lite mode filter to its own clips. The overlay gets a text annotation tool. A shared workflow context reader feeds project session data into AI prompt generation.

**Tech Stack:** Electron, better-sqlite3, pg, Node.js fs, existing Gemini AI module

**Spec:** `docs/superpowers/specs/2026-04-04-sciurus-lite-mode-design.md` (file retains original name)

---

## File Map

**New files:**
| File | Purpose |
|------|---------|
| `src/workflow-context.js` | Shared utility — reads SESSION.md and AUDIT_LOG.md from a project's repo_path |
| `renderer/lite-index.html` | Lite main window markup |
| `renderer/lite-index.js` | Lite main window logic (single-card view, nav, prompt display) |
| `renderer/lite-index.css` | Lite main window styles |
| `renderer/lite-capture.html` | Lite capture popup markup |
| `renderer/lite-capture.js` | Lite capture logic (screenshot + note + save) |
| `renderer/lite-capture.css` | Lite capture popup styles |

**Modified files:**
| File | What changes |
|------|--------------|
| `docker/init.sql` | Add `source` column to clips table |
| `src/db-pg.js` | Migration for `source` column, update `getClips()` and `saveClip()` |
| `src/db-sqlite.js` | Migration for `source` column, update `getClips()` and `saveClip()` |
| `src/ai.js` | Add `generateLitePrompt()` function and lite prompt template |
| `src/main.js` | Mode switching, modified save-clip/get-clips, new IPC handlers, tray menu rebuild, lite autoCategorize path |
| `src/preload.js` | New IPC methods: `toggleAppMode`, `getAppMode`, `getLiteClips`, `setLiteActiveProject` |
| `renderer/overlay.js` | Text tool: click-to-type, keyboard commit, canvas rasterization |
| `renderer/overlay.html` | Hidden text input element for text tool |
| `renderer/overlay.css` | Text cursor and input styling |
| `renderer/toolbar.html` | Add `T` button for text mode |
| `renderer/toolbar.js` | Text mode toggle logic + IPC |
| `renderer/toolbar.css` | T button styling |

---

## Task 1: Database — Add `source` Column

**Files:**
- Modify: `docker/init.sql:50-69`
- Modify: `src/db-pg.js:181-237` (getClips, saveClip)
- Modify: `src/db-sqlite.js:43-62,258-299` (schema, getClips, saveClip)

- [ ] **Step 1: Add `source` column to `docker/init.sql`**

In the clips table definition at line 68 (before `window_title`), add:

```sql
    source      VARCHAR(10) NOT NULL DEFAULT 'full',
```

- [ ] **Step 2: Add migration in `src/db-pg.js`**

Find the migrations section (look for `runMigrations` or `ALTER TABLE` patterns). Add:

```javascript
// Migration: add source column to clips
try {
  await pool.query(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'full'`);
} catch (e) {
  // Column may already exist
}
```

- [ ] **Step 3: Add migration in `src/db-sqlite.js`**

Find the migrations section. SQLite doesn't support `IF NOT EXISTS` on `ALTER TABLE`, so use a try/catch:

```javascript
// Migration: add source column to clips
try {
  db.exec(`ALTER TABLE clips ADD COLUMN source TEXT NOT NULL DEFAULT 'full'`);
} catch (e) {
  // Column already exists — ignore "duplicate column name" error
}
```

- [ ] **Step 4: Update `getClips()` in `src/db-pg.js` to accept source filter**

At `db-pg.js:181`, modify the function signature and query. Add an optional `source` parameter:

```javascript
async function getClips(projectId, source) {
```

Add to the WHERE clause building logic:

```javascript
if (source) {
  conditions.push(`cl.source = $${params.length + 1}`);
  params.push(source);
}
```

- [ ] **Step 5: Update `getClips()` in `src/db-sqlite.js` to accept source filter**

At `db-sqlite.js:258`, modify similarly:

```javascript
async function getClips(projectId, source) {
```

Add to the WHERE clause:

```javascript
if (source) {
  conditions.push(`cl.source = ?`);
  params.push(source);
}
```

- [ ] **Step 6: Update `saveClip()` in `src/db-pg.js` to include source**

At `db-pg.js:207-237`, add `source` to the INSERT columns and values:

```javascript
const source = clip.source || 'full';
```

Add `source` to the column list and `$N` parameter in the INSERT statement.

- [ ] **Step 7: Update `saveClip()` in `src/db-sqlite.js` to include source**

At `db-sqlite.js:275-299`, add `source` to the INSERT statement similarly:

```javascript
const source = clip.source || 'full';
```

Add to the column list, placeholder, and params array.

- [ ] **Step 8: Update `db.js` delegation**

In `src/db.js`, the `getClips` delegation already uses spread args (`...a`), so the new `source` param passes through automatically. Verify this by reading the delegation line.

- [ ] **Step 9: Verify — start the app and check DB**

```bash
npm run dev
```

Open DevTools console, run:
```javascript
await window.quickclip.getClips()
```

Confirm clips load without errors. Check a clip object has `source: 'full'` (or no source if column default hasn't applied yet to old clips — that's fine, the query handles it).

- [ ] **Step 10: Commit**

```bash
git add src/db-pg.js src/db-sqlite.js docker/init.sql
git commit -m "feat(db): add source column to clips table for lite mode filtering"
```

---

## Task 2: Workflow Context Reader

**Files:**
- Create: `src/workflow-context.js`

This is a standalone utility that reads AI dev workflow context from a project's repository path. Built as shared functions so full mode can reuse them later.

- [ ] **Step 1: Create `src/workflow-context.js`**

```javascript
// src/workflow-context.js — Read AI dev workflow context from a project's repo
const fs = require('fs');
const path = require('path');

/**
 * Read SESSION.md from a project's .ai-workflow/context/ directory.
 * Returns the file contents as a string, or null if not found.
 * @param {string} repoPath — absolute path to the project repository
 */
function readSessionContext(repoPath) {
  if (!repoPath) return null;
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'SESSION.md');
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Read AUDIT_LOG.md from a project's .ai-workflow/context/ directory.
 * Returns the file contents as a string, or null if not found.
 * @param {string} repoPath �� absolute path to the project repository
 */
function readAuditFindings(repoPath) {
  if (!repoPath) return null;
  const filePath = path.join(repoPath, '.ai-workflow', 'context', 'AUDIT_LOG.md');
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Check if a project has an AI dev workflow set up.
 * @param {string} repoPath — absolute path to the project repository
 */
function hasWorkflow(repoPath) {
  if (!repoPath) return false;
  return fs.existsSync(path.join(repoPath, '.ai-workflow'));
}

module.exports = { readSessionContext, readAuditFindings, hasWorkflow };
```

- [ ] **Step 2: Verify — quick smoke test**

```bash
node -e "const wc = require('./src/workflow-context'); console.log(wc.readSessionContext('.')); console.log(wc.hasWorkflow('.'));"
```

Expected: prints the contents of `.ai-workflow/context/SESSION.md` (or null), and `true` (since this repo has `.ai-workflow/`).

- [ ] **Step 3: Commit**

```bash
git add src/workflow-context.js
git commit -m "feat: add workflow context reader utility for AI prompt enrichment"
```

---

## Task 3: AI Module — Lite Prompt Generation

**Files:**
- Modify: `src/ai.js:22-116,223-269`

- [ ] **Step 1: Add lite prompt template constant in `src/ai.js`**

After the existing `CORE_OUTPUT` constant (around line 116), add:

```javascript
const LITE_PROMPT = `You are analyzing a screenshot with colored annotations from a developer.
The annotations follow this color coding:
- RED markings (circles, crosses, text): Remove, delete, or fix what is marked
- GREEN markings (circles, highlights, text): Add or create something at this location
- PINK/PURPLE markings (circles, highlights, text): Reference point — the user is identifying or pointing out this element for context. It may or may not need changes.

PRIORITY: The developer's written note is the primary source of intent. If the note clarifies, overrides, or adds nuance to what the color annotations suggest, follow the note. Annotations are also expressions of intent and should be treated as instructions — but when the note and annotations conflict, the note wins.

Use the project context and session information to generate a more specific and relevant prompt. Reference the current branch, recent work, and known issues where they relate to what the annotations and note describe.

Generate a single, specific, actionable prompt that a coding AI could execute directly. Be concrete about what to change based on the annotations and note. Reference pink-marked elements as context when relevant. Output only the prompt text, no explanation or formatting.`;
```

- [ ] **Step 2: Add `generateLitePrompt()` function**

After the existing `categorize()` function (around line 269), add:

```javascript
/**
 * Generate a focused coding prompt from an annotated screenshot (lite mode).
 * @param {string} comment — user's typed note
 * @param {string|null} imageDataURL — screenshot with annotations
 * @param {object} windowMeta — { windowTitle, processName }
 * @param {object} project — { name, description, repo_path }
 * @param {object} workflowContext — { session, audit } (strings or null)
 * @returns {string|null} — the generated prompt text, or null on failure
 */
async function generateLitePrompt(comment, imageDataURL, windowMeta = {}, project = {}, workflowContext = {}) {
  if (!isEnabled()) return null;

  // Build user text with context
  const parts = [];
  if (comment) parts.push(`Developer's note: ${comment}`);
  if (windowMeta.windowTitle) parts.push(`Window: ${windowMeta.processName || 'unknown'} — ${windowMeta.windowTitle}`);
  if (project.name) parts.push(`Project: ${project.name}`);
  if (project.repo_path) parts.push(`Repository: ${project.repo_path}`);
  if (project.description) parts.push(`Description: ${project.description}`);
  if (workflowContext.session) parts.push(`\nCurrent development session context:\n${workflowContext.session}`);
  if (workflowContext.audit) parts.push(`\nRecent code audit findings:\n${workflowContext.audit}`);

  const userText = parts.join('\n');

  // Build message with optional image
  const messageParts = [];
  if (imageDataURL) {
    const mimeMatch = imageDataURL.match(/^data:(image\/\w+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const base64 = imageDataURL.replace(/^data:image\/\w+;base64,/, '');
    messageParts.push({ inlineData: { mimeType, data: base64 } });
  }
  messageParts.push({ text: userText });

  try {
    const result = await callGemini(LITE_PROMPT, messageParts);
    if (!result) return null;
    // The response should be plain text prompt — strip any wrapping quotes or markdown
    return result.replace(/^["'`]+|["'`]+$/g, '').trim();
  } catch (e) {
    console.error('[HuminLoop AI] Lite prompt generation failed:', e.message);
    return null;
  }
}
```

- [ ] **Step 3: Export `generateLitePrompt`**

Find the `module.exports` at the end of `ai.js` and add `generateLitePrompt`:

```javascript
module.exports = {
  init, categorize, isEnabled, search, summarizeClips,
  getPromptBlocks, setPromptBlocks, resetPromptBlocks, addCustomBlock,
  generateLitePrompt,
};
```

- [ ] **Step 4: Verify — module loads without errors**

```bash
node -e "const ai = require('./src/ai'); console.log(typeof ai.generateLitePrompt);"
```

Expected: `function`

- [ ] **Step 5: Commit**

```bash
git add src/ai.js
git commit -m "feat(ai): add generateLitePrompt for lite mode prompt generation"
```

---

## Task 4: Overlay — Text Annotation Tool

**Files:**
- Modify: `renderer/overlay.html:8-14`
- Modify: `renderer/overlay.js:3-85`
- Modify: `renderer/overlay.css`

- [ ] **Step 1: Add hidden text input to `renderer/overlay.html`**

After the drawCanvas element (line 8), add:

```html
  <div id="textCursor" class="text-cursor hidden"></div>
```

- [ ] **Step 2: Add text cursor CSS to `renderer/overlay.css`**

At the end of the file, add:

```css
/* ── Text Tool ── */

.text-cursor {
  position: fixed;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 16px;
  font-weight: bold;
  color: #ff0000;
  pointer-events: none;
  z-index: 5;
  white-space: pre;
  text-shadow:
    -1px -1px 0 rgba(0,0,0,0.8),
     1px -1px 0 rgba(0,0,0,0.8),
    -1px  1px 0 rgba(0,0,0,0.8),
     1px  1px 0 rgba(0,0,0,0.8);
}

.text-cursor::after {
  content: '|';
  animation: blink 0.8s step-end infinite;
}

.text-cursor.hidden {
  display: none;
}

@keyframes blink {
  50% { opacity: 0; }
}
```

- [ ] **Step 3: Add text mode state and logic to `renderer/overlay.js`**

After the existing state variables (line 18), add:

```javascript
let isTextMode = false;
let textContent = '';
let textPosition = null;
const textCursor = document.getElementById('textCursor');
```

- [ ] **Step 4: Add text mode activation via click**

Replace the mousedown listener (lines 38-49) with a version that handles text mode:

```javascript
drawCanvas.addEventListener('mousedown', (e) => {
  if (isRegionMode) return;
  if (e.button === 2) {
    window.quickclip.exitDrawMode();
    return;
  }
  if (isTextMode) {
    // If already typing, commit current text first
    if (textContent) commitText();
    // Place cursor at click position
    textPosition = { x: e.clientX, y: e.clientY };
    textContent = '';
    textCursor.textContent = '';
    textCursor.style.left = e.clientX + 'px';
    textCursor.style.top = (e.clientY - 10) + 'px';
    textCursor.classList.remove('hidden');
    return;
  }
  isDrawing = true;
  hasDrawn = true;
  setPenStyle();
  drawCtx.beginPath();
  drawCtx.moveTo(e.clientX, e.clientY);
});
```

- [ ] **Step 5: Add `commitText()` and `cancelText()` functions**

After the mouse event listeners, add:

```javascript
function commitText() {
  if (!textContent || !textPosition) return;
  hasDrawn = true;
  drawCtx.font = 'bold 16px Consolas, Courier New, monospace';
  drawCtx.fillStyle = COLORS[activeColor] || COLORS.red;
  // Dark outline for readability
  drawCtx.strokeStyle = 'rgba(0,0,0,0.8)';
  drawCtx.lineWidth = 3;
  drawCtx.lineJoin = 'round';
  drawCtx.strokeText(textContent, textPosition.x, textPosition.y);
  drawCtx.fillText(textContent, textPosition.x, textPosition.y);
  // Reset
  textContent = '';
  textPosition = null;
  textCursor.classList.add('hidden');
  textCursor.textContent = '';
}

function cancelText() {
  textContent = '';
  textPosition = null;
  textCursor.classList.add('hidden');
  textCursor.textContent = '';
}

function setTextMode(enabled) {
  isTextMode = enabled;
  drawCanvas.style.cursor = enabled ? 'text' : 'crosshair';
  if (!enabled) cancelText();
}
```

- [ ] **Step 6: Update keyboard handler for text mode**

Replace the keydown listener (lines 67-85) with:

```javascript
document.addEventListener('keydown', (e) => {
  if (isRegionMode) {
    if (e.key === 'Escape') exitRegionMode();
    return;
  }

  // Text mode active and cursor placed — handle typing
  if (isTextMode && textPosition) {
    if (e.key === 'Enter') {
      commitText();
      setTextMode(false);
      window.quickclip.textModeExited();
      return;
    }
    if (e.key === 'Escape') {
      cancelText();
      setTextMode(false);
      window.quickclip.textModeExited();
      return;
    }
    if (e.key === 'Backspace') {
      textContent = textContent.slice(0, -1);
      textCursor.textContent = textContent;
      return;
    }
    // Single printable character
    if (e.key.length === 1) {
      textContent += e.key;
      textCursor.textContent = textContent;
      return;
    }
    return;
  }

  // Normal draw mode shortcuts
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
  } else if (e.key === 't' || e.key === 'T') {
    setTextMode(!isTextMode);
    window.quickclip.textModeChanged(isTextMode);
  }
});
```

- [ ] **Step 7: Update color change listener to update text cursor color**

After the existing `onColorChange` listener (line 89-91), update:

```javascript
window.quickclip.onColorChange((color) => {
  if (COLORS[color]) {
    activeColor = color;
    textCursor.style.color = COLORS[color];
  }
});
```

- [ ] **Step 8: Add text mode IPC listener from toolbar**

After the color change listener, add:

```javascript
window.quickclip.onTextModeToggle((enabled) => {
  setTextMode(enabled);
});
```

- [ ] **Step 9: Verify — open overlay in dev mode**

```bash
npm run dev
```

Open toolbar, enter draw mode, press `T`. Click on screen and type text. Press Enter to commit. Verify text renders in the active color on the canvas.

- [ ] **Step 10: Commit**

```bash
git add renderer/overlay.html renderer/overlay.js renderer/overlay.css
git commit -m "feat(overlay): add text annotation tool with colored on-screen typing"
```

---

## Task 5: Toolbar — Text Mode Button + IPC

**Files:**
- Modify: `renderer/toolbar.html:9-20`
- Modify: `renderer/toolbar.js:27-37`
- Modify: `renderer/toolbar.css:53-71`
- Modify: `src/main.js` (IPC for text mode)
- Modify: `src/preload.js` (text mode IPC)

- [ ] **Step 1: Add T button to `renderer/toolbar.html`**

In the toolbar div, after the pink color dot and before the HuminLoop button, add:

```html
      <button class="tb-btn text-btn" id="textBtn" title="Text tool (T)" onclick="toggleTextMode()">T</button>
```

- [ ] **Step 2: Add text mode toggle logic to `renderer/toolbar.js`**

After the `switchColor()` function, add:

```javascript
let textModeActive = false;

function toggleTextMode() {
  textModeActive = !textModeActive;
  document.getElementById('textBtn').classList.toggle('active', textModeActive);
  window.quickclip.toggleTextMode(textModeActive);
}

// Listen for text mode exit from overlay (Enter/Escape)
window.quickclip.onTextModeExited(() => {
  textModeActive = false;
  document.getElementById('textBtn').classList.remove('active');
});
```

- [ ] **Step 3: Add text button styling to `renderer/toolbar.css`**

After the color dot styles, add:

```css
.text-btn {
  width: 26px;
  height: 26px;
  border-radius: 4px;
  border: 1.5px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 13px;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.15s ease;
  margin-left: 4px;
}

.text-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.text-btn.active {
  background: var(--text);
  color: var(--bg);
  border-color: var(--text);
}
```

- [ ] **Step 4: Add text mode IPC to `src/preload.js`**

In the preload's `quickclip` object, add alongside the existing draw mode methods:

```javascript
toggleTextMode: (enabled) => ipcRenderer.send('toggle-text-mode', enabled),
onTextModeToggle: (cb) => ipcRenderer.on('text-mode-toggle', (_, enabled) => cb(enabled)),
textModeChanged: (enabled) => ipcRenderer.send('text-mode-changed', enabled),
onTextModeExited: (cb) => ipcRenderer.on('text-mode-exited', cb),
textModeExited: () => ipcRenderer.send('text-mode-exited'),
```

- [ ] **Step 5: Add text mode IPC handlers to `src/main.js`**

After the existing draw mode IPC handlers, add:

```javascript
// Text mode IPC — relay between toolbar and overlay
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
```

- [ ] **Step 6: Verify — toolbar text button**

```bash
npm run dev
```

Click "Show Toolbar" from tray. Verify the `T` button appears. Click it — should highlight. Enter draw mode, type text, press Enter. Verify `T` button deactivates when text is committed.

- [ ] **Step 7: Commit**

```bash
git add renderer/toolbar.html renderer/toolbar.js renderer/toolbar.css src/preload.js src/main.js
git commit -m "feat(toolbar): add text mode button with overlay IPC"
```

---

## Task 6: Main Process — Mode Switching & IPC

**Files:**
- Modify: `src/main.js:51-54,139-189,431-447,486-576`
- Modify: `src/preload.js`

- [ ] **Step 1: Add `source` to `ALLOWED_CLIP_FIELDS` in `src/main.js`**

At line 51-54, add `'source'` to the array:

```javascript
const ALLOWED_CLIP_FIELDS = [
  'category', 'tags', 'aiSummary', 'aiFixPrompt', 'url', 'status', 'comments', 'project_id', 'comment',
  'window_title', 'process_name', 'completed_at', 'archived', 'summarize_count', 'source',
];
```

- [ ] **Step 2: Add `require` for `workflow-context` at top of `main.js`**

Near the other requires at the top of `main.js`:

```javascript
const workflowContext = require('./workflow-context');
```

- [ ] **Step 3: Add `getAppMode()` helper function**

After `sanitizeUpdates()` (around line 105), add:

```javascript
async function getAppMode() {
  const settings = await db.getSettings();
  return (settings && settings.app_mode) || 'full';
}
```

- [ ] **Step 4: Modify `createMainWindow()` to check mode**

At line 139-158, update to load the correct HTML:

```javascript
async function createMainWindow() {
  const mode = await getAppMode();
  const htmlFile = mode === 'lite' ? 'lite-index.html' : 'index.html';
  const windowSize = mode === 'lite' ? { width: 450, height: 600 } : { width: 1100, height: 750 };

  mainWindow = new BrowserWindow({
    ...windowSize, show: false,
    title: mode === 'lite' ? 'HuminLoop Lite' : 'HuminLoop',
    backgroundColor: '#13131f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', htmlFile));
  if (process.env.HUMINLOOP_DEV === '1') mainWindow.webContents.openDevTools();
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}
```

Note: this changes `createMainWindow` from sync to async. Find all call sites and add `await` where needed (app.whenReady, tray click, etc.).

- [ ] **Step 5: Modify `createCaptureWindow()` to check mode**

At line 160-189, update the HTML file loaded:

```javascript
async function createCaptureWindow(imageDataURL, windowMeta = null) {
  const mode = await getAppMode();
  const htmlFile = mode === 'lite' ? 'lite-capture.html' : 'capture.html';
  const captureSize = mode === 'lite' ? { width: 340, height: 420 } : { width: 460, height: 580 };

  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.show();
    captureWindow.focus();
    captureWindow.webContents.focus();
    captureWindow.webContents.send('new-screenshot', imageDataURL, windowMeta);
    return;
  }
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  captureWindow = new BrowserWindow({
    ...captureSize,
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
```

- [ ] **Step 6: Add `toggle-app-mode` IPC handler**

After the existing settings handlers (around line 753), add:

```javascript
ipcMain.handle('toggle-app-mode', async () => {
  const current = await getAppMode();
  const next = current === 'lite' ? 'full' : 'lite';
  await db.saveSetting('app_mode', next);

  // Close and recreate main window with new mode
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
    mainWindow = null;
  }
  // Close capture window too — it needs to switch variant
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.destroy();
    captureWindow = null;
  }
  await createMainWindow();
  mainWindow.show();

  // Rebuild tray menu for new mode
  rebuildTrayMenu();

  return next;
});

ipcMain.handle('get-app-mode', async () => {
  return await getAppMode();
});
```

- [ ] **Step 7: Add `get-lite-clips` IPC handler**

After the existing `get-clips` handlers (line 535-537), add:

```javascript
ipcMain.handle('get-lite-clips', () => db.getClips(undefined, 'lite'));
```

- [ ] **Step 8: Modify `save-clip` handler to inject source in lite mode**

At line 539-576, after the initial validation and before image saving, add:

```javascript
// Inject source based on app mode
const mode = await getAppMode();
if (mode === 'lite') {
  clip.source = 'lite';
  // Auto-assign to active project if set
  const settings = await db.getSettings();
  if (settings.lite_active_project && !clip.project_id) {
    clip.project_id = settings.lite_active_project;
  }
}
```

- [ ] **Step 9: Add lite-specific autoCategorize path**

After the existing `autoCategorize()` function (around line 531), add a new function:

```javascript
async function autoCategorizeLite(clipId, comment, imageData, windowTitle, processName) {
  try {
    const settings = await db.getSettings();
    const projectId = settings.lite_active_project;
    const project = projectId ? await db.getProject(projectId) : {};

    // Read workflow context from project repo
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
      console.log(`[HuminLoop] Lite prompt generated for clip ${clipId}`);
      addAuditEntry('ai', `Lite prompt generated for clip ${clipId}`);
    }
  } catch (e) {
    console.error('[HuminLoop] Lite prompt generation failed:', e.message);
  }
}
```

- [ ] **Step 10: Update the save-clip AI trigger to route lite clips differently**

In the save-clip handler (around lines 568-574), change the AI trigger section:

```javascript
if ((clip.comment || imageData) && ai.isEnabled()) {
  const aiMode = await getAppMode();
  if (aiMode === 'lite') {
    console.log(`[HuminLoop] Starting lite prompt generation for: "${(clip.comment || '(screenshot only)').slice(0, 30)}"`);
    autoCategorizeLite(clip.id, clip.comment || '', imageData, clip.window_title, clip.process_name)
      .catch(e => console.error('[HuminLoop] Lite prompt background error:', e.message));
  } else {
    console.log(`[HuminLoop] Starting AI categorization for: "${(clip.comment || '(screenshot only)').slice(0, 30)}"`);
    autoCategorize(clip.id, clip.comment || '', imageData, clip.window_title, clip.process_name)
      .catch(e => console.error('[HuminLoop] Auto-categorize background error:', e.message));
  }
}
```

- [ ] **Step 11: Add `set-lite-active-project` IPC handler**

```javascript
ipcMain.handle('set-lite-active-project', async (_, projectId) => {
  await db.saveSetting('lite_active_project', projectId);
  return true;
});
```

- [ ] **Step 12: Extract tray menu to `rebuildTrayMenu()` function**

Refactor `createTray()` at lines 431-447. Extract the menu template into a separate function:

```javascript
function rebuildTrayMenu() {
  if (!tray) return;
  getAppMode().then(mode => {
    const modeLabel = mode === 'lite' ? 'Switch to Full Mode' : 'Switch to Lite Mode';
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open HuminLoop', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { label: 'Quick Capture', click: () => createCaptureWindow(null) },
      { label: 'Show Toolbar', click: () => createToolbarWindow() },
      { type: 'separator' },
      { label: modeLabel, click: async () => {
        const newMode = await ipcMain.emit('toggle-app-mode'); // or call directly
        // Handler already rebuilds the menu
      }},
      { label: 'Pause Watcher', type: 'checkbox', checked: false, click: (item) => {
        watcherPaused = item.checked;
      }},
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]));
  });
}
```

Actually, since `ipcMain.emit` won't work for handles, call the logic directly:

```javascript
function rebuildTrayMenu() {
  if (!tray) return;
  getAppMode().then(mode => {
    const modeLabel = mode === 'lite' ? 'Switch to Full Mode' : 'Switch to Lite Mode';
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open HuminLoop', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { label: 'Quick Capture', click: () => createCaptureWindow(null) },
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
      { label: 'Pause Watcher', type: 'checkbox', checked: watcherPaused, click: (item) => {
        watcherPaused = item.checked;
      }},
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]));
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(FALLBACK_TRAY_ICON);
  tray = new Tray(icon);
  tray.setToolTip('HuminLoop');
  rebuildTrayMenu();
  tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}
```

- [ ] **Step 13: Add new IPC methods to `src/preload.js`**

In the preload's quickclip object, add:

```javascript
// App mode
toggleAppMode: () => ipcRenderer.invoke('toggle-app-mode'),
getAppMode: () => ipcRenderer.invoke('get-app-mode'),

// Lite mode
getLiteClips: () => ipcRenderer.invoke('get-lite-clips'),
setLiteActiveProject: (projectId) => ipcRenderer.invoke('set-lite-active-project', projectId),
```

- [ ] **Step 14: Verify — mode switching works**

```bash
npm run dev
```

Open DevTools console, run:
```javascript
await window.quickclip.toggleAppMode()
```

Should return `'lite'`. Window should close and reopen (it will fail to load `lite-index.html` since we haven't created it yet — that's expected). Toggle back:
```javascript
await window.quickclip.toggleAppMode()
```

Should return `'full'` and restore normal window. Verify tray menu now shows "Switch to Lite Mode".

- [ ] **Step 15: Commit**

```bash
git add src/main.js src/preload.js
git commit -m "feat(main): add app mode switching, lite IPC handlers, and tray menu toggle"
```

---

## Task 7: Lite Capture Popup

**Files:**
- Create: `renderer/lite-capture.html`
- Create: `renderer/lite-capture.js`
- Create: `renderer/lite-capture.css`

- [ ] **Step 1: Create `renderer/lite-capture.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';">
  <link rel="stylesheet" href="lite-capture.css">
</head>
<body>
  <div class="capture-window">
    <div class="header">
      <span class="title">Quick Capture</span>
      <button class="close-btn" onclick="window.quickclip.closeCapture()">&times;</button>
    </div>

    <div class="image-wrap">
      <div id="placeholder" class="placeholder">No screenshot</div>
      <img id="ssImg" class="screenshot" style="display:none;">
    </div>

    <div class="note-wrap">
      <textarea id="noteInput" class="note-input" placeholder="What needs to change?" rows="3"></textarea>
    </div>

    <button id="saveBtn" class="save-btn" disabled onclick="save()">Save &amp; Generate Prompt</button>
  </div>

  <script src="lite-capture.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `renderer/lite-capture.js`**

```javascript
// renderer/lite-capture.js — Lite mode capture popup

let screenshotData = null;
let windowMeta = null;

// ── Screenshot listener ──

window.quickclip.onScreenshot((dataURL, meta) => {
  screenshotData = dataURL;
  windowMeta = meta || {};
  const img = document.getElementById('ssImg');
  const placeholder = document.getElementById('placeholder');
  if (dataURL) {
    img.src = dataURL;
    img.style.display = 'block';
    placeholder.style.display = 'none';
  }
  updateSaveBtn();
  document.getElementById('noteInput').focus();
});

// ── Save ──

async function save() {
  const comment = document.getElementById('noteInput').value.trim();
  if (!screenshotData && !comment) return;

  const clip = {
    id: Date.now().toString(),
    image: screenshotData,
    comment,
    category: 'Uncategorized',
    project_id: null, // main process injects from lite_active_project setting
    tags: '',
    aiSummary: '',
    status: 'parked',
    timestamp: Date.now(),
    window_title: windowMeta?.title || null,
    process_name: windowMeta?.process || null,
    // source is injected by main process based on app_mode
  };

  document.getElementById('saveBtn').disabled = true;
  document.getElementById('saveBtn').textContent = 'Saving...';

  await window.quickclip.saveClip(clip);
  window.quickclip.closeCapture();
}

// ── UI helpers ──

function updateSaveBtn() {
  const hasContent = screenshotData || document.getElementById('noteInput').value.trim();
  document.getElementById('saveBtn').disabled = !hasContent;
}

document.getElementById('noteInput').addEventListener('input', updateSaveBtn);

// Enter to save, Escape to close
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!document.getElementById('saveBtn').disabled) save();
  } else if (e.key === 'Escape') {
    window.quickclip.closeCapture();
  }
});
```

- [ ] **Step 3: Create `renderer/lite-capture.css`**

```css
/* renderer/lite-capture.css — Lite capture popup styles */

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #1e1e2e;
  --bg-surface: #13131f;
  --border: #2a2a4a;
  --text: #e0e0e0;
  --text-dim: #888;
  --accent: #4fc3f7;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text);
  -webkit-app-region: drag;
  user-select: none;
  overflow: hidden;
}

.capture-window {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 12px;
  gap: 10px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.close-btn {
  -webkit-app-region: no-drag;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 18px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.close-btn:hover {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}

.image-wrap {
  flex: 1;
  min-height: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.placeholder {
  color: var(--text-dim);
  font-size: 12px;
}

.screenshot {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.note-wrap {
  -webkit-app-region: no-drag;
}

.note-input {
  width: 100%;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 12px;
  padding: 8px;
  resize: none;
  font-family: inherit;
}

.note-input:focus {
  outline: none;
  border-color: var(--accent);
}

.note-input::placeholder {
  color: var(--text-dim);
}

.save-btn {
  -webkit-app-region: no-drag;
  background: var(--accent);
  color: #000;
  border: none;
  border-radius: 6px;
  padding: 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.save-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.save-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

- [ ] **Step 4: Verify — switch to lite mode and capture**

```bash
npm run dev
```

Toggle to lite mode via DevTools: `await window.quickclip.toggleAppMode()`. Then trigger a capture (hotkey or tray). Verify the lite capture popup opens with the minimal UI. Type a note, verify "Save & Generate Prompt" button enables. Press Enter or click save. Verify clip is saved and popup closes.

- [ ] **Step 5: Commit**

```bash
git add renderer/lite-capture.html renderer/lite-capture.js renderer/lite-capture.css
git commit -m "feat: add lite capture popup with minimal screenshot + note + save UI"
```

---

## Task 8: Lite Main Window

**Files:**
- Create: `renderer/lite-index.html`
- Create: `renderer/lite-index.js`
- Create: `renderer/lite-index.css`

- [ ] **Step 1: Create `renderer/lite-index.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';">
  <link rel="stylesheet" href="lite-index.css">
</head>
<body>
  <div class="lite-app">
    <!-- Title bar -->
    <div class="titlebar">
      <div class="titlebar-left">
        <span class="app-name">HuminLoop Lite</span>
        <select id="projectSelect" class="project-select">
          <option value="">Select project...</option>
        </select>
      </div>
      <div class="titlebar-right">
        <span id="clipPosition" class="clip-position"></span>
        <button class="gear-btn" onclick="openSettings()" title="Settings">&#x2699;</button>
      </div>
    </div>

    <!-- Clip card -->
    <div id="clipCard" class="clip-card">
      <!-- Screenshot -->
      <div class="screenshot-wrap">
        <img id="clipImage" class="clip-image" style="display:none;">
        <div id="emptyState" class="empty-state">
          <div class="empty-title">Take a screenshot to get started</div>
          <div class="empty-hint">Ctrl+Shift+Q or use the toolbar</div>
        </div>
      </div>

      <!-- Note -->
      <div id="noteSection" class="note-section" style="display:none;">
        <div class="section-label">Note</div>
        <div id="clipNote" class="clip-note"></div>
      </div>

      <!-- Generated Prompt -->
      <div id="promptSection" class="prompt-section" style="display:none;">
        <div class="prompt-header">
          <span class="section-label prompt-label">Generated Prompt</span>
          <button id="copyBtn" class="copy-btn" onclick="copyPrompt()">Copy</button>
        </div>
        <div id="promptContent" class="prompt-content"></div>
      </div>

      <!-- Loading state -->
      <div id="promptLoading" class="prompt-loading" style="display:none;">
        <div class="spinner"></div>
        <span>Generating prompt...</span>
      </div>
    </div>

    <!-- Navigation -->
    <div class="nav-bar">
      <button class="nav-btn" id="prevBtn" onclick="navigate(-1)" disabled>&#x25C0;</button>
      <span id="navCounter" class="nav-counter"></span>
      <button class="nav-btn" id="nextBtn" onclick="navigate(1)" disabled>&#x25B6;</button>
    </div>

    <!-- Project picker overlay (shown on first launch if no project set) -->
    <div id="projectOverlay" class="project-overlay" style="display:none;">
      <div class="overlay-content">
        <h3>Choose your active project</h3>
        <p class="overlay-hint">Lite mode focuses on one project at a time. All captures and AI prompts will use this project's context.</p>
        <div id="projectList" class="project-list"></div>
        <button class="overlay-btn" onclick="createNewProject()">+ New Project</button>
      </div>
    </div>
  </div>

  <script src="lite-index.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `renderer/lite-index.js`**

```javascript
// renderer/lite-index.js — Lite mode main window

let clips = [];
let currentIndex = 0;
let activeProjectId = null;

// ── Init ──

(async () => {
  const settings = await window.quickclip.getSettings();
  activeProjectId = settings.lite_active_project || null;

  await loadProjects();

  if (!activeProjectId) {
    document.getElementById('projectOverlay').style.display = 'flex';
  } else {
    await loadClips();
  }
})();

// ── Projects ──

async function loadProjects() {
  const projects = await window.quickclip.getProjects();
  const select = document.getElementById('projectSelect');

  // Clear existing options (keep first placeholder)
  while (select.options.length > 1) select.remove(1);

  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === activeProjectId) opt.selected = true;
    select.appendChild(opt);
  }

  // Also populate the overlay list for first-launch
  const list = document.getElementById('projectList');
  list.innerHTML = '';
  for (const p of projects) {
    const btn = document.createElement('button');
    btn.className = 'project-item';
    btn.innerHTML = `<span class="project-dot" style="background:${esc(p.color)}"></span>${esc(p.name)}`;
    btn.onclick = () => selectProject(p.id);
    list.appendChild(btn);
  }
}

document.getElementById('projectSelect').addEventListener('change', async (e) => {
  const id = parseInt(e.target.value, 10);
  if (id) await selectProject(id);
});

async function selectProject(projectId) {
  activeProjectId = projectId;
  await window.quickclip.setLiteActiveProject(projectId);
  document.getElementById('projectOverlay').style.display = 'none';

  // Update dropdown
  const select = document.getElementById('projectSelect');
  for (const opt of select.options) {
    opt.selected = parseInt(opt.value, 10) === projectId;
  }

  await loadClips();
}

async function createNewProject() {
  const name = prompt('Project name:');
  if (!name || !name.trim()) return;
  const project = await window.quickclip.createProject({ name: name.trim() });
  if (project) {
    await loadProjects();
    await selectProject(project.id);
  }
}

// ── Clips ──

async function loadClips() {
  clips = await window.quickclip.getLiteClips();
  // Sort newest first
  clips.sort((a, b) => b.timestamp - a.timestamp);
  currentIndex = 0;
  renderCurrentClip();
}

function renderCurrentClip() {
  const card = document.getElementById('clipCard');
  const empty = document.getElementById('emptyState');
  const img = document.getElementById('clipImage');
  const noteSection = document.getElementById('noteSection');
  const promptSection = document.getElementById('promptSection');
  const promptLoading = document.getElementById('promptLoading');
  const position = document.getElementById('clipPosition');
  const counter = document.getElementById('navCounter');

  if (clips.length === 0) {
    empty.style.display = 'flex';
    img.style.display = 'none';
    noteSection.style.display = 'none';
    promptSection.style.display = 'none';
    promptLoading.style.display = 'none';
    position.textContent = '';
    counter.textContent = '';
    document.getElementById('prevBtn').disabled = true;
    document.getElementById('nextBtn').disabled = true;
    return;
  }

  const clip = clips[currentIndex];
  empty.style.display = 'none';

  // Screenshot
  if (clip.image && clip.image !== '__on_disk__') {
    img.src = clip.image;
    img.style.display = 'block';
  } else if (clip.image === '__on_disk__') {
    // Load from disk via IPC
    window.quickclip.getClipImage(clip.id).then(dataUrl => {
      if (dataUrl) {
        img.src = dataUrl;
        img.style.display = 'block';
      }
    });
  } else {
    img.style.display = 'none';
  }

  // Note
  if (clip.comment) {
    document.getElementById('clipNote').textContent = clip.comment;
    noteSection.style.display = 'block';
  } else {
    noteSection.style.display = 'none';
  }

  // Prompt
  if (clip.aiFixPrompt) {
    document.getElementById('promptContent').textContent = clip.aiFixPrompt;
    promptSection.style.display = 'block';
    promptLoading.style.display = 'none';
  } else if (clip.comment || clip.image) {
    // Prompt not yet generated — show loading
    promptSection.style.display = 'none';
    promptLoading.style.display = 'flex';
  } else {
    promptSection.style.display = 'none';
    promptLoading.style.display = 'none';
  }

  // Navigation
  const num = currentIndex + 1;
  const total = clips.length;
  position.textContent = `${num} of ${total}`;
  counter.textContent = `${num} / ${total}`;
  document.getElementById('prevBtn').disabled = currentIndex >= clips.length - 1;
  document.getElementById('nextBtn').disabled = currentIndex <= 0;
}

function navigate(delta) {
  // delta: -1 = older (higher index), +1 = newer (lower index)
  const newIndex = currentIndex - delta;
  if (newIndex >= 0 && newIndex < clips.length) {
    currentIndex = newIndex;
    renderCurrentClip();
  }
}

async function copyPrompt() {
  const clip = clips[currentIndex];
  if (!clip) return;
  const text = clip.aiFixPrompt || clip.comment || '';
  await navigator.clipboard.writeText(text);
  const btn = document.getElementById('copyBtn');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

function openSettings() {
  // Switch back to full mode for settings access
  window.quickclip.toggleAppMode();
}

// ── Live updates ──

window.quickclip.onClipsChanged(async () => {
  const prevId = clips[currentIndex]?.id;
  await loadClips();
  // Try to stay on the same clip
  if (prevId) {
    const idx = clips.findIndex(c => c.id === prevId);
    if (idx >= 0) currentIndex = idx;
  }
  renderCurrentClip();
});

window.quickclip.onScreenshot(() => {
  // New screenshot coming — will trigger clips-changed after save
});

// ── Keyboard nav ──

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') navigate(-1);
  else if (e.key === 'ArrowRight') navigate(1);
  else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) copyPrompt();
});

// ── Escape helper ──

function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
```

- [ ] **Step 3: Create `renderer/lite-index.css`**

```css
/* renderer/lite-index.css — Lite mode main window styles */

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #13131f;
  --bg-surface: #1a1a2e;
  --bg-input: #0f1129;
  --border: #2a2a4a;
  --text: #e0e0e0;
  --text-dim: #888;
  --accent: #4fc3f7;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
  height: 100vh;
}

.lite-app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* ── Title bar ── */

.titlebar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #16213e;
  -webkit-app-region: drag;
  flex-shrink: 0;
}

.titlebar-left, .titlebar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.app-name {
  font-size: 13px;
  font-weight: 600;
}

.project-select {
  -webkit-app-region: no-drag;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 11px;
  cursor: pointer;
  max-width: 150px;
}

.clip-position {
  font-size: 11px;
  color: var(--text-dim);
}

.gear-btn {
  -webkit-app-region: no-drag;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}

.gear-btn:hover {
  background: rgba(255,255,255,0.1);
}

/* ── Clip card ── */

.clip-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 8px;
  overflow-y: auto;
  min-height: 0;
}

.screenshot-wrap {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  max-height: 280px;
  overflow: hidden;
}

.clip-image {
  max-width: 100%;
  max-height: 280px;
  object-fit: contain;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 40px;
}

.empty-title {
  color: var(--text-dim);
  font-size: 13px;
}

.empty-hint {
  color: var(--text-dim);
  font-size: 11px;
  opacity: 0.7;
}

/* ── Note ── */

.note-section {
  padding: 0;
}

.section-label {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 4px;
  letter-spacing: 0.5px;
}

.clip-note {
  font-size: 12px;
  color: #ccc;
  padding: 6px 8px;
  background: var(--bg-input);
  border-radius: 4px;
  line-height: 1.4;
}

/* ── Prompt ── */

.prompt-section {
  padding: 0;
}

.prompt-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.prompt-label {
  color: var(--accent);
  font-weight: 600;
}

.copy-btn {
  background: var(--accent);
  color: #000;
  border: none;
  border-radius: 3px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.copy-btn:hover {
  opacity: 0.85;
}

.prompt-content {
  font-size: 12px;
  padding: 10px;
  background: var(--bg-input);
  border-radius: 6px;
  border-left: 3px solid var(--accent);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.prompt-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  color: var(--text-dim);
  font-size: 12px;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top: 2px solid var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Navigation ── */

.nav-bar {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 8px 12px 12px;
  flex-shrink: 0;
}

.nav-btn {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.nav-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}

.nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.nav-counter {
  font-size: 11px;
  color: var(--text-dim);
}

/* ── Project overlay ── */

.project-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.overlay-content {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 24px;
  width: 320px;
  text-align: center;
}

.overlay-content h3 {
  font-size: 15px;
  margin-bottom: 8px;
}

.overlay-hint {
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 16px;
  line-height: 1.4;
}

.project-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  max-height: 200px;
  overflow-y: auto;
}

.project-item {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.project-item:hover {
  border-color: var(--accent);
}

.project-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.overlay-btn {
  background: var(--accent);
  color: #000;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  width: 100%;
}

.overlay-btn:hover {
  opacity: 0.9;
}
```

- [ ] **Step 4: Verify — full lite mode flow**

```bash
npm run dev
```

Switch to lite mode via tray or DevTools. Verify:
1. Project picker overlay appears (if no project selected)
2. Select a project — overlay dismisses
3. Take a screenshot — lite capture popup opens
4. Type a note, click "Save & Generate Prompt"
5. Lite main window updates — shows screenshot, note, loading spinner
6. If AI enabled: prompt appears after a few seconds
7. Click "Copy" — copies prompt to clipboard
8. Arrow keys or nav buttons move between clips

- [ ] **Step 5: Commit**

```bash
git add renderer/lite-index.html renderer/lite-index.js renderer/lite-index.css
git commit -m "feat: add lite main window with single-card view, prompt display, and project picker"
```

---

## Task 9: Integration Verification & Polish

**Files:**
- Modify: various (minor fixes based on testing)

- [ ] **Step 1: Test full→lite→full round trip**

```bash
npm run dev
```

1. Start in full mode. Create a clip. Verify it has `source: 'full'`.
2. Switch to lite mode via tray. Verify main window changes.
3. Set an active project. Take a screenshot with annotations (use toolbar + draw mode).
4. Add a note in lite capture popup. Save.
5. Verify clip appears in lite main window with `source: 'lite'`.
6. Wait for AI prompt generation (if AI enabled).
7. Copy the prompt. Verify it includes project context.
8. Switch back to full mode. Verify the lite clip appears in full mode's clip list.
9. Verify full mode's existing clips still have `source: 'full'`.

- [ ] **Step 2: Test text tool**

1. Open toolbar, click `T` button.
2. Click on overlay — text cursor appears.
3. Type "remove this" — text appears in active color.
4. Press Enter — text commits to canvas.
5. Change color to green, press `T`, click elsewhere, type "add here".
6. Press Enter. Take snippet. Verify annotations appear in capture.

- [ ] **Step 3: Test edge cases**

1. Switch to lite mode with no projects — verify overlay prompts to create one.
2. Save a clip with no note (screenshot only) — verify it still works.
3. Save a clip with no screenshot (note only) — verify it still works.
4. Navigate with 0 clips — verify empty state shows.
5. Navigate with 1 clip — verify prev/next are disabled.
6. Close and reopen app — verify mode persists.

- [ ] **Step 4: Fix any issues found during testing**

Address any bugs or visual issues discovered in steps 1-3.

- [ ] **Step 5: Final commit**

```bash
git add -u
git commit -m "fix: integration polish for lite mode after testing"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | DB: `source` column | db-pg, db-sqlite, init.sql |
| 2 | Workflow context reader | new: workflow-context.js |
| 3 | AI: lite prompt generation | ai.js |
| 4 | Overlay: text tool | overlay.html/js/css |
| 5 | Toolbar: T button + IPC | toolbar.html/js/css, main.js, preload.js |
| 6 | Main process: mode switching | main.js, preload.js |
| 7 | Lite capture popup | new: lite-capture.html/js/css |
| 8 | Lite main window | new: lite-index.html/js/css |
| 9 | Integration testing | various |
