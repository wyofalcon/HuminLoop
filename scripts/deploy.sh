#!/usr/bin/env bash
# scripts/deploy.sh — Ensure HuminLoop is installed for the current OS and
# relaunch it with the latest source. Dev iteration loop, not a release build.
#
# Detects: Linux, WSL (treated as Linux/WSLg), macOS, Git Bash on Windows.
# Reuses: `npm run dev` (delegates to scripts/launch.js).
#
# Usage:
#   bash scripts/deploy.sh              # background launch, returns when ready
#   bash scripts/deploy.sh --foreground # foreground launch (Ctrl+C to stop)
#   bash scripts/deploy.sh --no-launch  # install/rebuild only, don't start the app

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG=/tmp/huminloop-deploy.log

log()  { echo "[deploy] $*"; }
fail() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# ── OS detection ──
case "$(uname -s)" in
  Linux*)               OS=linux ;;
  Darwin*)              OS=mac ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *)                    OS=unknown ;;
esac
IS_WSL=
if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; then
  IS_WSL=1
fi
log "OS: $OS${IS_WSL:+ (WSL)}"

[[ "$OS" == "unknown" ]] && fail "Unsupported platform: $(uname -s)"
[[ "$OS" == "mac" ]] && log "WARNING: macOS window capture is not implemented (see CLAUDE.md)."

# ── Tooling sanity ──
command -v node >/dev/null || fail "Node.js not found in PATH. Install Node 18+ first."
command -v npm  >/dev/null || fail "npm not found in PATH."

# ── Stop running instance ──
case "$OS" in
  linux|mac)
    if pgrep -f "node_modules/electron/dist/electron " >/dev/null 2>&1; then
      log "Stopping running app"
      pkill -9 -f "node_modules/electron/dist/electron " 2>/dev/null || true
      sleep 1
    fi
    ;;
  windows)
    if tasklist //FI "IMAGENAME eq electron.exe" 2>/dev/null | grep -qi electron.exe; then
      log "Stopping running app"
      taskkill //F //IM electron.exe >/dev/null 2>&1 || true
      sleep 1
    fi
    ;;
esac

# ── Install deps if needed ──
if [[ ! -d node_modules ]]; then
  log "Installing dependencies (first run)"
  npm install || fail "npm install failed"
elif [[ package.json -nt node_modules ]] || [[ package-lock.json -nt node_modules ]]; then
  log "Manifest changed since last install — running npm install"
  npm install || fail "npm install failed"
else
  log "Dependencies up to date"
fi

# ── Linux: smoke-test Electron binary, hint on missing system libs ──
if [[ "$OS" == "linux" ]] && [[ -x node_modules/electron/dist/electron ]]; then
  if ! node_modules/electron/dist/electron --version >/dev/null 2>&1; then
    cat >&2 <<'EOF'
[deploy] ERROR: Electron failed to launch. Likely missing GUI system libraries.
        On Ubuntu/Debian, install:
        sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
          libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libgtk-3-0 \
          libpango-1.0-0 libasound2t64 libxshmfence1 libdrm2 libxss1
EOF
    exit 1
  fi
fi

# ── Optional bail out before launching ──
if [[ "${1:-}" == "--no-launch" ]]; then
  log "Install/rebuild complete. Skipping launch (--no-launch)."
  exit 0
fi

# ── Launch ──
unset ELECTRON_RUN_AS_NODE
if [[ "${1:-}" == "--foreground" ]]; then
  log "Launching app (npm run dev) in foreground"
  exec npm run dev
fi

log "Launching app (npm run dev) in background, log: $LOG"
: > "$LOG"
nohup npm run dev >"$LOG" 2>&1 &
APP_PID=$!
log "PID: $APP_PID"

# Wait up to 30s for the API to come up or for an error to surface
for _ in $(seq 1 30); do
  if grep -q "Listening on" "$LOG" 2>/dev/null; then
    log "App is up. API: http://127.0.0.1:7277"
    exit 0
  fi
  if grep -qE "UNCAUGHT|Cannot find module|shared libraries" "$LOG" 2>/dev/null; then
    echo "[deploy] App failed to start:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  sleep 1
done

log "App started but didn't reach 'Listening on' within 30s. Recent log:"
tail -20 "$LOG"
exit 0
