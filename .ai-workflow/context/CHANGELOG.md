# Change Log

> Tracks every significant code change with **what** changed, **why** it was needed, and **alternatives** considered.

## Format

```
### CHG-XXX — Short title
**Commits:** `hash1`, `hash2`
**Files changed:**
  - Modified: `path/to/file.js`
  - Added: `path/to/new-file.js`
  - Removed: `path/to/deleted-file.js`
**What:** What was changed
**Why:** Why this change was needed — the root cause or motivation
**Alternatives:** Other approaches considered and why they were/weren't chosen
**Status:** Applied | Reverted | Superseded by CHG-XXX
```

---

## 2026-03-30

### CHG-001 — Bootstrap AI dev workflow for Windows
**Commits:** (pending)
**Files changed:**
  - Added: `.ai-workflow/instructions/SHARED.md`
  - Added: `.ai-workflow/instructions/ARCHITECT.md`
  - Added: `.ai-workflow/instructions/BUILDER.md`
  - Added: `.ai-workflow/instructions/REVIEWER.md`
  - Added: `.ai-workflow/instructions/SCREENER.md`
  - Added: `.ai-workflow/context/SESSION.md`
  - Added: `.ai-workflow/scripts/ensure-workflow.sh`
  - Added: `.ai-workflow/scripts/show-status.sh`
  - Added: `.ai-workflow/scripts/compose-instructions.sh`
  - Copied: `.ai-workflow/scripts/prompt-tracker.sh`
  - Copied: `.ai-workflow/scripts/toggle-relay-mode.sh`
  - Copied: `.ai-workflow/scripts/toggle-audit-watch.sh`
  - Installed: `.git/hooks/prepare-commit-msg`
  - Modified: `.gitignore`
  - Modified: `CLAUDE.md`
**What:** Compiled agent instruction templates with Sciurus-specific architecture, component labels, conventions, and gotchas. Created Windows/Git Bash compatible workflow scripts (no tmux, no inotifywait). Installed prepare-commit-msg hook.
**Why:** The `workflow/` directory contained generic Linux/tmux templates from the cvstomize project. Sciurus runs on Windows — needed compiled instructions with project-specific values and scripts that work in Git Bash without WSL.
**Alternatives:** Could have used WSL for the full Linux workflow, but that adds friction. Adapted the essential scripts (health check, status, prompt tracking, instruction composition) to run natively in Git Bash. Linux-only features (tmux sessions, inotifywait file watching, dashboards) left in `workflow/` for future WSL use.
**Status:** Applied
