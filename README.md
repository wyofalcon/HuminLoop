# Sciurus! — AI-Powered Knowledge Capture

**Sciurus** (Latin: *squirrel*) — also meaning *shadow* and *tail*.

Built by someone with ADHD who needed a way to stash knowledge mid-task
without losing the thread. Like a squirrel burying acorns before darting
to the next tree, Sciurus lets you capture what's on your screen in one
quick motion — screenshot, note, done — and trust that AI will sort it
for you later. The shadow-tail meaning fits too: every idea casts a
shadow you'll want to find again, and this tool is the tail that
follows your train of thought so you don't have to.

### Made for developers who build with AI

When you're using AI-assisted coding tools to debug and build, you
often hit multiple issues in rapid succession — a broken layout here,
a failed API call there, an edge case you'll forget by the time you
fix the first thing. Sciurus was built for exactly this. Screenshot
each issue as you find it, add a quick note, and keep moving. The AI
organizes everything behind the scenes so you can circle back later
with a clean list instead of a foggy memory. Especially useful when
you're working from a laptop with a single screen and can't afford
to context-switch between your app, your terminal, and a notes doc.

## How It Works

1. Press `Ctrl+Shift+Q` (or your MX Master button)
2. Capture popup appears with screenshot preview
3. **Window context auto-captured** — active window title + process name grabbed before the popup opens
4. Type a quick note, optionally pick a category + project
5. **Rule engine runs first** — auto-matches project by repo path and window title
6. **AI fallback** — Gemini 2.5 Flash analyzes the screenshot + note if rules didn't categorize
7. Browse, search, and manage clips in the tabbed notes viewer

## Features

- **Clipboard watcher** — auto-detects new screenshots (1s polling)
- **Window metadata capture** — grabs active window title + process name via Win32 API (Windows) or xdotool/gdbus (Linux)
- **Rule-based categorization** — auto-assign projects by repo path, custom pattern rules with priority
- **Gemini vision AI** — analyzes screenshots + notes for smart categorization (optional)
- **Markup color semantics** — red = bug, green = approved, pink = question (AI reads your annotations)
- **AI search** — natural language search across all clips
- **1-click project summarization** — generates actionable AI fix prompts for all project notes in a side-by-side panel with copy-all
- **Summarize tracking** — notes darken progressively each time they're included in a summary, with a counter badge showing how many times
- **Inline AI prompts** — AI-generated fix prompts and summaries shown directly on clip cards with one-click copy to clipboard
- **Per-clip AI retrigger** — manually re-run AI categorization on any clip
- **Complete/Trash system** — mark notes as done (keep visible or trash), with restore from trash
- **Tag management** — add/remove tags per clip from existing tags or create new ones, filter by tag in sidebar
- **Sorting** — sort notes by newest, oldest, or tag A-Z
- **Dual database backend** — PostgreSQL (Docker) for power users, SQLite (built-in) for zero-setup
- **Disk-based image storage** — screenshots saved to filesystem, not bloating the database
- **Project organization** — group clips by project with dedicated views
- **General Notes + Projects tabs** — tabbed interface for organized browsing
- **System tray** — runs quietly in background
- **Threaded comments** — add follow-up notes to any clip
- **Setup wizard** — 3-step first-run flow: database, AI config, launch
- **Settings panel** — configure capture, AI, and app behavior in-app
- **Cross-platform** — Windows, Linux (AppImage, deb), macOS (dev supported)

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 18+ (22 recommended) | [nodejs.org](https://nodejs.org) or use `nvm` / `fnm` |
| **npm** | 9+ | Comes with Node.js |
| **Git** | 2.x | [git-scm.com](https://git-scm.com) |
| **Docker** | 20+ (optional) | Only needed for PostgreSQL backend |
| **Python** | 3.x (optional) | Required by `node-gyp` for native module compilation on some systems |

### Platform-specific requirements

<details>
<summary><strong>Windows</strong></summary>

- **Build tools** — needed to compile `better-sqlite3` (native module):
  ```powershell
  # Option A: Visual Studio Build Tools (recommended)
  winget install Microsoft.VisualStudio.2022.BuildTools

  # Option B: Via npm (installs automatically)
  npm install --global windows-build-tools
  ```
- **PowerShell** — pre-installed. Used for active window capture (Win32 API via P/Invoke). No configuration needed.
- **Docker Desktop** — install from [docker.com](https://www.docker.com/products/docker-desktop/) if using PostgreSQL.

</details>

<details>
<summary><strong>Linux (Ubuntu/Debian)</strong></summary>

- **Build tools** — needed to compile native modules:
  ```bash
  sudo apt update
  sudo apt install build-essential python3 libsqlite3-dev
  ```
- **Window metadata capture** — for auto-categorization by active window:
  ```bash
  # X11 / WSLg (recommended)
  sudo apt install xdotool

  # Wayland + GNOME — works automatically via gdbus (no extra install)
  ```
  Without `xdotool`, the app still works — you just won't get automatic project matching from window titles.
- **Docker Engine** — install from [docs.docker.com](https://docs.docker.com/engine/install/) if using PostgreSQL.

</details>

<details>
<summary><strong>macOS</strong></summary>

- **Xcode Command Line Tools** — needed for native module compilation:
  ```bash
  xcode-select --install
  ```
- **Docker Desktop** — install from [docker.com](https://www.docker.com/products/docker-desktop/) if using PostgreSQL.
- **Note:** Window metadata capture is not yet implemented on macOS. The app works fully, but auto-categorization by window title is unavailable.

</details>

---

## Setup

### Quick start (new users)

```bash
git clone https://github.com/wyofalcon/sciurus.git
cd sciurus
npm install
npm start
```

The **setup wizard** launches automatically on first run and walks you through:
1. Detect Docker or offer the built-in SQLite database (no Docker needed)
2. Help you set up AI (optional — free Gemini API key or GCP Vertex AI)
3. Launch the app

### Development mode

```bash
npm run dev
```

This sets `SCIURUS_DEV=1`, which auto-opens DevTools on launch.

---

## Database Setup

### Option A: SQLite (zero setup)

No Docker, no config. Set in `.env` or just skip Docker — the app falls back automatically:

```bash
DB_BACKEND=sqlite
```

The database file is stored at `{userData}/sciurus.db`:
- **Windows:** `%APPDATA%/sciurus/sciurus.db`
- **Linux:** `~/.config/sciurus/sciurus.db`
- **macOS:** `~/Library/Application Support/sciurus/sciurus.db`

### Option B: PostgreSQL (Docker)

```bash
docker compose up -d
```

This starts PostgreSQL 16 Alpine (`sciurus-db`) on **port 5433** (not the default 5432, to avoid conflicts). Data persists in a Docker volume.

Default connection (no `.env` changes needed):
| Setting | Value |
|---|---|
| Host | `localhost` |
| Port | `5433` |
| Database | `sciurus` |
| User | `sciurus` |
| Password | `sciurus_dev` |

To use a custom password:
```bash
# In .env or as an environment variable before starting Docker
POSTGRES_PASSWORD=your_secure_password
```

The `docker/init.sql` script runs automatically on first container start and creates all tables, indexes, triggers, and seed data.

---

## AI Setup (Optional)

AI features are optional. The rule engine handles most categorization without AI.

### Option A: Gemini API Key (recommended — free tier)

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create an API key
3. Add to `.env`:
   ```bash
   AI_AUTH_MODE=apikey
   GEMINI_API_KEY=AIzaSy...
   ```

### Option B: Vertex AI (GCP service account)

1. Enable the Vertex AI API on your GCP project
2. Create a Service Account with the "Vertex AI User" role
3. Download the JSON key and save as `credentials.json` in the project root
4. Add to `.env`:
   ```bash
   AI_AUTH_MODE=vertex
   ```

The app uses native JWT auth for Vertex AI — no heavy Google SDK dependencies.

---

## Environment Variables

Copy the example file and customize:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `DB_BACKEND` | `auto` | `pg`, `sqlite`, or `auto` (tries pg then sqlite) |
| `POSTGRES_HOST` | `localhost` | PostgreSQL host |
| `POSTGRES_PORT` | `5433` | PostgreSQL port |
| `POSTGRES_DB` | `sciurus` | PostgreSQL database name |
| `POSTGRES_USER` | `sciurus` | PostgreSQL user |
| `POSTGRES_PASSWORD` | `sciurus_dev` | PostgreSQL password |
| `AI_AUTH_MODE` | `auto` | `apikey`, `vertex`, or `auto` |
| `GEMINI_API_KEY` | — | Gemini API key (for `apikey` mode) |
| `HOTKEY_COMBO` | `ctrl+shift+q` | Global hotkey for capture |
| `SCIURUS_DEV` | — | Set to `1` to open DevTools on launch |

---

## Building

### Windows installer (.exe)

```bash
npm run build:win
```

### Linux (AppImage + .deb)

```bash
npm run build:linux
```

### macOS (.dmg)

```bash
npm run build:mac
```

> **Note:** Window metadata capture is not yet implemented on macOS. All other features work.

### All platforms

```bash
npm run build
```

### Pack without installer (for testing)

```bash
npm run pack
```

Build output goes to `dist/`.

> **Note:** You must build on the target platform. Cross-compilation is not supported due to native modules (`better-sqlite3`).

---

## Categorization Priority Chain

When you save a clip, Sciurus tries to categorize it in this order:

1. **Your manual selection** — always wins
2. **Repo path auto-match** — if the window title contains a project's repo folder name
3. **Window rules** — custom pattern matching on window title or process name
4. **AI fallback** — Gemini analyzes the screenshot + note + window context

Most clips get categorized instantly by rules 2-3, no AI call needed.

---

## Project Structure

```
sciurus/
├── src/
│   ├── main.js          # Electron main process — tray, hotkey, IPC, capture flow
│   ├── preload.js       # Context bridge for renderer (contextIsolation: true)
│   ├── db.js            # Database switcher (PostgreSQL or SQLite)
│   ├── db-pg.js         # PostgreSQL backend (pg)
│   ├── db-sqlite.js     # SQLite backend (better-sqlite3)
│   ├── ai.js            # Gemini AI — categorize, search, summarize (native JWT auth)
│   ├── rules.js         # Rule-based categorization engine with in-memory cache
│   ├── window-info.js   # Cross-platform active window capture (Win32/xdotool/gdbus)
│   └── images.js        # Disk-based image storage + AI compression
├── renderer/
│   ├── index.html/js/css   # Main window — tabbed notes viewer, project summaries
│   ├── capture.html/js/css # Capture popup — screenshot preview + note input
│   └── setup.html/js/css   # First-run setup wizard
├── scripts/
│   ├── launch.js        # Electron launcher (fixes ELECTRON_RUN_AS_NODE in VS Code shells)
│   └── get-window.ps1   # Windows PowerShell window info script (auto-generated)
├── docker/
│   └── init.sql         # PostgreSQL schema, indexes, triggers, seed data
├── assets/              # App icons (icon.ico, icon.png)
├── docker-compose.yml   # PostgreSQL 16 Alpine container
├── .env.example         # Example environment config
├── .env                 # Your config (git-ignored)
├── credentials.json     # Google service account key (git-ignored)
└── package.json
```

## Architecture

| Layer | Technology | Notes |
|---|---|---|
| **Runtime** | Electron 33 | Context-isolated renderers, no `nodeIntegration` |
| **Database** | PostgreSQL 16 or SQLite | Auto-detected; migrations run on startup |
| **Image Storage** | Filesystem | `{userData}/images/{clipId}.png`; compressed to JPEG for AI calls |
| **AI** | Gemini 2.5 Flash | API key or Vertex AI with native JWT (zero SDK deps) |
| **Rules** | In-memory | Window title + process name matching, regex support, 5-min cache |
| **Window Info** | OS-native | Win32 P/Invoke, xdotool (X11), gdbus (Wayland+GNOME) |
| **Build** | electron-builder | NSIS (Windows), AppImage + deb (Linux), dmg (macOS) |

### Security & Robustness

- **Context-isolated renderers** — `contextIsolation: true`, no `nodeIntegration`
- **Input sanitization** — `.env` writes validate key format and strip newlines to prevent injection
- **API timeouts** — 30-second abort on all Gemini API calls to prevent hangs
- **Safe JSON parsing** — database row parsing wrapped in try-catch with fallback defaults
- **Guarded async** — background AI calls include `.catch()`, concurrent search requests deduplicated

---

## Troubleshooting

### `npm install` fails on `better-sqlite3`

This is a native module that needs C++ compilation:
- **Windows:** Install Visual Studio Build Tools (`winget install Microsoft.VisualStudio.2022.BuildTools`)
- **Linux:** Run `sudo apt install build-essential python3`
- **macOS:** Run `xcode-select --install`

Then retry `npm install`.

### App launches as plain Node.js (no window)

VS Code and Claude Code terminals set `ELECTRON_RUN_AS_NODE=1`. The launch script (`scripts/launch.js`) automatically unsets this, but if you're running Electron directly:

```bash
# Use the launch script instead
npm start

# Or unset manually
unset ELECTRON_RUN_AS_NODE && npx electron .
```

### Docker database won't connect

```bash
# Check if the container is running
docker ps --filter name=sciurus-db

# Check health
docker inspect sciurus-db --format "{{.State.Health.Status}}"

# View logs
docker logs sciurus-db

# Restart
docker compose down && docker compose up -d
```

Default port is **5433** (not 5432). Check your `.env` matches.

### Window capture not working (Linux)

```bash
# Install xdotool for X11 / WSLg
sudo apt install xdotool

# Verify it works
xdotool getactivewindow getwindowname
```

On Wayland + GNOME, `gdbus` is used automatically. Other Wayland compositors are not yet supported.

### AI not categorizing

1. Check that credentials are configured: look for `[AI] Gemini API key ready` or `[AI] Vertex AI ready` in the terminal
2. Verify `.env` has `AI_AUTH_MODE` and either `GEMINI_API_KEY` or `credentials.json`
3. The AI bar in the main window shows categorization status
4. AI is optional — the rule engine and manual categorization work without it

---

## Tip: One-Button Capture

Sciurus works best when capturing is effortless — one press, no thinking.
Map `Ctrl+Shift+Q` to a spare mouse button or macro key so you can stash
a thought without breaking flow. Works great with PowerToys Zoom Draw
for annotating screenshots with colored markers before capture.

---

## License

Private project. All rights reserved.
