#!/bin/bash
# Compose agent instructions: SHARED.md + role-specific file
# Usage: compose-instructions.sh <role> [--output <file>]
#   role: architect | builder | reviewer | screener

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTRUCTIONS_DIR="$(dirname "$SCRIPT_DIR")/instructions"

ROLE="${1:-}"
OUTPUT=""

shift 2>/dev/null
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output|-o) OUTPUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$ROLE" ]; then
  echo "Usage: compose-instructions.sh <role> [--output <file>]" >&2
  echo "  Roles: architect, builder, reviewer, screener" >&2
  exit 1
fi

ROLE_UPPER=$(echo "$ROLE" | tr '[:lower:]' '[:upper:]')
ROLE_FILE="$INSTRUCTIONS_DIR/${ROLE_UPPER}.md"
SHARED_FILE="$INSTRUCTIONS_DIR/SHARED.md"

if [ ! -f "$SHARED_FILE" ]; then
  echo "Error: $SHARED_FILE not found" >&2
  exit 1
fi

if [ ! -f "$ROLE_FILE" ]; then
  echo "Error: $ROLE_FILE not found (role: $ROLE)" >&2
  exit 1
fi

composed() {
  cat "$SHARED_FILE"
  echo ""
  echo "---"
  echo ""
  cat "$ROLE_FILE"
}

if [ -n "$OUTPUT" ]; then
  composed > "$OUTPUT"
  echo "Composed instructions written to $OUTPUT" >&2
else
  composed
fi
