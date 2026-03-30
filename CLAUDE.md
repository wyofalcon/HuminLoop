# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Pre-Feature Audit

Before implementing any new feature or significant code change, launch a Haiku subagent (model: haiku) to audit the codebase for:
- Duplicated functions or near-identical logic
- Dead code (unused functions, unreachable branches, orphaned imports)
- Redundant tools or utilities that overlap in purpose
- Inconsistent patterns (e.g., two different ways of doing the same thing)

The audit agent should report findings concisely. If duplicates or dead code are found, address them as part of the implementation rather than adding more redundancy.

## Project Overview

Sciurus — an ADHD-friendly Electron app for AI-powered knowledge capture. Screenshot → note → AI categorization. Designed for developers using AI-assisted coding tools who need rapid issue capture without breaking flow.

## Commands

```bash
npm start          # Launch app (uses scripts/launch.js)
npm run dev        # Launch with DevTools auto-open (SCIURUS_DEV=1)
npm run build:win  # Windows NSIS installer → dist/
npm run build:linux # Linux AppImage + deb → dist/
npm run build:mac  # macOS .dmg → dist/
npm run pack       # Test build without creating installer
```

**Docker (PostgreSQL):**
```bash
docker compose up -d   # Start PostgreSQL 16 on port 5433
docker compose down    # Stop
```

No test suite exists. Dev testing is done via `npm run dev` + DevTools console.

## Architecture

```
Renderer (3 windows)          Main Process (src/main.js)
  index.html  — notes viewer     ├─ Tray + backup hotkey (Ctrl+Shift+Q)
  capture.html — screenshot popup │─ Clipboard watcher (1s poll)
  setup.html  — first-run wizard  │─ Window metadata capture
         ↕ IPC (preload.js)       │─ IPC handlers + event emitters
                                   │─ Background AI tasks
                                   ↓
                              Module Layer
                                db.js → db-pg.js | db-sqlite.js
                                ai.js → Gemini 2.5 Flash (Vertex or API key)
                                rules.js → 7-strategy categorization chain
                                window-info.js → Win32/xdotool/gdbus
                                images.js → disk storage + compression
```

### Key Data Flow

1. User takes screenshot (Windows Snipping Tool `Ctrl+Win+S` or any clipboard screenshot) → clipboard watcher detects new image → window metadata grabbed
2. Capture popup opens → user adds note → clip saved to DB, image to disk
3. Rules engine categorizes synchronously (7 strategies in priority order)
4. AI enriches asynchronously (summary, tags, URL extraction, fix prompts)
5. Main window updates via IPC event

### IPC Pattern

All renderer↔main communication goes through `preload.js` which exposes `window.quickclip.*` (60+ methods). Context isolation is enforced — no `nodeIntegration`.

- **`ipcMain.handle` / `ipcRenderer.invoke`** — used for all request/response calls (clips, projects, settings, AI)
- **`ipcMain.on` / `ipcRenderer.send`** — used for fire-and-forget window controls (`close-capture`, `hide-main`, `open-capture`)
- **`webContents.send`** — main→renderer push events (`clips-changed`, `projects-changed`, `new-screenshot`)

### Database Layer

`db.js` is a backend switcher that delegates to `db-pg.js` (PostgreSQL) or `db-sqlite.js` (better-sqlite3). Auto-detects PostgreSQL availability, falls back to SQLite. Both implementations expose the same API surface.

- **PostgreSQL:** Docker container, port 5433, schema in `docker/init.sql`
- **SQLite:** `{userData}/sciurus.db`, WAL mode
- **Images:** Stored on disk at `{userData}/images/{clipId}.png`, DB stores `__on_disk__` flag
- **DB_BACKEND** env var: `pg`, `sqlite`, or `auto` (default — tries pg first, falls back to sqlite)

When adding new DB operations, implement in both `db-pg.js` and `db-sqlite.js`, then expose through `db.js`'s delegation pattern.

### AI Module (`src/ai.js`)

- Gemini 2.5 Flash via Google AI API key or Vertex AI (native JWT, no googleapis SDK)
- 8 toggleable instruction blocks for categorization prompts (stored in DB settings as `prompt_blocks`)
- 30-second abort on all API calls
- Cached Vertex AI access tokens with 60s refresh buffer
- Image compression: max 800px width, JPEG for AI payloads (~70% reduction)

### Rules Engine (`src/rules.js`)

Priority chain: manual selection → repo path auto-match → user window rules → process map → title keywords → comment keywords → AI fallback. 5-minute in-memory cache for projects/rules/categories. Call `rules.invalidateCache()` when projects or window rules change.

### Categorization Chain

Rules run first (instant). If AI is enabled, it runs async in background — enriches clip with summary, tags, URL, project match. AI can override category only if rules left it as "Uncategorized".

### Clip Lifecycle

- **Create:** save-clip → rules categorize → AI enriches async → `clips-changed` event
- **Complete:** sets `completed_at`, optionally trashes (archive = soft delete via `deleted_at`)
- **Trash:** soft-delete sets `deleted_at`, restorable; auto-purge after 30 days on app launch
- **Permanent delete:** removes from DB + deletes image from disk
- **AI retrigger:** re-runs AI categorization on a single clip; also auto-fires when comment/thread edited

### Renderer Notes

`renderer/index.js` is a large single-file (~2000 lines) that drives the main notes viewer. It manages tabs (General Notes, Projects, Settings), filtering, sorting, and all UI rendering via DOM manipulation (no framework). HTML escaping uses `esc()` and `escAttr()` helpers — always use these for user content.

### Audit Ledger

In-memory array (max 200 entries) persisted to DB settings key `audit_log`. Tracks clip create/update/delete/AI actions. Use `addAuditEntry(action, detail)` in main.js when adding new operations.

## Key Conventions

- No npm deps for crypto, fetch, or auth — uses Node.js/Electron native APIs
- `.env` loaded manually in `main.js` (no dotenv dependency — their v17 changed the API)
- `scripts/launch.js` exists to unset `ELECTRON_RUN_AS_NODE` which VS Code / Claude Code shells inject
- All async DB calls wrapped in try/catch with fallback defaults
- Background AI calls include `.catch()` and deduplication guards
- User input sanitized via `sanitizeUpdates()` allowlist (`ALLOWED_CLIP_FIELDS` in main.js) before DB writes
- `.env` for configuration (see `.env.example`), `credentials.json` for Vertex AI (both git-ignored)
- `notifyMainWindow(channel, data)` pushes IPC events to the renderer — use this after any state change

## Cross-Platform Window Capture

- **Windows:** PowerShell P/Invoke script (auto-generated at `scripts/get-window.ps1`)
- **Linux X11:** xdotool
- **Linux Wayland+GNOME:** gdbus
- **macOS:** Not yet implemented (app runs, window capture unavailable)

## Native Build Requirements

`better-sqlite3` requires native compilation:
- **Windows:** Visual Studio Build Tools
- **Linux:** build-essential, python3, libsqlite3-dev
- **macOS:** Xcode Command Line Tools
