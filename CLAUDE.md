# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Pre-Feature Audit

Before implementing any new feature or significant code change, launch a Haiku subagent (model: haiku) to audit the codebase for:
- Duplicated functions or near-identical logic
- Dead code (unused functions, unreachable branches, orphaned imports)
- Redundant tools or utilities that overlap in purpose
- Inconsistent patterns (e.g., two different ways of doing the same thing)

The audit agent should report findings concisely. If duplicates or dead code are found, address them as part of the implementation rather than adding more redundancy.

**Save findings:** After the audit completes, append a summary to `.ai-workflow/context/AUDIT_LOG.md` using this format:

```markdown
## YYYY-MM-DD — Feature Name

- Finding 1
- Finding 2
- Recommendation
```

These findings are visible in the Workflow tab's "Audits" section inside HuminLoop.

## Project Overview

HuminLoop — an ADHD-friendly Electron app for AI-powered knowledge capture. Screenshot → note → AI categorization. Designed for developers using AI-assisted coding tools who need rapid issue capture without breaking flow.

## Commands

```bash
npm start          # Launch app (uses scripts/launch.js)
npm run dev        # Launch with DevTools auto-open (HUMINLOOP_DEV=1)
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

**MCP Server:**
```bash
cd mcp-server && npm install   # Install MCP server deps (separate package)
node mcp-server/index.js       # Run standalone (stdio transport)
```

No test suite exists. Dev testing is done via `npm run dev` + DevTools console.

## Architecture

```
Renderer (5 windows + 2 overlays)   Main Process (src/main.js)
  index.html  — notes viewer           ├─ Tray + global hotkey (Ctrl+Shift+Q)
    Full: 4 tabs (Notes, Projects,     │
          Workflow, Settings)          │
    Focused: Projects only + mode label │
  capture.html — full capture popup    │─ Clipboard watcher (1s poll)
  focused-capture.html — focused capture │─ Window metadata capture
  setup.html  — first-run wizard       │─ IPC handlers + event emitters
  toolbar.html — floating draw bar     │─ Background AI tasks
  overlay.html — fullscreen annotator  │─ HTTP API server (localhost:7277)
         ↕ IPC (preload.js)            │─ Mode switching (full ↔ focused)
                                        ↓
                                   Module Layer
                                     db.js → db-pg.js | db-sqlite.js
                                     ai.js → Gemini 2.5 Flash (Vertex or API key)
                                     rules.js → 7-strategy categorization chain
                                     api-server.js → REST API for external tools
                                     window-info.js → Win32/xdotool/gdbus
                                     images.js → disk storage + compression
                                     media.js → demo video/audio disk storage (streaming)
                                     workflow-context.js → reads SESSION.md/AUDIT_LOG.md

MCP Server (mcp-server/)       Workflow System (workflow/)
  Separate Node process          Multi-agent dev orchestration
  stdio transport for            Architect/Builder/Reviewer/Screener roles
    Claude Code / Gemini CLI     tmux-based, git hooks, dashboards
  Calls HTTP API ↑               Templates + scripts for agent instructions
```

### Focused Mode

Toggleable via tray menu ("Switch to Focused/Full Mode"). Stored as `app_mode` setting (`'full'` or `'focused'`).

- **Same renderer** (`index.html`) with JS-driven tab hiding — General Notes and Workflow tabs hidden, Projects tab forced active, "Focused Mode" label in header
- **Focused capture popup** (`focused-capture.html`) — stripped down: screenshot + note + "Save & Generate Prompt" button only
- **Project-focused** — user must select a single active project; "All Projects" hidden from sidebar; project selection synced to `focused_active_project` setting
- **AI prompt generation** — `autoCategorizeFocused()` calls `ai.generateFocusedPrompt()` using a dedicated prompt template that interprets annotation colors (red=remove, green=add, pink=reference) and prioritizes the user's note over annotations. Standard `autoCategorize()` also runs in parallel for summary/tags.
- **Workflow context bridge** — `workflow-context.js` reads `SESSION.md` and `AUDIT_LOG.md` from the active project's `repo_path/.ai-workflow/context/` and feeds them into the focused prompt. This is the first runtime connection between the workflow system and AI — full mode will reuse this later.
- **Clip filtering** — `source` column on clips (`'full'` or `'focused'`); focused clips auto-filtered by active project. AI cannot override project assignment in focused mode.
- **Active-in-IDE** — projects have an `active_in_ide` toggle (green dot in sidebar, "IN IDE" badge in detail view)
- **Show/hide completed** — checkbox toggle in project detail to filter completed clips

### Toolbar & Overlay

Floating annotation toolbar + fullscreen transparent overlay for drawing on screen before capture.

- **Toolbar** (`renderer/toolbar.*`) — color dots (red/green/pink), T button (text mode), Capture, HuminLoop button, minimize/close. Saves position via DB settings. Always-on-top, frameless.
- **Overlay** (`renderer/overlay.*`) — fullscreen transparent canvas. Freehand drawing in active color. Text tool: click to place cursor, type, Enter commits, Escape cancels. Region select mode for snippets. Right-click exits draw mode.
- **IPC relay** — toolbar↔overlay communication goes through main process: `set-color`, `draw-mode-exited`, `toggle-text-mode`, `text-mode-changed`, `text-mode-exited`

### Key Data Flow

**Full mode:**
1. User takes screenshot (Windows Snipping Tool `Ctrl+Win+S` or any clipboard screenshot) → clipboard watcher detects new image → window metadata grabbed
2. Capture popup opens → user adds note → clip saved to DB, image to disk
3. Rules engine categorizes synchronously (7 strategies in priority order)
4. AI enriches asynchronously (summary, tags, URL extraction, fix prompts)
5. Main window updates via IPC event

**Focused mode:**
1. User draws annotations on screen via toolbar/overlay (red/green/pink + text tool)
2. Takes snippet or presses hotkey → focused capture popup opens
3. User types note describing what needs to change → saves clip
4. Main process injects `source: 'focused'` and active project ID
5. `autoCategorize()` runs for summary/tags + `autoCategorizeFocused()` runs for focused coding prompt (parallel)
6. Prompt appears in clip card, ready to copy into AI coding tool

**Send to IDE (staging file bridge):**
1. User clicks "Send to IDE" on a clip prompt (or "Combine & Send to IDE" for multi-select)
2. HuminLoop writes `IDE_PROMPT.md` (+ optional `ide-prompt-image.png`) to `{repo_path}/.ai-workflow/context/`
3. IDE agent calls MCP `get_pending_prompt` tool → reads prompt + image → files are deleted (one-shot delivery)
4. Agent receives prompt text + screenshot as MCP content blocks and can act on it immediately

### Rel — In-App AI Assistant

"RelliK Wolf-Krow" (Rel) is HuminLoop's built-in AI chat assistant, powered by the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) embedded in the main process. Phase 1 (chat shell) is live; upcoming phases: repo/workflow audit on connect, manifest-driven Workflow tab, per-asset "Ask Rel" buttons.

- **Auth:** the user's Claude subscription login (`claude login` OAuth from `~/.claude/.credentials.json`) — no API key. Usage bills against subscription limits.
- **`rel` module (`src/rel.js`):** wraps the SDK's `query()`. The SDK is ESM-only → lazy `import()` from CJS. Per-turn options: `cwd` = project repo_path, `executable: 'node'`, env stripped of `ELECTRON_RUN_AS_NODE`, `permissionMode: 'acceptEdits'` (edits apply automatically — user preference), tools Read/Glob/Grep/Edit/Write/WebSearch/WebFetch + `mcp__huminloop` (Bash off unless `rel.allowBash`). The huminloop MCP server is attached as a stdio server per turn, so Rel natively sees clips/projects/demos/workflow.
- **Models:** settings key `rel` — `chatModel` (default `claude-sonnet-5`), `auditModel` (default `claude-opus-4-8`, for the phase-2 audit; bump to `claude-fable-5` if desired).
- **Sessions:** per-project SDK session ids persisted in settings key `rel_sessions` → conversations resume across app restarts; a stale id is dropped and the turn retried fresh.
- **UI (`renderer/rel-dock.css` + `renderer/rel-panel.js`):** Rel is an **embedded chat panel docked bottom-right inside the viewer window** (not a separate BrowserWindow), opened by a floating 🐺 launcher bubble. `rel-panel.js` is IIFE-wrapped so its helpers (`esc`, `renderMarkdownLite`, …) never collide with `index.js`, which defines the same names; all dock element ids are `rel*`-prefixed. `rel-dock.css` scopes every rule under `.rel-dock`/`.rel-launcher` and reuses the app theme vars. The conversation persists across close/reopen because the dock lives in the long-lived viewer DOM. IPC: `open-rel` (send → main shows the viewer + pushes `rel-open`), `rel-open` (main→renderer: reveal dock, optional projectId), `get-rel-context`/`rel-send` (invoke), `rel-interrupt` (send), `rel-event` (main→viewer stream: status / text-delta / tool / assistant / result). `main.js` `openRelDock()` shows/focuses `mainWindow` and sends `rel-open`; `sendRelEvent()` targets `mainWindow.webContents`. (`window-factory.js`/`createAppWindow` is no longer used by Rel but remains the shared helper for future windows.)
- **Entry points:** floating 🐺 launcher bubble (bottom-right), 🐺 header button in the viewer, tray "Ask Rel", and the "Meet Rel" button on the Connect IDE wizard's Connected step. The header/wizard/launcher call `window.openRelDock(projectId)` in-renderer; the tray goes through `open-rel`.

### Project Demos

Per-project screen recordings with AI narration cleanup. Full design in [docs/DEMOS.md](docs/DEMOS.md).

- **Recorder** (`renderer/record.*`) — dedicated always-on-top renderer; `MediaRecorder`/`getUserMedia` are DOM-only, so capture runs here. `desktopCapturer` (main-only) supplies the screen/window source list for "record app vs whole screen". Two `MediaRecorder`s: combined video+mic (`video.webm`, for playback) and mic-only (`audio-original.webm`, small, for transcription). Chunks stream over IPC to disk. A WebAudio **VAD** samples mic RMS while recording and produces `speech_segments` (narrated stretches, in seconds) with a live 🎙 indicator.
- **Activity tracker** (main) — while a demo records, polls the focused window (async `getActiveWindowAsync()`, 1.5s — the sync variant would block the event loop) and cursor travel (`screen.getCursorScreenPoint()`, 250ms → 5s buckets) into `activity_log`. No global click/keystroke hook (Electron limitation; `uiohook-napi` is the future path).
- **`media` module** (`src/media.js`) — path-based on-disk storage under `{userData}/demos/{id}/` with **streaming writers** (never base64-round-trips video, unlike `images.js`). Write streams carry `'error'` handlers (an unhandled stream error would kill the main process); read paths never `mkdir`. Also holds the self-dub writer, `pcmToWav()` for TTS output, and a path-traversal guard.
- **`demos` table** — both backends + `db.js` passthroughs; schema in `db-sqlite.js` SCHEMA + migrations, `db-pg.js` runMigrations (existing pg), and `docker/init.sql` (fresh pg). Columns include `transcript`, `script` (polished voice-over), `markers`, `speech_segments`, `activity_log`. Soft-delete/trash with 30-day purge that also deletes files; restorable from the Demos tab's Trash section. `deleteProject()` nulls demo `project_id` in both backends. sqlite timestamps are normalized to ISO-8601 UTC in `parseDemoRow` (raw `datetime('now')` strings parse as local time in Chromium).
- **Permissions** — `configureMediaPermissions()` in main registers `setPermissionRequestHandler` + `setDisplayMediaRequestHandler`, scoped to media/display-capture permissions only. Recorder window uses `setContentProtection(true)` to stay out of full-screen captures.
- **Markers** — global hotkey (`MARKER_HOTKEY`, default `Ctrl+Shift+M`) registered only while recording; relayed to the recorder to timestamp a moment.
- **AI** — `ai.generateDemoTranscript()` (Gemini 2.5 Flash audio input; `callGemini` takes `model`/`generationConfig`/`timeoutMs`/`wantAudio` overrides), `ai.generateDemoScript()` (transcript + activity metadata → polished voice-over script), and `ai.synthesizeDemoDub()` (experimental Gemini TTS; reads `script` when present).
- **Dubbing** — two paths sharing the demo's dub slot: AI TTS (`audio-dubbed.wav`) or **self-dub** (`audio-dubbed.webm`) recorded in the viewer over muted playback via `demo-dub-begin/chunk/finish/cancel`. `audio_mode` picks the playback track; dubbed playback mutes the `<video>` and syncs a hidden `<audio>` to it.
- **Playback** — served via the local HTTP API with **Range** support incl. suffix ranges (`GET /api/demos/:id/{video,audio,poster}`), streamed via `stream.pipeline` (destroys the read stream on client disconnect — `<video>` seeking aborts a request per seek). Viewer CSP extended with `media-src`/`img-src http://127.0.0.1:*`.
- **Viewer** — Demos sub-tab in project detail (shares `renderProjectTabStrip()` with Notes/Workflow); inline `<video>` with a clickable **timeline reel** (speech highlights + marker pins + playhead), clickable transcript/script segments that seek the video, dub controls, and a collapsible Trash. Playback position survives `renderAll()` re-renders (`_demoPlayState` + `wireDemoPlayers()`).

### IPC Pattern

All renderer↔main communication goes through `preload.js` which exposes `window.quickclip.*` (~50 methods). Context isolation is enforced — no `nodeIntegration`.

- **`ipcMain.handle` / `ipcRenderer.invoke`** — used for all request/response calls (clips, projects, settings, AI)
- **`ipcMain.on` / `ipcRenderer.send`** — used for fire-and-forget window controls (`close-capture`, `hide-main`, `open-capture`)
- **`webContents.send`** — main→renderer push events (`clips-changed`, `projects-changed`, `new-screenshot`)

### Local HTTP API (`src/api-server.js`)

REST API on `http://127.0.0.1:7277` (localhost only, no auth). Started automatically by main.js after DB/AI init. Mirrors IPC handlers so external tools can access HuminLoop.

- **Port:** `HUMINLOOP_API_PORT` env var, default `7277`
- **Endpoints:**
  - `/api/health` — GET health check
  - `/api/clips` — GET list, POST create
  - `/api/clips/trash` — GET trashed clips
  - `/api/clips/:id` — GET read, PATCH update, DELETE soft-delete
  - `/api/clips/:id/complete` — POST mark complete
  - `/api/clips/:id/uncomplete` — POST mark uncomplete
  - `/api/clips/:id/restore` — POST restore from trash
  - `/api/clips/:id/permanent` — DELETE permanent deletion
  - `/api/projects` — GET list, POST create
  - `/api/demos` — GET list (`?project_id=` / `?unassigned=true`)
  - `/api/demos/trash` — GET trashed demos
  - `/api/demos/:id` — GET read, PATCH update (title/description/audio_mode), DELETE soft-delete
  - `/api/demos/:id/restore` — POST restore from trash
  - `/api/demos/:id/permanent` — DELETE row + media files
  - `/api/demos/:id/video` — GET range-streamed video (playback + seeking)
  - `/api/demos/:id/audio` — GET range-streamed audio (`?which=original|dubbed`)
  - `/api/demos/:id/poster` — GET thumbnail PNG
  - `/api/categories` — GET list
  - `/api/settings` — GET read, PATCH update
  - `/api/ai/search` — POST semantic search
  - `/api/ai/summarize` — POST summarize clips
  - `/api/clips/:id/image` — GET clip screenshot as data URL
  - `/api/clips/:id/send-to-ide` — POST stage clip prompt + image in project workspace
  - `/api/ai/combine-and-send` — POST combine clips and stage for IDE
  - `/api/ai/status` — GET AI module status
  - `/api/workflow/status` — GET workflow engine status
  - `/api/workflow/changelog` — GET workflow changelog
  - `/api/workflow/prompts` — GET tracked prompts
  - `/api/workflow/audits` — GET pre-feature audit log
- **Route matching:** custom `matchRoute()` with `:param` placeholders — no Express dependency
- New API endpoints must mirror the IPC handler logic (rules, sanitization, audit entries, AI triggers)

### MCP Server (`mcp-server/`)

Separate Node.js process (stdio transport) that bridges AI IDE agents to HuminLoop via the HTTP API. Has its own `package.json` with `@modelcontextprotocol/sdk` dependency.

**Tools (23 total):**
- **Knowledge:** `clip_list`, `clip_get`, `clip_create`, `clip_update`, `clip_delete`, `clip_complete`, `clip_search`, `clip_summarize`, `clip_combine_prompt`, `project_list`, `project_get`, `project_create`, `category_list`, `demo_list`, `demo_get`, `huminloop_health` — proxy to HTTP API
- **Workflow:** `session_context`, `session_read`, `git_status` — run locally via `child_process`
- **IDE Bridge:** `project_match` (auto-match workspace to HuminLoop project + return workflow context), `project_link` (link workspace to an existing project by setting its repo_path — self-heal when match fails), `get_pending_prompt` (read staged IDE_PROMPT.md + image, one-shot delivery), `clip_get_prompt` (fetch clip prompt + optional image on-demand)

**Project matching:** `matchProject()` compares `PROJECT_ROOT` against project `repo_path` fields (normalized path comparison). A successful match is cached for the session; a miss is retried after 30s so mid-session linking (via `project_link` or the app) takes effect without an IDE restart. On a miss the server also POSTs `/api/workspace/propose` so the viewer offers to register/link the workspace.

**Container-aware:** auto-detects devcontainers/Codespaces and uses `host.docker.internal` to reach the Electron app on the host.

### Database Layer

`db.js` is a backend switcher that delegates to `db-pg.js` (PostgreSQL) or `db-sqlite.js` (better-sqlite3). Auto-detects PostgreSQL availability, falls back to SQLite. Both implementations expose the same API surface.

- **PostgreSQL:** Docker container, port 5433, schema in `docker/init.sql`
- **SQLite:** `{userData}/huminloop.db`, WAL mode
- **Images:** Stored on disk at `{userData}/images/{clipId}.png`, DB stores `__on_disk__` flag
- **DB_BACKEND** env var: `pg`, `sqlite`, or `auto` (default — tries pg first, falls back to sqlite)

When adding new DB operations, implement in both `db-pg.js` and `db-sqlite.js`, then expose through `db.js`'s delegation pattern.

### AI Module (`src/ai.js`)

- Gemini 2.5 Flash via Google AI API key or Vertex AI (native JWT, no googleapis SDK)
- 8 toggleable instruction blocks for categorization prompts (stored in DB settings as `prompt_blocks`)
- 30-second abort on all API calls
- Cached Vertex AI access tokens with 60s refresh buffer
- Image compression: max 800px width, JPEG for AI payloads (~70% reduction)
- `generateFocusedPrompt()` — dedicated function for focused mode; uses `FOCUSED_PROMPT` template with annotation color semantics; calls `callGemini()` with `{ raw: true }` to get plain text instead of JSON; enriched with project context and workflow session data

### Rules Engine (`src/rules.js`)

Priority chain: manual selection → repo path auto-match → user window rules → process map → title keywords → comment keywords → AI fallback. 5-minute in-memory cache for projects/rules/categories. Call `rules.invalidateCache()` when projects or window rules change.

### Categorization Chain

Rules run first (instant). If AI is enabled, it runs async in background — enriches clip with summary, tags, URL, project match. AI can override category only if rules left it as "Uncategorized".

### Clip Lifecycle

- **Create (full):** save-clip → rules categorize → AI enriches async → `clips-changed` event
- **Create (focused):** save-clip → source='focused' + project injected → rules → AI summary + focused prompt (parallel) → `clips-changed` event
- **Complete:** sets `completed_at`, optionally trashes (archive = soft delete via `deleted_at`)
- **Trash:** soft-delete sets `deleted_at`, restorable; auto-purge after 30 days on app launch
- **Permanent delete:** removes from DB + deletes image from disk
- **AI retrigger:** re-runs AI categorization on a single clip; also auto-fires when comment/thread edited

### Renderer Notes

`renderer/index.js` is a large single-file (~2500 lines) that drives the main notes viewer. It manages tabs (General Notes, Projects, Workflow, Settings, Help), filtering, sorting, and all UI rendering via DOM manipulation (no framework). HTML escaping uses `esc()` and `escAttr()` helpers — always use these for user content.

**Focused mode adaptation:** On startup, `index.js` checks `getAppMode()`. If focused, it hides the General Notes and Workflow tabs, forces Projects tab active, adds a "Focused Mode" label to the header, hides "All Projects" from the sidebar, auto-selects the `focused_active_project`, and shows a focused-specific help page. The `isFocusedMode` flag gates these behaviors throughout rendering.

### Workflow Tab

The main window has a Workflow tab that surfaces the AI dev workflow state directly in the app. Five sub-views navigated via sidebar:

- **Status** — toggle switches for relay mode & audit watch; clickable pending/completed prompt counts
- **Prompts** — tracked prompt log with All/Pending/Done filter bar
- **Audits** — pre-feature audit findings log (collapsible entries from `AUDIT_LOG.md`)
- **Session** — current `SESSION.md` contents
- **Changelog** — workflow changelog

Data flows through IPC (`get-workflow-status`, `get-workflow-changelog`, `get-workflow-prompts`) and is also exposed via the HTTP API (`/api/workflow/*`).

### Connect IDE Wizard & Workspaces Quick Launch

When a project isn't IN IDE, the project Workflow header shows "🔌 Connect IDE…" which opens a wizard (`openIdeConnect` in `renderer/index.js`):

1. **Pick a window** — `wininfo.listIDEWindows()` enumerates open VS Code windows: Win32 EnumWindows via auto-generated `scripts/list-windows.ps1`, **WSL→Windows-host `powershell.exe` interop** (host VS Code windows are invisible to xdotool), and xdotool for Linux-native windows. Titles are parsed by `parseVSCodeWindowTitle()` (folder + `[WSL: …]` remote badge).
2. **Verify** — IPC `connect-ide-window` compares the window's folder to the repo_path basename (via `normalizeRepoPath`); mismatch → friendly "this may not be the correct project/path" warning with connect-anyway.
3. **Check IDE + MCP** — reuses `detect-ide` (VS Code CLI / Claude Code extension / mcp.json). `startIdeCheck()` then **auto-writes the MCP config** (`write-mcp-config` → `.vscode/mcp.json` + `.mcp.json`, repo path baked into the server entry's env) when the project has a `repo_path` and MCP isn't already configured — the user no longer hand-edits mcp.json or clicks "Apply" (a toast confirms; `showMcpSetup()` remains only as a manual fallback if the auto-write fails, gated on `st.autoMcpTried`). Then polls until the MCP heartbeat flips `active_in_ide`. **The wizard never sets `active_in_ide` itself** — the api-server heartbeat system owns that flag.
4. **Suggest a workspace pin** on success.

**New Project picker:** `showNewProjectDialog()` lists the user's currently-open editor windows (same `listIDEWindows()` enumeration) at the top; picking one (`pickIdeWindowForNewProject`) prefills the project name from the window's folder and marks it a Developer Project. Window titles carry only the folder *name*, not an absolute path, so the exact `repo_path` still comes from the native **Browse…** picker (`pick-directory` IPC) or the leave-blank auto-link-on-connect flow.

**Workspaces quick launch:** sidebar section (below Trash in both the General Notes and Projects sidebars) listing pinned projects; click runs IPC `open-project-workspace` → `code <repo_path>` (exit-code-checked; VS Code's terminal-only remote-cli shim failing is reported, not swallowed). Pins live in settings key `workspace_quick_launch` (array of project ids), toggled via the ★ Workspace header button or the wizard.

### Audit Ledger

In-memory array (max 200 entries) persisted to DB settings key `audit_log`. Tracks clip create/update/delete/AI actions. Use `addAuditEntry(action, detail)` in main.js when adding new operations.

## Workflow System

Two-layer structure: `workflow/` (generic templates + Linux scripts from ai-dev-workflow repo) and `.ai-workflow/` (HuminLoop-compiled instructions + Windows-adapted scripts).

### Runtime: `.ai-workflow/`

```
.ai-workflow/
  instructions/   — Compiled role files (SHARED, ARCHITECT, BUILDER, REVIEWER, SCREENER)
  context/        — SESSION.md, RELAY_MODE, AUDIT_WATCH_MODE, prompt tracker log
  scripts/        — Windows/Git Bash scripts (ensure-workflow, show-status, prompt-tracker, etc.)
  config/         — (reserved for future project-specific config)
```

**Quick commands (Git Bash):**
```bash
bash .ai-workflow/scripts/ensure-workflow.sh              # Health check
bash .ai-workflow/scripts/show-status.sh                  # Workflow status
bash .ai-workflow/scripts/show-status.sh compact          # One-line status
bash .ai-workflow/scripts/compose-instructions.sh builder # Dump builder instructions
bash .ai-workflow/scripts/prompt-tracker.sh add "scope" "description"  # Track a prompt
bash .ai-workflow/scripts/toggle-relay-mode.sh            # Toggle relay mode on/off
bash .ai-workflow/scripts/toggle-audit-watch.sh           # Toggle audit watch on/off
```

### Templates: `workflow/`

Generic templates and Linux-native scripts (from `wyofalcon/ai-dev-workflow`). Not used directly on Windows — compiled versions live in `.ai-workflow/instructions/`.

### Agent Roles

| Role | Model | Purpose |
|------|-------|---------|
| **Architect** | Claude Sonnet 4.6 | Orchestrates workflow, refines prompts, manages git/PRs. Does NOT write app code. |
| **Builder** | Claude Opus 4.6 | Writes all application code. Receives refined prompts from Architect. |
| **Reviewer** | Gemini 3.1 Pro | Audits diffs for quality/security. Returns structured JSON verdicts. |
| **Screener** | Gemini 2.0 Flash | Pre-commit AI analysis. |

**Routing convention (Architect):**
- `!message` — route to Builder (refine prompt first)
- `!!message` — direct-to-builder shortcut (skip refinement)
- `?message` — workflow config change (Architect handles directly)
- No prefix — Architect handles directly (questions, reviews, git ops)

### Git Hooks

Installed into `.git/hooks/` by `scaffoldWorkflow`/`repairWorkflow` (source templates in `workflow-templates/hooks/`, idempotent via marker comment):

- **`prepare-commit-msg`** — marks tracked prompts DONE via `PATCH /api/workflow/prompts/:id` when the commit message contains `# Prompt ID: xxx`.
- **`post-commit`** — regenerates the "Current State" and "Recent Commits" sections of `SESSION.md` after every commit; content from `## In Progress` onward is preserved.

(`workflow/hooks/prepare-commit-msg` is the older Linux/tmux variant that appends builder summaries from `builder-output.log` — not installed by the app.)

### Windows Notes

- All `.ai-workflow/scripts/` are Git Bash compatible — no tmux, no inotifywait
- `workflow/scripts/` contains the original Linux/tmux versions (audit-watch, dashboards, tmux launchers) — these require WSL
- The `prompt-tracker.sh` uses `TZ=America/Chicago` for Central Time prompt IDs

## Component Labels

Use these labels when discussing parts of the system. They are the canonical shorthand.

**App layers:**

| Label | Component | Location |
|-------|-----------|----------|
| `main` | Electron main process | `src/main.js` |
| `viewer` | Notes viewer window (full + focused) | `renderer/index.*` |
| `capture` | Full capture popup | `renderer/capture.*` |
| `focused-capture` | Focused capture popup | `renderer/focused-capture.*` |
| `toolbar` | Floating annotation toolbar | `renderer/toolbar.*` |
| `overlay` | Fullscreen draw/text overlay | `renderer/overlay.*` |
| `record` | Demo screen-recorder control panel | `renderer/record.*` |
| `wizard` | First-run setup window | `renderer/setup.*` |
| `preload` | IPC context bridge | `src/preload.js` |

**Modules:**

| Label | Component | Location |
|-------|-----------|----------|
| `db` | Database switcher | `src/db.js` |
| `db-pg` | PostgreSQL backend | `src/db-pg.js` |
| `db-sqlite` | SQLite backend | `src/db-sqlite.js` |
| `ai` | Gemini AI module | `src/ai.js` |
| `rules` | Categorization engine | `src/rules.js` |
| `wininfo` | Window metadata capture | `src/window-info.js` |
| `images` | Disk image storage | `src/images.js` |
| `repo-path` | repo_path normalization + comparison | `src/repo-path.js` |
| `media` | Disk demo video/audio storage + streaming writers + PCM→WAV | `src/media.js` |
| `wf-context` | Workflow context reader | `src/workflow-context.js` |

**External interfaces:**

| Label | Component | Location |
|-------|-----------|----------|
| `api` | Local HTTP REST server | `src/api-server.js` |
| `mcp` | MCP server (stdio bridge) | `mcp-server/index.js` |

**Workflow roles:**

| Label | Role | Model |
|-------|------|-------|
| `architect` | Orchestrator, prompt refiner, git ops | Sonnet 4.6 |
| `builder` | Writes all app code | Opus 4.6 |
| `reviewer` | Diff auditor (JSON verdicts) | Gemini 3.1 Pro |
| `screener` | Pre-commit analysis | Gemini 2.0 Flash |

**Data concepts:**

| Label | What |
|-------|------|
| `clip` | Captured note (screenshot + comment + metadata) |
| `project` | Grouping container for clips (with repo_path for auto-match) |
| `category` | Single-label classification (e.g. "Dev Tools", "Web") |
| `tag` | Multi-label keywords on a clip |
| `fix-prompt` | AI-generated actionable prompt per clip (`aiFixPrompt`) |
| `summary` | AI-generated filing label per clip (`aiSummary`) |
| `audit` | Action log entry (create/update/delete/AI) |
| `rule` | Window rule for pattern-based categorization |
| `source` | Clip origin flag: `'full'` or `'focused'` |
| `active-in-ide` | Project flag indicating it's open in user's IDE |
| `focused-prompt` | AI-generated coding prompt from annotated screenshot |
| `demo` | Screen recording (video + narration + markers + AI transcript) in a project's Demos tab |

## Key Conventions

- No npm deps for crypto, fetch, or auth — uses Node.js/Electron native APIs
- `.env` loaded manually in `main.js` (no dotenv dependency — their v17 changed the API)
- `scripts/launch.js` exists to unset `ELECTRON_RUN_AS_NODE` which VS Code / Claude Code shells inject
- All async DB calls wrapped in try/catch with fallback defaults
- Background AI calls include `.catch()` and deduplication guards
- User input sanitized via `sanitizeUpdates()` allowlist (`ALLOWED_CLIP_FIELDS` in main.js) before DB writes
- `.env` for configuration (see `.env.example`), `credentials.json` for Vertex AI (both git-ignored)
- `notifyMainWindow(channel, data)` pushes IPC events to the renderer — use this after any state change
- When adding new features accessible externally, add endpoints to both the IPC handlers (main.js) and the HTTP API (api-server.js), then add MCP tool definitions in `mcp-server/index.js`

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
