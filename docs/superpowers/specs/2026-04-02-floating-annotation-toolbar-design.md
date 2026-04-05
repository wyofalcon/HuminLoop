# Floating Annotation Toolbar — Design Spec

**Date:** 2026-04-02
**Status:** Approved
**Scope:** New feature — floating toolbar with screen drawing and snippet capture

## Summary

A floating always-on-top toolbar that gives users ZoomIT-like screen annotation and snippet capture without requiring PowerToys. Two new Electron windows: a compact draggable toolbar and a fullscreen transparent drawing overlay.

## Requirements

- Floating toolbar, always on top, draggable, can be minimized to a small pill icon or closed
- 3 color pen buttons (Red, Green, Pink/Purple) matching ZoomIT annotation colors
- Freehand drawing on a transparent fullscreen overlay above all other windows
- Region-select snippet capture that composites annotations onto the screenshot
- Captured snippet is sent directly to Sciurus as a new clip (via existing save-clip flow)
- Button to open/focus the main Sciurus window
- Displays the current workflow project name
- Launches on app start alongside the tray icon

## Architecture: Separate Electron Windows

### Toolbar Window

Small frameless `BrowserWindow`, always-on-top, draggable.

**Window properties:**
- `frame: false`
- `alwaysOnTop: true`
- `skipTaskbar: true`
- `resizable: false`
- Size: ~450x44px
- Transparent background with rounded dark bar

**Layout (left to right):**

| Element | Behavior |
|---------|----------|
| Drag handle | `-webkit-app-region: drag` zone |
| Project name | Current workflow project name (dim "No project" if none) |
| Red dot | Enters draw mode with red pen |
| Green dot | Enters draw mode with green pen |
| Pink dot | Enters draw mode with pink/purple pen |
| "Sciurus" button | Opens/focuses the main window |
| "Capture" button | Enters snippet region-select mode directly (no drawing) |
| Minimize (−) | Collapses toolbar to a small floating pill icon. Click pill to restore |
| Close (x) | Hides the toolbar (reopenable from tray menu) |

**Minimized state:** Collapses to a small floating pill/icon. Clicking it restores the full toolbar.

### Draw Overlay Window

Fullscreen frameless transparent `BrowserWindow`, created on demand when a color button is clicked, destroyed on exit.

**Window properties:**
- `fullscreen: true`
- `frame: false`
- `transparent: true`
- `alwaysOnTop: true` (higher z-level than toolbar)
- `skipTaskbar: true`

**Drawing behavior:**
- Full-viewport `<canvas>` element with transparent background — desktop visible through it
- Freehand pen drawing via mouse events (`mousedown` starts stroke, `mousemove` draws, `mouseup` ends)
- Pen style: 3px line width, round line caps, smooth joining
- Color determined by which toolbar button was clicked

**Color switching during draw mode:**
- Keyboard shortcuts: `1` = Red, `2` = Green, `3` = Pink
- Toolbar color buttons also work (IPC message updates overlay color)

**Exiting draw mode:**
- `Esc` key or right-click — destroys the overlay, annotations disappear

**Triggering capture from draw mode:**
- `S` key or clicking "Capture" on toolbar — transitions to region-select with annotations preserved

### Snippet Capture Flow

1. User triggers capture (toolbar "Capture" button, or `S` key during draw mode)
2. `desktopCapturer.getSources({ types: ['screen'] })` grabs the full screen as a `NativeImage` — captures desktop but NOT the overlay canvas
3. If annotations exist on the canvas, composite them: draw the screenshot onto an offscreen canvas, then draw the annotation canvas on top
4. Overlay switches to region-select mode — screen image displayed with dark scrim, user drags a rectangle to define crop area
5. Cropped result sent directly to Sciurus via IPC (`snippet-captured` with image data URL)
6. Main process receives snippet, creates capture popup with the image (same as clipboard-detected screenshot flow)
7. Overlay closes

**Why direct IPC instead of clipboard watcher:** Avoids race conditions and preserves window metadata captured before the overlay opened.

## File Structure

### New Files

| File | Purpose |
|------|---------|
| `renderer/toolbar.html` | Toolbar window markup |
| `renderer/toolbar.css` | Toolbar styling |
| `renderer/toolbar.js` | Toolbar logic, IPC calls |
| `renderer/overlay.html` | Draw overlay + region select markup |
| `renderer/overlay.css` | Overlay/canvas styling |
| `renderer/overlay.js` | Canvas drawing, region select, compositing |

### Modified Files

| File | Changes |
|------|---------|
| `src/main.js` | `createToolbarWindow()`, `createOverlayWindow()`. IPC handlers for draw-mode, color switch, snippet capture, get-project-name. Toolbar launches on app start. "Show Toolbar" added to tray menu |
| `src/preload.js` | New methods exposed on `window.quickclip` (available to all windows via same preload): `enterDrawMode(color)`, `exitDrawMode()`, `takeSnippet()`, `getToolbarProject()`, `showMain()`, `minimizeToolbar()`, `restoreToolbar()`. New event listeners: `onColorChange(cb)`, `onEnterRegionSelect(cb)`, `onDrawModeExited(cb)` |

## IPC Design

**Toolbar to Main:**
- `enter-draw-mode` — with color string (`red`, `green`, `pink`)
- `exit-draw-mode` — close overlay
- `take-snippet` — initiate capture
- `show-main` — open/focus main window
- `get-toolbar-project` — returns current workflow project name
- `minimize-toolbar` / `restore-toolbar` — toggle minimized state

**Main to Overlay:**
- `set-color` — change active pen color
- `enter-region-select` — transition from drawing to snippet selection

**Overlay to Main:**
- `snippet-captured` — image data URL of the composited, cropped screenshot
- `draw-mode-exited` — user pressed Esc or right-clicked

**Main on snippet received:**
- Captures window metadata (from before overlay opened)
- Creates capture popup with the image, same as existing clipboard-detected flow
- User adds note, category, project in the capture popup as usual

## Colors

| Button | Hex | Meaning (per ZoomIT convention) |
|--------|-----|------|
| Red | `#ff0000` | Delete / remove / error |
| Green | `#00ff00` | Add / insert |
| Pink | `#ff69b4` | Identify / reference / question |

## Keyboard Shortcuts (Draw Mode)

| Key | Action |
|-----|--------|
| `1` | Switch to Red |
| `2` | Switch to Green |
| `3` | Switch to Pink |
| `S` | Take snippet (enter region select) |
| `Esc` | Exit draw mode |
| Right-click | Exit draw mode |

## Edge Cases

- **Multi-monitor:** `desktopCapturer` captures the primary display. v1 targets single-monitor; multi-monitor is a future enhancement.
- **Toolbar hidden behind fullscreen apps:** `alwaysOnTop` with `'screen-saver'` level if standard level is insufficient.
- **Overlay click-through:** The overlay must NOT be click-through — it intercepts all mouse input for drawing. The desktop is frozen visually (user sees it but can't interact).
- **Rapid color switching:** No debounce needed — just update the stroke color for the next `mousedown`.
- **Empty capture (no region selected):** If user presses Esc during region select, cancel and return to draw mode (or close if there were no annotations).
- **Toolbar position persistence:** Save last toolbar position to settings so it restores on next launch.
