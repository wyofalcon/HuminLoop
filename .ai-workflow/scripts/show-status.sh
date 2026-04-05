#!/bin/bash
# Show current workflow status — Windows/Git Bash compatible
# No tmux dependency — shows git state and workflow modes instead

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTEXT_DIR="$(dirname "$SCRIPT_DIR")/context"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

# Relay mode
RELAY_MODE="review"
[ -f "$CONTEXT_DIR/RELAY_MODE" ] && RELAY_MODE=$(cat "$CONTEXT_DIR/RELAY_MODE" | tr -d '[:space:]')
if [ "$RELAY_MODE" = "auto" ]; then
  RELAY_DISPLAY="${GREEN}AUTO${NC}"
else
  RELAY_DISPLAY="${YELLOW}REVIEW${NC}"
fi

# Audit mode
AUDIT_MODE="off"
[ -f "$CONTEXT_DIR/AUDIT_WATCH_MODE" ] && AUDIT_MODE=$(cat "$CONTEXT_DIR/AUDIT_WATCH_MODE" | tr -d '[:space:]')
if [ "$AUDIT_MODE" = "on" ]; then
  AUDIT_DISPLAY="${GREEN}ON${NC}"
else
  AUDIT_DISPLAY="${YELLOW}OFF${NC}"
fi

# Git state
BRANCH=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
LAST_COMMIT=$(git -C "$PROJECT_ROOT" log --oneline -1 2>/dev/null || echo "no commits")
DIRTY=$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
AHEAD=$(git -C "$PROJECT_ROOT" rev-list @{u}..HEAD --count 2>/dev/null || echo "0")

# Sciurus API
API_STATUS="${RED}DOWN${NC}"
if curl -s http://127.0.0.1:7277/api/health >/dev/null 2>&1; then
  API_STATUS="${GREEN}UP${NC}"
fi

# Display
case "${1:-full}" in
  compact)
    echo -e "[Relay: $RELAY_DISPLAY | Audit: $AUDIT_DISPLAY | API: $API_STATUS]"
    ;;
  *)
    echo -e "${CYAN}================================================================${NC}"
    echo -e "  ${DIM}SCIURUS AI DEV WORKFLOW${NC}"
    echo -e "${CYAN}================================================================${NC}"
    echo -e "  Branch:         ${GREEN}$BRANCH${NC}"
    echo -e "  Last commit:    ${DIM}$LAST_COMMIT${NC}"
    echo -e "  Uncommitted:    $DIRTY file(s)"
    echo -e "  Ahead of remote: $AHEAD commit(s)"
    echo -e "${CYAN}----------------------------------------------------------------${NC}"
    echo -e "  Prompt Relay:   $RELAY_DISPLAY"
    echo -e "  Audit Watch:    $AUDIT_DISPLAY"
    echo -e "  Sciurus API:    $API_STATUS"
    echo -e "${CYAN}----------------------------------------------------------------${NC}"

    # Prompt tracker
    TRACKER="$SCRIPT_DIR/prompt-tracker.sh"
    if [ ! -x "$TRACKER" ]; then
      TRACKER="$PROJECT_ROOT/workflow/scripts/prompt-tracker.sh"
    fi
    if [ -x "$TRACKER" ]; then
      PROMPT_LINE=$("$TRACKER" show-compact 2>/dev/null || echo "")
      [ -n "$PROMPT_LINE" ] && echo -e "  $PROMPT_LINE"
    fi

    # Workflow change pending
    if [ -f "$CONTEXT_DIR/WORKFLOW_CHANGE_PENDING" ]; then
      echo ""
      echo -e "  ${YELLOW}!! WORKFLOW CHANGE UNDER TEST${NC}"
      while IFS= read -r entry; do
        echo -e "  ${DIM}  > ${entry}${NC}"
      done < "$CONTEXT_DIR/WORKFLOW_CHANGE_PENDING"
    fi

    echo -e "${CYAN}================================================================${NC}"
    ;;
esac
