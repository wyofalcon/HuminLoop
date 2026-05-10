#!/usr/bin/env bash
# Stop every HuminLoop-related process (current + legacy "quickclip" name).
# Safe to run before a rebuild or `npm run dev` to guarantee a clean slate.
#
# Usage:
#   bash scripts/kill-all.sh           # graceful (SIGTERM), then SIGKILL holdouts
#   bash scripts/kill-all.sh --force   # SIGKILL immediately

set -u

FORCE=0
[[ "${1:-}" == "--force" || "${1:-}" == "-9" ]] && FORCE=1

# Patterns matched against full command line via pkill -f.
# Order matters: kill the launcher first so it can't respawn anything, then
# the Electron main process (which terminates its own children), then sweep
# any orphaned children + the MCP bridge.
#
# Note: the bare Electron main cmdline is just `electron .` with no project
# name in it, so we key off the binary path (the node_modules dir is
# project-local and therefore unambiguous).
PATTERNS=(
  "scripts/launch.js"                             # npm start / npm run dev launcher
  "/HuminLoop/node_modules/electron/dist/electron"  # current binary path
  "/quickclip/node_modules/electron/dist/electron"  # legacy name
  "mcp-server/index.js"                           # MCP stdio bridge
  "--user-data-dir=.*/huminloop"                  # any orphaned electron child
  "--user-data-dir=.*/quickclip"                  # legacy
  "node .*/HuminLoop/src/main.js"                 # raw-node launches (rare)
  "node .*/quickclip/src/main.js"
)

found_any=0
killed_any=0

kill_pattern() {
  local sig="$1" pat="$2"
  # -f matches against full command line; capture matching pids first so we
  # can report them. Exclude this script's own pid + parent.
  local self=$$
  local parent=$PPID
  local pids
  pids=$(pgrep -f -- "$pat" 2>/dev/null | grep -v -e "^${self}$" -e "^${parent}$" || true)
  [[ -z "$pids" ]] && return 0
  found_any=1
  echo "  [$sig] $pat"
  for pid in $pids; do
    # Skip if it died between pgrep and now.
    if kill -0 "$pid" 2>/dev/null; then
      echo "       pid=$pid $(ps -p "$pid" -o comm= 2>/dev/null || echo '?')"
      kill -s "$sig" "$pid" 2>/dev/null && killed_any=1
    fi
  done
}

echo "Stopping HuminLoop processes..."

if (( FORCE )); then
  for pat in "${PATTERNS[@]}"; do kill_pattern KILL "$pat"; done
else
  # Graceful pass.
  for pat in "${PATTERNS[@]}"; do kill_pattern TERM "$pat"; done

  # Give them a moment to exit cleanly.
  if (( killed_any )); then
    sleep 1
  fi

  # Anything still alive? Force it.
  for pat in "${PATTERNS[@]}"; do
    if pgrep -f -- "$pat" >/dev/null 2>&1; then
      kill_pattern KILL "$pat"
    fi
  done
fi

if (( ! found_any )); then
  echo "  (nothing running)"
  exit 0
fi

# Verify — give the kernel up to ~3s to reap SIGKILL'd children before
# declaring survivors.
remaining=1
for _ in 1 2 3 4 5 6; do
  remaining=0
  for pat in "${PATTERNS[@]}"; do
    if pgrep -f -- "$pat" >/dev/null 2>&1; then remaining=1; break; fi
  done
  (( remaining )) || break
  sleep 0.5
done

if (( remaining )); then
  for pat in "${PATTERNS[@]}"; do
    if pgrep -f -- "$pat" >/dev/null 2>&1; then
      echo "  WARNING: still running: $pat"
      pgrep -af -- "$pat" | sed 's/^/    /'
    fi
  done
fi

if (( remaining )); then
  echo "Some processes survived. Re-run with --force."
  exit 1
fi

echo "All HuminLoop processes stopped."
