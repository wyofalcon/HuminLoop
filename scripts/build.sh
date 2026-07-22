#!/usr/bin/env bash
# scripts/build.sh — Build a HuminLoop installer for a chosen OS via electron-builder.
#
# Thin wrapper over `npm run build:{win,linux,mac}`. Picks a target from the
# first arg, auto-detects the host OS when asked, and refuses combinations the
# host cannot actually build (e.g. a Windows .exe from WSL without Wine).
#
# Your NOTES ARE NOT AFFECTED by a build/reinstall — they live in the
# PostgreSQL Docker volume (container huminloop-db, port 5433), independent of
# the installer. See the "Next steps" note printed at the end for the one .env
# detail that lets a freshly-installed packaged app see them.
#
# Usage:
#   bash scripts/build.sh          # ask (interactive TTY) or auto (non-TTY)
#   bash scripts/build.sh auto     # build for this machine's OS
#   bash scripts/build.sh linux    # AppImage + .deb
#   bash scripts/build.sh win      # NSIS .exe   (needs Windows, or Wine on *nix)
#   bash scripts/build.sh mac      # .dmg        (needs macOS)

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

log()  { echo "[build] $*"; }
fail() { echo "[build] ERROR: $*" >&2; exit 1; }

# ── Host OS detection (same idiom as scripts/deploy.sh) ──
case "$(uname -s)" in
  Linux*)               HOST=linux ;;
  Darwin*)              HOST=mac ;;
  MINGW*|MSYS*|CYGWIN*) HOST=windows ;;
  *)                    HOST=unknown ;;
esac
IS_WSL=
if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; then
  IS_WSL=1
fi

# Default electron-builder target for whatever host we're on.
host_default_target() {
  case "$HOST" in
    linux)   echo linux ;;
    mac)     echo mac ;;
    windows) echo win ;;
    *)       echo "" ;;
  esac
}

# ── Normalize a requested target to win|linux|mac|auto|invalid ──
normalize_target() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    win|windows|nsis|exe)  echo win ;;
    linux|deb|appimage)    echo linux ;;
    mac|macos|osx|darwin)  echo mac ;;
    auto|"")               echo auto ;;
    *)                     echo invalid ;;
  esac
}

RAW_ARG="${1:-}"
TARGET="$(normalize_target "$RAW_ARG")"
[[ "$TARGET" == "invalid" ]] && fail "Unknown target '$RAW_ARG'. Use: linux | win | mac | auto"

# No arg → prompt on a real terminal, otherwise auto.
if [[ -z "$RAW_ARG" ]]; then
  if [[ -t 0 ]]; then
    echo "Build HuminLoop installer for which OS?"
    echo "  1) Linux   (AppImage + .deb)"
    echo "  2) Windows (NSIS .exe)"
    echo "  3) macOS   (.dmg)"
    echo "  4) Auto    (this machine: $(host_default_target))"
    read -r -p "Choose [1-4, default 4]: " choice
    case "$choice" in
      1) TARGET=linux ;;
      2) TARGET=win ;;
      3) TARGET=mac ;;
      *) TARGET=auto ;;
    esac
  else
    TARGET=auto
  fi
fi

if [[ "$TARGET" == "auto" ]]; then
  TARGET="$(host_default_target)"
  [[ -z "$TARGET" ]] && fail "Could not auto-detect a build target for host '$(uname -s)'."
  log "Auto-selected target: $TARGET (host: $HOST${IS_WSL:+/WSL})"
fi

# ── Feasibility guards (fail early with a clear reason, not a cryptic builder error) ──
case "$TARGET" in
  win)
    if [[ "$HOST" != "windows" ]] && ! command -v wine >/dev/null 2>&1; then
      fail "Building a Windows .exe on '$HOST' needs Wine, which isn't installed.
       Options:
         • Run this task from Windows (native VS Code / PowerShell / Git Bash), then: npm run build:win
         • Or install Wine on this machine and re-run."
    fi
    ;;
  linux)
    [[ "$HOST" == "windows" ]] && fail "Can't build a Linux AppImage/.deb from Windows here. Run it from WSL/Linux."
    ;;
  mac)
    [[ "$HOST" != "mac" ]] && fail "Building a macOS .dmg requires macOS (host is '$HOST')."
    ;;
esac

# ── Tooling sanity ──
command -v node >/dev/null || fail "Node.js not found in PATH."
command -v npm  >/dev/null || fail "npm not found in PATH."

# ── Install deps if needed (same policy as scripts/deploy.sh) ──
if [[ ! -d node_modules ]]; then
  log "Installing dependencies (first run)"
  npm install || fail "npm install failed"
elif [[ package.json -nt node_modules ]] || [[ package-lock.json -nt node_modules ]]; then
  log "Manifest changed since last install — running npm install"
  npm install || fail "npm install failed"
fi

# ── Build ──
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
log "Building HuminLoop v$VERSION for target: $TARGET"
npm run "build:$TARGET" || fail "electron-builder failed for target '$TARGET'."

# ── Report artifacts ──
log "Build complete. Installer(s) in dist/:"
ls -1 dist/ 2>/dev/null | grep -Ei '\.(exe|appimage|deb|dmg)$' | sed 's|^|  dist/|' || log "  (no matching artifact found — check dist/)"

cat <<'EOF'

[build] ── Reinstall notes (your captured notes are safe either way) ──
  Your 8+ notes live in the Postgres volume (huminloop-db, port 5433) and are
  NOT touched by installing a new build.

  Linux install:
    • .deb :  sudo dpkg -i dist/huminloop_*_amd64.deb
    • or run the AppImage directly:
              chmod +x dist/HuminLoop-*.AppImage && ./dist/HuminLoop-*.AppImage

  IMPORTANT so the packaged app SEES your existing notes:
    The installed app reads its DB config from ~/.config/huminloop/.env.
    If that file is missing it defaults to port 5432 (your DB is on 5433) and
    falls back to an empty local DB — notes will look gone. Fix once:
        cp .env ~/.config/huminloop/.env
EOF
