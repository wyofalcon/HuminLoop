# Sciurus Lite Mode Design

## Overview

Add a "Lite" mode to Sciurus — a stripped-down, single-clip-at-a-time UI focused on fast iteration during active development. The user annotates a screenshot (freehand drawing + text in red/green/pink), types a short note, and the app generates a single actionable coding prompt via AI. One clip displayed at a time, with prev/next navigation through a history of lite clips.

Lite mode lives inside the same Electron app as Full mode. A tray menu toggle switches between them.

## Mode Switching

- **Setting:** `app_mode` key in DB settings table. Values: `"full"` (default) or `"lite"`.
- **Toggle:** Tray menu item: "Switch to Lite Mode" / "Switch to Full Mode".
- **Behavior on toggle:**
  1. Save `app_mode` to DB
  2. Close the current main window
  3. Open the new main window with the appropriate HTML (`index.html` or `lite-index.html`)
  4. Subsequent capture window opens use the matching variant (`capture.html` or `lite-capture.html`)
- **Tray menu in lite mode:** Open Sciurus, Quick Capture, Show Toolbar, Switch to Full Mode, Quit.

## New Renderer Files

Approach B: separate renderer files for lite mode, sharing all main process modules.

```
renderer/
  lite-index.html      — lite main window markup
  lite-index.js        — lite main window logic (~300-400 lines)
  lite-index.css       — lite main window styles
  lite-capture.html    — lite capture popup markup
  lite-capture.js      — lite capture logic (~150 lines)
  lite-capture.css     — lite capture styles
```

Shared (no changes needed for lite): `toolbar.html/js/css`, `overlay.html/js/css`, `setup.html/js/css`.

Shared modules (main process): `db.js`, `db-pg.js`, `db-sqlite.js`, `ai.js`, `rules.js`, `images.js`, `preload.js`, `api-server.js`, `window-info.js`.

## Main Process Changes (`src/main.js`)

- `createMainWindow()` checks `app_mode` setting and loads `lite-index.html` or `index.html`.
- `createCaptureWindow()` checks `app_mode` and loads `lite-capture.html` or `capture.html`.
- New IPC handler: `toggle-app-mode` — flips the setting, closes main window, opens the correct one.
- When saving a clip in lite mode, sets `source: 'lite'` on the clip record.
- Tray menu rebuilds on mode switch to reflect the current mode's options.

## Database

### New column: `source`

Add a `source` TEXT column to the `clips` table. Default: `'full'`.

- **Lite mode queries:** `WHERE source = 'lite' AND deleted_at IS NULL`
- **Full mode queries:** No filter on `source` — sees all clips (full + lite)
- Existing clips get `'full'` via `COALESCE` / default value — no migration needed for existing data.
- Both `db-pg.js` and `db-sqlite.js` get the column addition.

### Lite clip fields

When a clip is saved in lite mode, it populates:

| Field | Value |
|-------|-------|
| `comment` | User's typed note |
| `image` | Screenshot (same disk storage as full) |
| `source` | `'lite'` |
| `window_title` | Auto-captured from active window |
| `process_name` | Auto-captured from active window |
| `category` | `'Uncategorized'` (no picker in lite) |
| `project_id` | From `lite_active_project` setting (see Active Project section) |

## Active Project & Workflow Context

Lite mode is project-focused. The user sets an active project, and the AI uses that project's context (including the AI dev workflow session) to generate better prompts.

### Active Project Setting

- **Setting:** `lite_active_project` key in DB settings — stores the `project_id` of the active project.
- **UI location:** The lite main window title bar area includes a project selector dropdown. Shows project name + color dot. Persists across sessions — set once, use until changed.
- **On first launch of lite mode:** If no active project is set, prompt the user to pick or create one before they can capture.
- **All lite clips** get `project_id` set to the active project automatically.

### Workflow Context Enrichment

This is the first connection between the AI dev workflow system and the app's AI module. Currently the workflow tab is display-only — lite mode changes that.

**What gets fed into the AI prompt:**

1. **Project metadata** — `name`, `description`, `repo_path` from the projects table
2. **Session context** — contents of `.ai-workflow/context/SESSION.md` (current branch, recent commits, in-progress work). Read from disk at prompt generation time.
3. **Audit findings** (if available) — contents of `.ai-workflow/context/AUDIT_LOG.md`, so the AI knows about recently flagged code quality issues.

**How it works:**

- When `autoCategorize()` runs with `lite: true`, it reads `SESSION.md` from the active project's `repo_path` (i.e., `{repo_path}/.ai-workflow/context/SESSION.md`).
- If the file exists, its contents are included in the prompt template as session context.
- If the file doesn't exist (project doesn't use the AI dev workflow), the prompt works without it — graceful degradation.
- Same approach for `AUDIT_LOG.md` — included if present, skipped if not.

**Why this matters:** Instead of the AI seeing just "a screenshot with annotations," it knows:
- What project the developer is working on
- What branch they're on
- What they recently committed
- What's currently in progress
- What code quality issues were recently flagged

This produces dramatically more specific and useful prompts.

### Design Note: Active Project as a System-Wide Pattern

The "active project with workflow context" concept is not lite-specific — it's a general-purpose pattern that will extend to full mode in the future. The architecture should reflect this:

- **Lite mode (this spec):** Single active project, mandatory. All lite clips go to it. Workflow context feeds AI prompt generation.
- **Full mode (future):** Users can still capture notes to any project freely. But one (or eventually multiple) projects can be designated as "active" — meaning they get the AI dev workflow bridge features (session context in prompts, workflow-aware AI enrichment, etc.). Clips to non-active projects work exactly as they do today.
- **Implementation approach:** Build the workflow context reading logic (`readSessionContext(repoPath)`, `readAuditFindings(repoPath)`) as standalone functions in a shared location — not embedded in the lite codepath. Lite mode calls them first, but full mode will reuse them when the bridge is extended.

This means `lite_active_project` is really just the first use of a broader `active_projects` concept. For this spec, we keep it simple (one project, lite-only), but the code should not be structured in a way that makes the future extension difficult.

## Lite Capture Popup

Minimal UI — three elements only:

1. **Screenshot preview** — shows the captured image with any toolbar/overlay annotations baked in
2. **Note textarea** — placeholder: "What needs to change?" — optional but encouraged
3. **"Save & Generate Prompt" button** — saves clip, triggers AI prompt generation, closes popup

No category picker, no project picker, no tags, no thread/comments.

Window size: ~340x420 (smaller than full capture's 460x580).

## Lite Main Window

Stacked single-card layout, compact window (~450x600).

From top to bottom:

1. **Title bar** — "Sciurus Lite" label, active project selector dropdown (name + color dot), clip position indicator ("3 of 12"), settings gear icon
2. **Screenshot preview** — large, shows the annotated screenshot
3. **Note** — the user's typed note, read-only display
4. **Generated Prompt** (hero element) — the AI-generated prompt in a styled block with a prominent "Copy" button. Cyan accent color, left border highlight.
5. **Navigation** — prev/next arrows with a "3 of 12" position counter at the bottom

### States

- **Prompt generating:** Show a subtle loading indicator in the prompt area while AI processes.
- **Prompt ready:** Show the full prompt with copy button.
- **AI unavailable:** Show the user's note text in the prompt area with a label: "AI unavailable — showing your note".
- **No clips:** Empty state with a message: "Take a screenshot to get started" and the hotkey reminder.

## Toolbar & Overlay (Shared)

The existing toolbar and overlay are available in lite mode — same windows, same behavior. The toolbar's color dots (red/green/pink) and draw mode work identically.

### New Feature: Text Tool

Add a text annotation tool to the overlay, activated from the toolbar.

**Toolbar change:**
- Add a `T` button alongside the three color dots.
- Clicking `T` enters text mode. The button shows an active state (same as color dot active states).
- Clicking a color dot while in text mode keeps text mode active but changes the text color.

**Overlay text mode behavior:**
- Click anywhere on the overlay canvas to place a text cursor at that position.
- A blinking cursor appears. User types freely.
- Text renders in the active color (red/green/pink) in monospace font, ~16px, with a subtle dark outline/shadow for readability on any background.
- **Enter** commits the text to the canvas and returns to freehand draw mode.
- **Escape** cancels without placing text and returns to freehand draw mode.
- **Backspace** deletes characters while typing.
- Single-line only — no multi-line text blocks.
- After commit, the text is rasterized onto the draw canvas (same as freehand strokes).

**Keyboard shortcut:** `T` key in draw mode toggles text mode (matches `1`/`2`/`3` for colors, `S` for snippet).

## AI Prompt Generation (Lite Mode)

Lite mode uses `ai.js` with a dedicated prompt template focused on a single output: an actionable coding prompt.

### Prompt Template

```
You are analyzing a screenshot with colored annotations from a developer.
The annotations follow this color coding:
- RED markings (circles, crosses, text): Remove, delete, or fix what is marked
- GREEN markings (circles, highlights, text): Add or create something at this location
- PINK/PURPLE markings (circles, highlights, text): Reference point — the user is
  identifying or pointing out this element for context. It may or may not need changes.

The developer's note: "{user_note}"
Window context: {process_name} — {window_title}

Project: {project.name}
Repository: {project.repo_path}
Project description: {project.description}

{if session_context}
Current development session context:
{session_context}
{/if}

{if audit_findings}
Recent code audit findings:
{audit_findings}
{/if}

PRIORITY: The developer's written note is the primary source of intent. If the note
clarifies, overrides, or adds nuance to what the color annotations suggest, follow
the note. Annotations are also expressions of intent and should be treated as
instructions — but when the note and annotations conflict, the note wins.

Use the project context and session information to generate a more specific and
relevant prompt. Reference the current branch, recent work, and known issues
where they relate to what the annotations and note describe.

Generate a single, specific, actionable prompt that a coding AI could execute
directly. Be concrete about what to change based on the annotations and note.
Reference pink-marked elements as context when relevant. Output only the prompt,
no explanation.
```

### Behavior

- Triggered automatically after clip save (same async pattern as full mode's `autoCategorize`).
- Only generates `aiFixPrompt` — skips category, project, tags, summary, URL extraction.
- The `autoCategorize` function in `ai.js` gets a `lite: true` flag to switch templates.
- On completion, emits `clips-changed` so the lite main window updates with the prompt.
- 30-second abort timeout (same as full mode).

### Priority Hierarchy for Prompt Interpretation

1. **User's typed note** — highest authority. Overrides annotation interpretation when conflicting.
2. **Colored annotations** — default intent (red = remove, green = add, pink = reference). Treated as instructions unless the note says otherwise.
3. **Pink annotations specifically** — default to "reference/identify" but if the user uses pink for everything or the note gives pink a different meaning, follow the note's lead.

## Preload Surface

`preload.js` exposes the same API surface. Lite renderers use a subset:

**Used by lite:**
- `getClips()` — main process checks `app_mode` setting and automatically applies `WHERE source = 'lite'` filter when in lite mode; renderer doesn't pass a filter
- `saveClip()` — main process checks `app_mode` and automatically sets `source: 'lite'` on the clip; renderer doesn't need to pass it
- `getClipImage()`
- `copyImageToClipboard()`
- `getSettings()` / `saveSetting()`
- `onClipsChanged` / `onScreenshot`
- `closeCapture()` / `hideMain()`
- `enterDrawMode()` / `exitDrawMode()` / `takeSnippet()`
- `toggleAppMode()` — new

**Not used by lite (but still available for full mode):**
- AI config (prompt blocks, retrigger)
- Workflow handlers
- Trash management (complete/uncomplete/restore/permanent delete)
- Window rules
- Clip comments/threads

## What Does NOT Change

- Full mode is completely untouched — all existing UI, behavior, and features remain as-is.
- Database schema is additive only (new `source` column with default).
- Toolbar and overlay code shared as-is (text tool is additive).
- AI module shared — lite uses a different prompt path and adds workflow context reading, but the existing full-mode codepath is untouched.
- HTTP API and MCP server unchanged — they continue to serve all clips regardless of source.
- Setup wizard unchanged — runs once on first launch regardless of mode.
