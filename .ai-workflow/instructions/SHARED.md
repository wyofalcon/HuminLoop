# Shared Project Conventions

> All agents (Architect, Builder, Reviewer, Screener) follow these rules.

## Session Protocol

Before every task:

```bash
cat .ai-workflow/context/SESSION.md && git log --oneline -5
```

SESSION.md is auto-maintained by the prepare-commit-msg hook — never edit it manually.

## Branch Model

```
feature/your-task  →  master (PR)
```

- Always branch off `master`: `git checkout -b feature/your-task origin/master`
- Never commit directly to `master`
- Never push — the Architect handles PRs and pushes

## Architecture

- **Main process:** `src/main.js` — Electron main, tray, hotkey, IPC, clipboard watcher, HTTP API
- **Renderer:** `renderer/` — 3 windows (viewer, capture, wizard), vanilla JS, no framework
- **Modules:** `src/` — db.js (switcher), db-pg.js, db-sqlite.js, ai.js (Gemini 2.5 Flash), rules.js, images.js, api-server.js, window-info.js
- **MCP server:** `mcp-server/` — separate Node process, stdio transport, bridges Claude Code to Sciurus HTTP API
- **Workflow:** `workflow/` — templates, scripts, config for multi-agent dev orchestration
- **AI:** Gemini 2.5 Flash via API key or Vertex AI (native JWT, no SDK deps)
- **Infra:** Docker Compose (PostgreSQL 16 on port 5433), SQLite fallback, Electron 33

## Component Labels

Use these when referencing parts of the system:

| Label | Component |
|-------|-----------|
| `main` | Electron main process (`src/main.js`) |
| `viewer` | Notes viewer window (`renderer/index.*`) |
| `capture` | Screenshot capture popup (`renderer/capture.*`) |
| `wizard` | First-run setup (`renderer/setup.*`) |
| `preload` | IPC context bridge (`src/preload.js`) |
| `db` / `db-pg` / `db-sqlite` | Database layer |
| `ai` | Gemini AI module (`src/ai.js`) |
| `rules` | Categorization engine (`src/rules.js`) |
| `api` | Local HTTP REST server (`src/api-server.js`) |
| `mcp` | MCP server (`mcp-server/index.js`) |
| `wininfo` | Window metadata capture (`src/window-info.js`) |
| `images` | Disk image storage (`src/images.js`) |

## Key Files

| Purpose | File |
| ------- | ---- |
| Electron entry point | `src/main.js` |
| IPC bridge (60+ methods) | `src/preload.js` |
| DB schema (PostgreSQL) | `docker/init.sql` |
| HTTP API endpoints | `src/api-server.js` |
| MCP tool definitions | `mcp-server/index.js` |
| AI prompt blocks | `src/ai.js` (PROMPT_BLOCKS) |
| Rules priority chain | `src/rules.js` |
| Environment config | `.env` (git-ignored), `.env.example` |

## Error Handling

```
try/catch with fallback defaults on all async DB calls.
Background AI calls always include .catch() and deduplication guards.
API server returns { error: message } with appropriate HTTP status.
```

## Auth

- **App:** No user auth — single-user desktop app
- **AI:** Gemini API key or Vertex AI service account JWT (native crypto, no SDK)
- **API server:** Localhost only (127.0.0.1), no auth needed
- **DB:** Local SQLite or Docker PostgreSQL with dev credentials

## Conventions

- No npm deps for crypto, fetch, or auth — Node.js/Electron native APIs only
- `.env` loaded manually (no dotenv — their v17 broke the API)
- `sanitizeUpdates()` allowlist before any DB write
- `notifyMainWindow(channel, data)` after any state change
- `rules.invalidateCache()` after project/rule changes
- New features need 3 touchpoints: IPC handler (main.js), HTTP endpoint (api-server.js), MCP tool (mcp-server/index.js)
- HTML escaping via `esc()` / `escAttr()` for all user content in renderer

## Dev Commands

```bash
npm start                        # Launch app
npm run dev                      # Launch with DevTools
docker compose up -d             # Start PostgreSQL
npm run build:win                # Windows installer → dist/
npm run pack                     # Test build (no installer)
```

## Gotchas

1. VS Code / Claude Code shells set `ELECTRON_RUN_AS_NODE=1` — always use `npm start` or `scripts/launch.js`, never `electron .` directly
2. `renderer/index.js` is ~2000 lines (monolith) — no framework, all DOM manipulation. Read before modifying.
3. Both `db-pg.js` and `db-sqlite.js` must implement the same API surface — forgetting one breaks the other backend
4. The clipboard watcher polls every 1s — the primary capture trigger is Windows Snipping Tool (`Ctrl+Win+S`), not the hotkey
