# Pre-Feature Audit Log

## 2026-05-09 — Project-Scoped Workflow Tab + Multi-IDE Sessions

- Duplicated workflow read logic in main.js IPC and api-server endpoints (RELAY_MODE, AUDIT_WATCH_MODE, SESSION.md, CHANGELOG.md, AUDIT_LOG.md) — consolidate via new `workflow-context` helpers (`readRelayMode`, `readAuditMode`, `readChangelog`, `readAuditLog`)
- `get-workflow-prompts` IPC handler re-implements `getPendingPrompts()` from workflow-context.js — delegate to module instead
- `updatePromptStatus()` in main.js (line 58) and `/api/workflow/prompts/:id` PATCH duplicate prompt-tracker write logic — move to `workflow-context.updatePromptTracker(repoPath, ...)`
- All hardcoded `path.join(__dirname, '..', '.ai-workflow', ...)` reads break under per-project scoping — must accept `projectId` and resolve to `project.repo_path`
- `scaffoldWorkflow()` lacks `fs.existsSync(repoPath)` check before mkdir — add validation as part of refactor
- `getGitState()` and `readRelayMode()` exported from workflow-context.js but only `readRelayMode` will be needed externally after refactor — leave both exported (low cost)
- Toggle handlers (`toggle-relay-mode`, `toggle-audit-watch`) currently IPC-only with no API mirror — add API endpoints for consistency since workflow moves into project detail
- Recommendation: bundle all consolidation in this single PR rather than tracking as follow-up — the refactor touches the same files anyway

## 2026-04-09 — Queue as Plan (Sequential Task Dispatch)

- Plan dispatch reuses existing `formatBundle`, `generatePromptId`, `appendToPromptTracker`, `workflowContext.assembleBundle` — no new duplicated logic
- New `updatePromptStatus()` helper edits PROMPT_TRACKER.log lines in-place; complements `appendToPromptTracker()` (append vs. update — no overlap)
- Image write pattern (load → base64 → writeFile) repeated from `bundle-and-send` handler; acceptable since the context differs (plan tasks vs. single bundle)
- `activePlans` is in-memory only (Map) — lost on app restart. Acceptable for v1; persistence could be added later via DB settings
- No dead code introduced; all new functions are wired to IPC handlers and renderer calls
- Recommendation: Consider extracting the IDE_PROMPT file write sequence (markdown + image) into a shared helper in a future pass, since it appears in `bundle-and-send`, `bundle-and-send-multiple`, and now `queue-as-plan` + `advance-plan`

## 2026-04-09 — Lite to Focused Rename + v2 Migration

- Mechanical rename across 10 files — no duplicated logic introduced
- Dead code identified: `renderer/lite-index.*` (3 files) — orphaned from an earlier abandoned approach where lite mode had its own renderer; current code uses `index.html` with JS-driven tab hiding. Not blocking; left as-is for now.
- `VALID_SOURCES` in db-sqlite.js and db-pg.js updated to include both `'lite'` (backward compat) and `'focused'` (new)
- v2 migration added to main.js: runs once on first launch, updates `app_mode`, `focused_active_project`, and clip `source` field
- `runRaw()` added to DB layer (db.js, db-sqlite.js, db-pg.js) for migration SQL
- PROMPT_TRACKER.log parser updated to include 7th `files` field in both main.js and api-server.js
- Recommendation: Clean up dead `renderer/lite-index.*` files in a future pass

## 2026-04-09 — Auto-detect In IDE Connection State

- **Git helper duplication** in mcp-server/index.js — identical `git()` function defined in both `session_context` and `git_status` handlers (lines 339, 447). Extract to module-level utility.
- **Image load+compress pipeline** repeated 3x in api-server.js (lines 318, 349, 369). Extract to helper.
- **Dead code**: `deleteCategory()` exists in both DB backends but not exported from db.js wrapper — never called anywhere.
- **No existing polling/heartbeat infrastructure** — this feature adds the first connection-tracking mechanism. Design it centrally.

## 2026-04-04 — HuminLoop Lite Mode

- **Workflow file reading duplicated** between main.js IPC handlers and api-server.js (~50 lines). New `workflow-context.js` covers external projects; HuminLoop's own reads should migrate to it over time.
- **Clip save flow duplicated** between main.js `save-clip` handler and api-server.js `POST /api/clips` (~35 lines). Should extract to a shared function.
- **`get-setting` (singular) IPC handler** appears unused — all renderers call `getSettings()` (plural). Safe to remove.
- **`archived` column** still present but soft-delete uses `deleted_at` instead. Low priority cleanup.
- Overlay, toolbar, preload patterns are clean — no duplication or dead code found in files touched by lite mode.
- Recommendation: None of these block lite mode implementation. Address workflow read consolidation and save-flow dedup in a future cleanup pass.

## 2026-04-05 — Multi-Clip Selection + Combined AI Prompt

- **Copy logic duplicated** in 4+ functions (copyPrompt, copyNoteText, copyInline, copySummaryPanel) — each reimplements find-clip + clipboard write + visual feedback. Candidate for `copyToClipboard(text, options)` helper extraction.
- **Image load-and-compress** still duplicated in 5 places (flagged previously) — new combine handler adds a 6th. Should extract to shared helper.
- No existing multi-select or batch selection patterns found — clean slate for new implementation.
- Existing `ai.summarizeNotes()` generates per-note prompts (sequential calls). New `generateCombinedPrompt()` sends all notes in one Gemini call — different approach, no conflict.
- No dead code found in AI module, renderer clip rendering, or IPC handlers.
- Recommendation: Extract image-compress helper and copy-to-clipboard helper in a future cleanup pass.

## 2026-04-06 — Prompt Filter + Sent-to-IDE Indicator

- No duplicated filtering logic — each filter (status, category, tags, completion) is distinct
- No dead code in clip/prompt handling — all `aiFixPrompt` references are active
- "Show completed" toggle is the ideal template for the new filter (state var → toggle → filter in renderProjectDetail)
- Prompt checks (`!!c.aiFixPrompt`) used consistently across main.js, renderer, summary panel
- Workflow prompt filter (Pending/Done) is separate data model — no conflict
- No schema changes needed for prompt filter (aiFixPrompt already in CLIPS_BASE_QUERY); new `sent_to_ide_at` column required
- Recommendation: Follow the hideCompleted pattern exactly for the new prompt filter

## 2026-04-05 — Auto-Copy Lite Prompt to Clipboard

- **Image load-and-compress pattern duplicated** in 5 places in main.js — candidate for extraction to a helper
- **Field name inconsistency** in `update-clip` and `retrigger-ai` handlers: uses `clip.windowTitle`/`clip.processName` but DB returns `window_title`/`process_name` — causes metadata loss on AI re-runs
- No dead code found; no existing clipboard auto-copy logic to conflict with
- Recommendation: Extract image compress helper and fix field name bug in a future pass

## 2026-04-03 — Workflow Context Reader utility module

- `main.js` and `api-server.js` both contain inline `.ai-workflow` path reads (duplicated pattern) — new module targets a different use case (arbitrary repoPath) so no refactor needed now, but future callers should use `workflow-context.js` instead of reimplementing
- No existing `workflow-context.js` or equivalent utility found — new file is net-new, no dead code risk
- Recommendation: over time, refactor HuminLoop's own workflow reads in `main.js` and `api-server.js` to use a `hasWorkflow('.')` call from this module for consistency

## 2026-04-01 — Workflow toggle switches & clickable prompt cards

- 3 unused preload methods found (getGeneralClips, getClipsForProject, saveCategories) — not blocking, unrelated to workflow
- Toggle pattern inconsistency: toggleBlock/toggleCustomBlock rebuild entire state vs toggleStatus patches directly
- Workflow renderer functions are clean, no duplication
- All 3 workflow IPC handlers actively used
- Recommendation: new IPC handlers for relay/audit toggle rather than shelling out to bash scripts

## 2026-04-01 — Floating Annotation Toolbar (static shell)

- CSS custom properties (`--bg-card`, `--text-primary`, `--text-dim`, `--border-subtle`, `--radius-sm`, `--radius-md`, `--transition-fast`) duplicated between toolbar.css and capture.css/index.css — no shared stylesheet exists; acceptable as toolbar is a separate window with minimal token subset
- `.drag`, `.nd`, `.hidden` utility classes duplicated across capture.css, index.css, and now toolbar.css — same pattern used intentionally per existing convention; no shared base stylesheet
- `onProjectsChanged` IPC listener used in both index.js and toolbar.js — distinct consumers, no duplication concern
- No dead code introduced; toolbar.js stubs call IPC methods not yet in preload.js (expected, deferred to Task 2)
- Recommendation: consider a shared `toolbar-base.css` if a 4th renderer window is added

## 2026-04-01 — Audits section in Workflow tab

- No overlap between existing audit ledger (clip CRUD tracking, max 200 entries in memory) and new pre-feature audit log (markdown file in .ai-workflow/context/)
- .ai-workflow/context/ has 4 existing files: AUDIT_WATCH_MODE, CHANGELOG.md, RELAY_MODE, SESSION.md
- Workflow sidebar sections follow consistent pattern: array of {id, label} objects
- No dead code in workflow rendering functions

## 2026-04-06 — Send to IDE Feature

**Duplicated patterns identified:**

1. **Workflow file reading duplicated across layers** (api-server.js, main.js)
   - `get-workflow-status`, `get-workflow-changelog`, `get-workflow-prompts`, `get-workflow-audits` are identical in both files (~40 lines total)
   - Both read from `.ai-workflow/context/{RELAY_MODE, CHANGELOG.md, PROMPT_TRACKER.log, AUDIT_LOG.md}`
   - Pattern: inline path construction + `fs.readFileSync` with try-catch fallback
   - Impact: New send-to-ide feature will need these files — recommend extracting to a shared utility before adding new endpoints
   - Recommendation: Create `src/workflow-reader.js` module with `getWorkflowStatus()`, `getChangelog()`, `getPrompts()`, `getAudits()` functions; use in both main.js and api-server.js

2. **Image load-and-compress pattern duplicated in 6+ places** (main.js)
   - Lines 544, 594, 718-719, 780-781, 882-887, 920-926 all follow: `images.loadImage()` + `images.compressForAI()`
   - Used in: autoCategorize, autoCategorizeLite, update-clip handler, assign-clip-to-project, summarize-project, combine-clips-prompt
   - Send-to-IDE feature will add more: `POST /api/clips/:id/send-to-ide`, `POST /api/ai/combine-and-send` both need this pattern
   - Recommendation: Extract to `imageWithCompression(clipId)` helper in main.js or a new module

3. **Clip save logic duplicated** between main.js and api-server.js
   - `save-clip` IPC handler (lines 630-683) and `POST /api/clips` endpoint (lines 108-135) both:
     - Save image to disk, set flag to `__on_disk__`
     - Run rules categorization (duplicate: lines 651-661 vs 120-124)
     - Trigger AI async (duplicate: lines 669-681 vs 130-133)
   - Send-to-IDE may need to save clips via new API endpoint — duplication will increase
   - Recommendation: Already flagged in 2026-04-04 audit; extract to shared function before new feature

**New endpoints don't conflict with existing code:**

- `GET /api/clips/:id/image` — new endpoint, no existing image-fetch API (images.loadImage() is internal only)
- `POST /api/clips/:id/send-to-ide` — new action, no similar endpoint exists
- `POST /api/ai/combine-and-send` — new; existing `/api/ai/combine` only returns prompt text, doesn't send anywhere

**MCP tools don't duplicate existing:**

- `project_match` — new; no existing project matching tool
- `get_pending_prompt` — new; similar to `clip_get` but filters for clips without aiFixPrompt
- `clip_get_prompt` — new; similar to `clip_get` but returns just prompt field

**IPC handlers don't duplicate:**

- `sendToIde`, `combineAndSend` — new preload methods, not yet in preload.js

**Existing reusable patterns:**

- `images.loadImage(clipId)` → returns data URL (ready to use)
- `images.compressForAI(dataURL)` → returns compressed JPEG data URL
- `ai.summarizeNotes()` → takes array of {id, comment, imageDataURL} objects
- `ai.generateCombinedPrompt()` → takes same array, returns single text prompt
- `db.getClip(id)` → returns full clip object with all metadata
- `notifyMainWindow()` → sends IPC event to renderer
- `addAuditEntry()` → logs action to audit ledger

**Recommendation: Proceed with feature implementation.** Duplication identified above should be extracted as part of this feature's implementation:

1. Create `src/workflow-reader.js` module (consolidate api-server.js + main.js workflow reads)
2. Extract `imageWithCompression(clipId)` helper in main.js (used by both existing handlers and new send-to-ide)
3. Consider extracting `saveClipWithRules()` helper if new send-to-ide endpoint needs to save clips, but may defer to future pass if not immediately needed

No blocking issues; no dead code conflicts; no orphaned imports to address.

## 2026-05-08 — Workspace Register Toast + VS Code Extension

**Existing Toast/Notification Patterns:**
- Simple non-blocking toast already implemented in `renderer/index.js` (lines 160–170): `showToast(msg)` creates/reuses `#huminloop-toast` div, adds `.show` class, auto-hides after 2.5s
- CSS styling in `renderer/index.css` (lines 1599–1622): positioned bottom-right, fade in/out transition
- Toast is currently used for "Prompt copied to clipboard" event only
- **No modal or confirmation-dialog pattern exists** — project creation uses modeless overlay dialogs (dialog.classList.toggle) with inline buttons
- **Recommendation:** Extend existing `showToast()` to support multi-button layouts (Register/Not now/Don't ask), or create a simple non-blocking banner component alongside toast if a richer UI is needed

**Existing Project Creation Logic:**
- Single unified flow: `createProject()` IPC handler (main.js:1005–1011) → `db.createProject(data)` → `rules.invalidateCache()` → `notifyMainWindow('projects-changed')`
- Same flow used by: renderer "Add project" button (renderer/index.js:1576) + HTTP API `POST /api/projects` (api-server.js:251–257)
- Both normalize `repo_path` via `normalizeRepoPath()` function (deduped in api-server.js, also in main.js)
- **No drag-and-drop, import, or proposal flow exists yet**
- **Recommendation:** Route `POST /api/workspace/propose` through the same creation pipeline — normalize path, call `db.createProject()`, trigger rules/notify

**Settings Array Storage Patterns:**
- Arrays stored in DB settings as objects with wrapper keys: `{ entries: [...] }` for `audit_log` (main.js:1447–1449), `{ enabled: [], custom: [...] }` for `prompt_blocks` (main.js:1406)
- Retrieval: `await db.getSettings('audit_log')` returns the object, then `.entries` accessed
- **Recommendation:** `ignored_workspace_paths` should follow pattern: `await db.saveSetting('ignored_workspace_paths', { paths: [...] })` for consistency

**Dead Code & Redundancy:**
- No dead code identified in files that will touch new feature (api-server.js, main.js, mcp-server/index.js, renderer/index.js)
- Image load-and-compress pattern duplicated in 6+ places (flagged in 2026-04-06 audit) but unrelated to this feature
- MCP `git()` function duplicated in mcp-server (flagged in 2026-04-23 audit) but unrelated

**IPC Handler Patterns:**
- Dominant pattern: `ipcMain.handle` for request/response (all create/update/get operations use this)
- Minor pattern: `ipcMain.on` for fire-and-forget window controls (close, minimize, etc.)
- **New `workspace-proposed` event:** use `notifyMainWindow('workspace-proposed', { root, name })` to push to renderer (matches pattern of `clips-changed`, `projects-changed`)
- **New IPC handler** (`propose-workspace`) should use `ipcMain.handle` for consistency

**MCP Server Session State:**
- Existing pattern: `_cachedProject` (module-level variable, undefined until first match, cached for session lifetime) at mcp-server/index.js:64–71
- `matchProject()` caches result after first call, no debounce needed (called per tool invocation, lightweight lookup)
- **Recommendation:** For propose-once-per-session logic, add similar pattern: `let _proposedPaths = new Set(); if (_proposedPaths.has(PROJECT_ROOT)) return;` before calling propose endpoint

**API/IPC Handler Consistency:**
- All POST operations that create state have mirrors in both api-server.js and main.js (projects, clips, categories, settings)
- Pattern: main.js handler → db call → invalidateCache/notifyMainWindow; api-server.js endpoint → same db call → same cache/notify
- **New endpoints must follow this:** both `POST /api/workspace/propose` (api-server.js) and `propose-workspace` (main.js) should call same `db.createProject()` path after deduplication check

**Recommendations:**

1. **Extend existing toast:** modify `showToast()` signature to accept optional action buttons, or create sibling `showActionToast(msg, actions)` using same #huminloop-toast element
2. **Reuse project creation:** `POST /api/workspace/propose` → `normalizeRepoPath()` + validate → `db.createProject()` (no new logic)
3. **Settings storage:** `ignored_workspace_paths` as `{ paths: [...] }` wrapped object; retrieve with `settings.ignored_workspace_paths?.paths || []`
4. **IPC naming:** use `propose-workspace` handler (not `workspace-propose`) to match verb-noun convention of other handlers (e.g., `create-project`)
5. **Renderer listener:** add `window.quickclip.onWorkspaceProposed((root, name) => ...)` in preload.js; render toast in renderer
6. **MCP debounce:** add module-level `let _proposedThisSession = new Set()` at mcp-server top, check before calling propose endpoint once per PROJECT_ROOT

No blocking issues. Feature can reuse existing project creation, settings storage, and toast infrastructure.

## 2026-05-08 — Deploy/Update Script

**Existing Launch/Restart/Deploy Scripts:**
- `scripts/launch.js` (21 lines) — Node.js wrapper that unsets `ELECTRON_RUN_AS_NODE` (injected by VS Code/Claude Code) and spawns Electron with optional `--dev` flag setting `HUMINLOOP_DEV=1`
- No existing bash deploy/restart script found in `/scripts/`, `/workflow/`, or `/.ai-workflow/`
- Closest workflow health check: `.ai-workflow/scripts/ensure-workflow.sh` validates installed deps (Node, Python, Docker, inotifywait, tmux), but does not kill/relaunch the app

**OS Detection Patterns:**
- Codebase uses `process.platform` (Node.js convention): `window-info.js` checks `process.platform === 'win32'` and `process.platform === 'linux'`; `main.js` uses same pattern for Windows-specific startup logic
- Workflow scripts use `uname -s` (POSIX/bash standard): `workflow/scripts/` (audit-watch.sh, builder-status.sh, post-commit-audit.sh) all check `uname -s` for Linux vs macOS branching
- New deploy.sh should follow bash convention: `uname -s` for Linux/macOS detection, `[[ "$OSTYPE" == *"msys"* ]]` for Windows/Git Bash

**Process Kill Patterns:**
- No existing Electron process killing found in scripts or hooks
- `main.js` has `app.quit()` handlers (lines 170, 657, 1903) but these are graceful exits
- New script will use `pkill -f "electron|node.*launch.js"` (portable across bash/WSL/Git Bash)

**package.json script naming:**
- Current entries: `start`, `dev`, `build`, `build:win`, `build:linux`, `build:mac`, `pack`, `postinstall`
- `deploy` is clean — no clash; sits logically between `dev` and `build:*` commands

**Native Dependency / First-Run Install Patterns:**
- README.md documents platform-specific build tools under "Platform-specific build tools" (Windows/Linux/macOS); no script currently validates these
- `better-sqlite3` failures documented in README; app shows fallback error (lines 1902-1904 main.js)
- `.ai-workflow/scripts/ensure-workflow.sh` validates Node.js, Python, Docker, inotify-tools, tmux — but not C++ build tools

**Dead/Duplicated Launchers:**
- No duplicate or dead launch scripts identified; skip `renderer/lite-index.*` (separate cleanup tracked in 2026-04-09 audit)

**Recommendations:**
1. Reuse `scripts/launch.js` via `npm run dev` — do not re-implement electron spawning
2. Use bash `uname -s` for OS detection (match existing workflow script convention)
3. Add pre-install checks for platform-specific build tools (Visual Studio Build Tools, `build-essential`, Xcode CLI), matching README guidance
4. Single `pkill -f "electron|node.*launch\.js"` command for process killing
5. Extend `.ai-workflow/scripts/ensure-workflow.sh` to include C++ build tool checks in future
6. Keep npm script minimal: `"deploy": "bash scripts/deploy.sh"`
