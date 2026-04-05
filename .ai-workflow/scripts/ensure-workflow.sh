#!/bin/bash
# ensure-workflow.sh — Health check for Sciurus AI dev workflow (Windows/Git Bash)
# Exit 0 = healthy, exit 1 = issues found.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKFLOW_ROOT="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$WORKFLOW_ROOT")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

ISSUES=0

check() {
  local label="$1" ok="$2" fix="$3"
  if eval "$ok" 2>/dev/null; then
    echo -e "  ${GREEN}+${NC} $label"
  else
    echo -e "  ${RED}x${NC} $label"
    if [ -n "$fix" ]; then
      echo -e "    ${DIM}-- run: $fix${NC}"
    fi
    ISSUES=$((ISSUES + 1))
  fi
}

echo -e "${YELLOW}Sciurus Workflow Health Check${NC}"
echo ""

# Instructions compiled
check "Instructions compiled" \
  "[ -f '$WORKFLOW_ROOT/instructions/SHARED.md' ] && [ -f '$WORKFLOW_ROOT/instructions/BUILDER.md' ]"

# SESSION.md exists
check "SESSION.md exists" \
  "[ -f '$WORKFLOW_ROOT/context/SESSION.md' ]"

# prepare-commit-msg hook installed
GIT_HOOK="$PROJECT_ROOT/.git/hooks/prepare-commit-msg"
check "prepare-commit-msg hook installed" \
  "[ -f '$GIT_HOOK' ]" \
  "cp $PROJECT_ROOT/workflow/hooks/prepare-commit-msg $GIT_HOOK"

# prompt-tracker.sh available
check "prompt-tracker.sh available" \
  "[ -f '$WORKFLOW_ROOT/scripts/prompt-tracker.sh' ] || [ -f '$PROJECT_ROOT/workflow/scripts/prompt-tracker.sh' ]"

# Node.js available
check "Node.js available" \
  "command -v node >/dev/null 2>&1"

# Python available (for hooks)
check "Python 3 available" \
  "command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1"

# Docker accessible (optional — SQLite fallback available)
if command -v docker >/dev/null 2>&1; then
  check "Docker accessible" \
    "docker info >/dev/null 2>&1"

  check "Sciurus DB container running" \
    "docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'sciurus-db'" \
    "cd $PROJECT_ROOT && docker compose up -d"
else
  echo -e "  ${DIM}-${NC} Docker not installed (SQLite fallback available)"
fi

# Sciurus API reachable
check "Sciurus API reachable (port 7277)" \
  "curl -s http://127.0.0.1:7277/api/health >/dev/null 2>&1" \
  "npm start  (launch Sciurus first)"

# MCP server deps installed
check "MCP server deps installed" \
  "[ -d '$PROJECT_ROOT/mcp-server/node_modules' ]" \
  "cd $PROJECT_ROOT/mcp-server && npm install"

echo ""
if [ "$ISSUES" -eq 0 ]; then
  echo -e "${GREEN}All checks passed.${NC}"
else
  echo -e "${RED}$ISSUES issue(s) found.${NC}"
fi

exit $ISSUES
