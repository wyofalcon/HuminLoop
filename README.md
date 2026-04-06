<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="HuminLoop icon" />
</p>

<h1 align="center">HuminLoop</h1>

<p align="center">
  <strong>Keeping humans in the loop.</strong><br>
  AI-powered knowledge capture for developers who build with AI.
</p>

<p align="center">
  <a href="https://github.com/wyofalcon/huminloop/releases/latest"><img src="https://img.shields.io/github/v/release/wyofalcon/huminloop?style=flat-square&label=download" alt="Latest Release" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/AI-Gemini%202.5%20Flash-orange?style=flat-square" alt="AI" />
  <img src="https://img.shields.io/badge/electron-33-teal?style=flat-square" alt="Electron" />
  <img src="https://img.shields.io/badge/status-work%20in%20progress-yellow?style=flat-square" alt="Status: WIP" />
</p>

> **Heads up:** This project is a work in progress. I built it as a side tool while working on another project and it's been evolving fast. The pre-built executables are **untested** — building from source is the most reliable way to run it right now. Expect rough edges. Coming soon: full integration of the AI dev workflow system with smart triggers, hooks, and automated orchestration across your entire coding session.

---

## A smart note organizer that grew teeth

HuminLoop started as a simple screenshot-and-note tool. Clip something from your screen, tag it, find it later. It's still great at that — **a fast, AI-organized knowledge base** for anyone who captures a lot of visual information.

But when you're deep in an AI-assisted coding session — bouncing between Claude Code, Copilot, and your terminal — you don't just need to *remember* issues, you need to *act on them*. So it evolved.

Now HuminLoop is also the bridge between what you see on screen and what your AI coding tools need to fix it. Screenshot a bug, annotate it with colors your AI understands, and get a ready-to-paste prompt in seconds.

**Use it as a smart note organizer.** Use it as a dev workflow tool. Or both.

> Built by a developer with ADHD who needed to stop losing context every time a new issue appeared. Like a squirrel burying acorns before darting to the next tree.

---

## Download

Grab the latest release for your platform:

| Platform | Download | Format |
|----------|----------|--------|
| **Windows** | [**Download .exe**](https://github.com/wyofalcon/huminloop/releases/latest) | NSIS installer |
| **Linux** | [**Download .AppImage**](https://github.com/wyofalcon/huminloop/releases/latest) | AppImage (universal) or .deb |
| **macOS** | [**Download .dmg**](https://github.com/wyofalcon/huminloop/releases/latest) | Disk image |

> **No Node.js required.** Download, install, run. The setup wizard handles everything else.
>
> **Note:** Pre-built executables are untested and may have issues. Building from source (below) is recommended for now.
>
> **The app is not code-signed.** Your OS will show a security warning on install:
> - **Windows:** "Windows protected your PC" — click **More info** then **Run anyway**
> - **macOS:** "can't be opened because it is from an unidentified developer" — go to **System Settings > Privacy & Security** and click **Open Anyway**
> - **Linux:** No warning (AppImage may need `chmod +x` to run)

Or build from source (recommended):

```bash
git clone https://github.com/wyofalcon/huminloop.git
cd huminloop
npm install
npm start
```

---

## How It Works

### Full Mode — Capture everything, let AI sort it

```
Screenshot  -->  Capture popup  -->  Rule engine auto-categorizes  -->  AI enriches in background
    ^                                     |                                     |
    |                              instant match by                    summary, tags, fix prompt,
 clipboard                       window title, repo path,              URL extraction, project
  watcher                        process name, keywords                    assignment
```

1. Take a screenshot with **Windows Snipping Tool** (`Ctrl+Win+S`) or any clipboard tool
2. HuminLoop auto-detects it, grabs the active window title + process name
3. The rule engine categorizes instantly (7 strategies, priority-ordered)
4. Gemini 2.5 Flash enriches asynchronously: summary, tags, actionable fix prompt
5. Browse, search, filter, and act on clips in the tabbed viewer

### Lite Mode — Annotate, capture, get a prompt

```
Draw on screen  -->  Take snippet  -->  Type what needs to change  -->  AI generates coding prompt
  (red/green/pink)                                                           |
                                                                    paste into Claude Code,
                                                                    Copilot, or any AI tool
```

1. Open the floating **Toolbar** (tray menu) and draw on your screen
2. Use **red** (remove/fix), **green** (add/create), **pink** (reference point)
3. Take a snippet and type what needs to change
4. AI generates an actionable coding prompt enriched with project context
5. Copy or **Send to IDE** with one click

---

## Features

### Smart Capture
- **Clipboard watcher** that auto-detects screenshots (zero interaction)
- **Window metadata capture** — knows what app and file you're looking at (Win32 API / xdotool / gdbus)
- **Global hotkey** (`Ctrl+Shift+Q`) for manual capture anytime

### AI-Powered Organization
- **7-strategy rule engine** — categorizes instantly without AI (repo path, window title, process, keywords)
- **Gemini 2.5 Flash vision** — analyzes screenshots + notes as AI fallback
- **Inline AI prompts** — every clip gets an actionable fix prompt you can copy or send to your IDE
- **Natural language search** — find any clip by describing what you remember
- **1-click project summarization** — generates a side-by-side summary panel for all project notes

### Annotation Colors
The AI understands your markup:
- **Red** = remove, delete, or fix what is marked
- **Green** = add or create something at this location
- **Pink** = reference point (context, may not need changes)

### Developer Workflow
- **Send to IDE** — stage prompts + screenshots directly to your project's `.ai-workflow/context/` directory
- **MCP Server** — 19 tools that bridge HuminLoop to Claude Code, Gemini CLI, or any MCP-compatible agent
- **Prompt filter** — filter project clips by "Prompts Built" vs "No Prompt" to focus on what's actionable
- **Sent-to-IDE tracking** — see which clips have already been sent to your AI coding tool
- **Multi-clip combine** — select multiple clips and generate a unified prompt
- **Workflow context bridge** — AI prompts enriched with current branch, recent commits, and audit findings
- **Active-in-IDE tracking** — mark which projects are currently open

### Project Management
- **Project organization** with repo path auto-matching
- **Complete/Trash system** with restore from trash
- **Tag management** — add, remove, filter by tags
- **Threaded comments** on any clip
- **Summarize tracking** — clips darken progressively each time they're summarized

### Infrastructure
- **Dual database** — PostgreSQL (Docker) for power users, SQLite (built-in) for zero-setup
- **Disk-based image storage** — screenshots on filesystem, not bloating the database
- **Local HTTP API** on port 7277 — same capabilities as the UI, for external tools
- **Cross-platform** — Windows, Linux (AppImage, deb), macOS
- **System tray** — runs quietly in background
- **Setup wizard** — guided first-run configuration

---

## Full Mode vs Lite Mode

| | Full Mode | Lite Mode |
|---|---|---|
| **Purpose** | Capture and organize everything | Fast iteration during active dev |
| **Tabs** | General Notes, Projects, Workflow, Settings, Help | Projects only |
| **Project selection** | Optional | Required (one active project) |
| **Capture popup** | Full: category, project, tags | Minimal: note + save |
| **AI output** | Category, tags, summary, URL, fix prompt | Summary + focused coding prompt |
| **Best for** | Research, triage, knowledge base | "Fix this now" during a coding session |

Toggle via tray menu: right-click **Switch to Lite/Full Mode**.

---

## Installation Guide

### Option 1: Download (recommended)

1. Go to the [**Releases page**](https://github.com/wyofalcon/huminloop/releases/latest)
2. Download the installer for your platform
3. Install and launch — the setup wizard walks you through database + AI configuration

### Option 2: Build from source

**Prerequisites:** Node.js 18+ and Git. Optionally Docker (for PostgreSQL).

```bash
git clone https://github.com/wyofalcon/huminloop.git
cd huminloop
npm install
npm start          # Launch the app
npm run dev        # Launch with DevTools (development mode)
```

#### Platform-specific build tools

<details>
<summary><strong>Windows</strong></summary>

`better-sqlite3` requires C++ compilation:
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
```
Docker Desktop from [docker.com](https://www.docker.com/products/docker-desktop/) if using PostgreSQL.

</details>

<details>
<summary><strong>Linux (Ubuntu/Debian)</strong></summary>

```bash
sudo apt install build-essential python3 libsqlite3-dev
sudo apt install xdotool   # For window metadata capture on X11
```
Docker Engine from [docs.docker.com](https://docs.docker.com/engine/install/) if using PostgreSQL.

</details>

<details>
<summary><strong>macOS</strong></summary>

```bash
xcode-select --install
```
Window metadata capture is not yet implemented on macOS. All other features work.

</details>

#### Building installers

```bash
npm run build:win    # Windows .exe (NSIS installer)
npm run build:linux  # Linux .AppImage + .deb
npm run build:mac    # macOS .dmg
npm run build        # All platforms
```

Output goes to `dist/`. Must build on the target platform (native modules).

---

## Database Setup

### SQLite (zero setup, default)

No Docker, no config. The app uses SQLite automatically:
- **Windows:** `%APPDATA%/huminloop/huminloop.db`
- **Linux:** `~/.config/huminloop/huminloop.db`
- **macOS:** `~/Library/Application Support/huminloop/huminloop.db`

### PostgreSQL (Docker)

```bash
docker compose up -d    # Starts PostgreSQL 16 on port 5433
```

| Setting | Value |
|---|---|
| Host | `localhost` |
| Port | `5433` |
| Database | `huminloop` |
| User | `huminloop` |
| Password | `huminloop_dev` |

---

## AI Setup (Optional)

AI features are optional. The rule engine handles most categorization without it.

### Gemini API Key (recommended — free tier)

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create an API key
3. Add to `.env`:
   ```
   AI_AUTH_MODE=apikey
   GEMINI_API_KEY=AIzaSy...
   ```

### Vertex AI (GCP)

1. Enable Vertex AI API, create a Service Account with "Vertex AI User" role
2. Save JSON key as `credentials.json` in project root
3. Set `AI_AUTH_MODE=vertex` in `.env`

Uses native JWT auth — no Google SDK dependencies.

---

## MCP Server

HuminLoop includes an MCP server (19 tools) that bridges AI IDE agents to your clip database. Works with Claude Code, Gemini CLI, or any MCP-compatible tool.

```json
{
  "mcpServers": {
    "huminloop": {
      "command": "node",
      "args": ["/path/to/huminloop/mcp-server/index.js"]
    }
  }
}
```

**Key tools:** `clip_list`, `clip_search`, `project_match`, `get_pending_prompt`, `session_context`

The MCP server auto-detects devcontainers/Codespaces and connects to the Electron app on the host.

---

## Environment Variables

Copy `.env.example` to `.env` and customize:

| Variable | Default | Description |
|---|---|---|
| `DB_BACKEND` | `auto` | `pg`, `sqlite`, or `auto` |
| `POSTGRES_PASSWORD` | `huminloop_dev` | PostgreSQL password |
| `AI_AUTH_MODE` | `auto` | `apikey`, `vertex`, or `auto` |
| `GEMINI_API_KEY` | — | Gemini API key |
| `HOTKEY_COMBO` | `ctrl+shift+q` | Global capture hotkey |
| `HUMINLOOP_DEV` | — | Set to `1` for DevTools on launch |

---

## Architecture

```
Renderer (5 windows + 2 overlays)    Main Process
  index.html — tabbed notes viewer      Tray + global hotkey
  capture.html — full capture popup     Clipboard watcher (1s poll)
  lite-capture.html — lite capture      Window metadata capture
  toolbar.html — floating draw bar      Background AI tasks
  overlay.html — fullscreen annotator   HTTP API (localhost:7277)
  setup.html — first-run wizard         Mode switching (full/lite)
         |                                     |
         +-------- IPC (preload.js) -----------+
                                               |
                                        Module Layer
                                    db.js -> pg | sqlite
                                    ai.js -> Gemini 2.5 Flash
                                    rules.js -> 7-strategy chain
                                    api-server.js -> REST API
                                    window-info.js -> OS-native
```

| Layer | Technology |
|---|---|
| Runtime | Electron 33 (context-isolated, no nodeIntegration) |
| Database | PostgreSQL 16 or SQLite (auto-detected) |
| AI | Gemini 2.5 Flash (API key or Vertex AI with native JWT) |
| Rules | 7-strategy priority chain with 5-min cache |
| Build | electron-builder (NSIS, AppImage, deb, dmg) |
| MCP | stdio transport, 19 tools, container-aware |

---

## Troubleshooting

<details>
<summary><code>npm install</code> fails on <code>better-sqlite3</code></summary>

Native module needs C++ compilation:
- **Windows:** `winget install Microsoft.VisualStudio.2022.BuildTools`
- **Linux:** `sudo apt install build-essential python3`
- **macOS:** `xcode-select --install`

</details>

<details>
<summary>App launches as plain Node.js (no window)</summary>

VS Code terminals set `ELECTRON_RUN_AS_NODE=1`. Use `npm start` (the launch script fixes this automatically).

</details>

<details>
<summary>Docker database won't connect</summary>

Default port is **5433** (not 5432). Check with:
```bash
docker ps --filter name=huminloop-db
docker logs huminloop-db
```

</details>

<details>
<summary>AI not categorizing</summary>

Check terminal for `[AI] Gemini API key ready` or `[AI] Vertex AI ready`. Verify `.env` has `AI_AUTH_MODE` and credentials. AI is optional — rules work without it.

</details>

---

## Project Structure

```
huminloop/
├── src/
│   ├── main.js            # Electron main process
│   ├── preload.js         # IPC context bridge
│   ├── db.js / db-pg.js / db-sqlite.js
│   ├── ai.js              # Gemini AI (native JWT, zero SDK deps)
│   ├── rules.js           # 7-strategy categorization engine
│   ├── api-server.js      # Local HTTP API (port 7277)
│   ├── window-info.js     # OS-native window capture
│   └── images.js / workflow-context.js
├── renderer/              # 5 windows + 2 overlays
├── mcp-server/            # MCP server (separate package)
├── docker/init.sql        # PostgreSQL schema
├── .github/workflows/     # CI/CD (build + release)
├── assets/                # App icons
└── package.json
```

---

## Roadmap

This started as a quick side project and has been growing fast. Here's where it's headed:

- **AI dev workflow integration** — Smart triggers and hooks that automate the full cycle: capture an issue, generate a prompt, route it to the right AI agent, track the fix, and close the loop. The workflow system (Architect/Builder/Reviewer/Screener roles) already exists in `.ai-workflow/` — the next step is wiring it directly into the capture and prompt pipeline with automated orchestration.
- **Tested executables** — CI builds exist but haven't been validated across platforms yet. This is next.
- **Auto-update** — electron-builder supports it, just needs to be wired up.
- **macOS window capture** — App runs on macOS, but window metadata capture isn't implemented yet.

If you run into issues or have ideas, [open an issue](https://github.com/wyofalcon/huminloop/issues).

---

## License

MIT License. See [LICENSE](LICENSE) for details.
