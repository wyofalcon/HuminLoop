# Pre-Feature Audit Log

## 2026-04-04 — Sciurus Lite Mode

- **Workflow file reading duplicated** between main.js IPC handlers and api-server.js (~50 lines). New `workflow-context.js` covers external projects; Sciurus's own reads should migrate to it over time.
- **Clip save flow duplicated** between main.js `save-clip` handler and api-server.js `POST /api/clips` (~35 lines). Should extract to a shared function.
- **`get-setting` (singular) IPC handler** appears unused — all renderers call `getSettings()` (plural). Safe to remove.
- **`archived` column** still present but soft-delete uses `deleted_at` instead. Low priority cleanup.
- Overlay, toolbar, preload patterns are clean — no duplication or dead code found in files touched by lite mode.
- Recommendation: None of these block lite mode implementation. Address workflow read consolidation and save-flow dedup in a future cleanup pass.

## 2026-04-03 — Workflow Context Reader utility module

- `main.js` and `api-server.js` both contain inline `.ai-workflow` path reads (duplicated pattern) — new module targets a different use case (arbitrary repoPath) so no refactor needed now, but future callers should use `workflow-context.js` instead of reimplementing
- No existing `workflow-context.js` or equivalent utility found — new file is net-new, no dead code risk
- Recommendation: over time, refactor Sciurus's own workflow reads in `main.js` and `api-server.js` to use a `hasWorkflow('.')` call from this module for consistency

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
