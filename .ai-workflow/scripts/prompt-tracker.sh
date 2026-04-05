#!/bin/bash
# Prompt Tracker - Manages unique prompt IDs for the AI dev workflow
# IDs follow format: scope:HHMM:MMDD:letter (conventional commit scope, CT military time, month/day, sequential letter)
# Log format: ID|STATUS|TIMESTAMP|DESCRIPTION|TYPE|PARENT_ID
#   TYPE: CRAFTED (formally crafted via !) or DIRECT (via !! or typed directly into builder)
#   PARENT_ID: ID of the parent CRAFTED prompt this is a follow-up to (blank for CRAFTED)
#   Backward compatible: old 4-field entries treated as TYPE=CRAFTED, PARENT_ID=
#
# Usage:
#   prompt-tracker.sh add "scope" "description"         → Logs a CRAFTED prompt, returns the ID
#   prompt-tracker.sh add "description"                → Logs a CRAFTED prompt (no scope)
#   prompt-tracker.sh add-direct "scope" "description" → Logs a DIRECT follow-up, auto-links to last CRAFTED parent
#   prompt-tracker.sh log-direct "scope" "description" → Alias for add-direct (retroactive manual logging)
#   prompt-tracker.sh status ID new_status      → Updates status (CRAFTED→SENT→BUILDING→DONE→FAILED)
#   prompt-tracker.sh show                      → Shows recent prompts with status
#   prompt-tracker.sh show-compact              → One-line summary for terminal headers
#   prompt-tracker.sh next-id                   → Returns the next ID (without logging)
#   prompt-tracker.sh reset-counter             → Resets the letter counter (new batch)
#   prompt-tracker.sh batch-start               → Starts a new batch (resets counter, returns first ID)
#   prompt-tracker.sh last-pending              → Returns last CRAFTED/SENT/BUILDING prompt (exit 0 if found, 1 if none)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTEXT_DIR="$(dirname "$SCRIPT_DIR")/context"
TRACKER_FILE="$CONTEXT_DIR/PROMPT_TRACKER.log"
COUNTER_FILE="$CONTEXT_DIR/.prompt-counter"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
GOLD='\033[38;5;220m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# Ensure files exist
mkdir -p "$CONTEXT_DIR"
touch "$TRACKER_FILE"

# Get current CT time components
get_est_time() {
    TZ="America/Chicago" date "+%H%M"
}

get_est_date() {
    TZ="America/Chicago" date "+%m%d"
}

get_full_timestamp() {
    TZ="America/Chicago" date "+%Y-%m-%dT%H:%M:%S%z"
}

# Get the current letter counter (a=1, b=2, etc.)
get_counter() {
    if [ -f "$COUNTER_FILE" ]; then
        cat "$COUNTER_FILE" | tr -d '[:space:]'
    else
        echo "0"
    fi
}

# Increment counter and return the letter
next_letter() {
    local count=$(get_counter)
    count=$((count + 1))
    echo "$count" > "$COUNTER_FILE"
    # Convert number to letter (1=a, 2=b, ..., 26=z)
    printf "\\$(printf '%03o' $((count + 96)))"
}

# Generate the next prompt ID (optional scope prefix)
generate_id() {
    local scope="$1"
    local time_part=$(get_est_time)
    local date_part=$(get_est_date)
    local letter=$(next_letter)
    if [ -n "$scope" ]; then
        echo "${scope}:${time_part}:${date_part}:${letter}"
    else
        echo "${time_part}:${date_part}:${letter}"
    fi
}

# Peek at the next ID without consuming it
peek_next_id() {
    local time_part=$(get_est_time)
    local date_part=$(get_est_date)
    local count=$(get_counter)
    count=$((count + 1))
    local letter=$(printf "\\$(printf '%03o' $((count + 96)))")
    echo "${time_part}:${date_part}:${letter}"
}

# Status emoji mapping
status_emoji() {
    case "$1" in
        CRAFTED)  echo "📝" ;;
        SENT)     echo "📤" ;;
        BUILDING) echo "🔨" ;;
        DONE)     echo "✅" ;;
        FAILED)   echo "❌" ;;
        PARTIAL)  echo "⚠️" ;;
        *)        echo "❓" ;;
    esac
}

# Status color mapping
status_color() {
    case "$1" in
        CRAFTED)  echo "$YELLOW" ;;
        SENT)     echo "$BLUE" ;;
        BUILDING) echo "$PURPLE" ;;
        DONE)     echo "$GREEN" ;;
        FAILED)   echo "$RED" ;;
        PARTIAL)  echo "$YELLOW" ;;
        *)        echo "$NC" ;;
    esac
}

# ═══════════════════════════════════════════════════════════════
# COMMANDS
# ═══════════════════════════════════════════════════════════════

case "${1:-show}" in
    add)
        # Add a new prompt entry
        # Usage: add "description" OR add "scope" "description"
        if [ -n "$3" ]; then
            SCOPE="$2"
            DESCRIPTION="$3"
        else
            SCOPE=""
            DESCRIPTION="${2:-No description}"
        fi
        ID=$(generate_id "$SCOPE")
        TIMESTAMP=$(get_full_timestamp)
        echo "${ID}|CRAFTED|${TIMESTAMP}|${DESCRIPTION}|CRAFTED|" >> "$TRACKER_FILE"
        echo "$ID"
        ;;

    add-direct|log-direct)
        # Add a direct/follow-up prompt (via !! or typed directly into builder)
        # Auto-links to the most recent CRAFTED-type parent prompt
        # Usage: add-direct "scope" "description" OR add-direct "description"
        if [ -n "$3" ]; then
            SCOPE="$2"
            DESCRIPTION="$3"
        else
            SCOPE=""
            DESCRIPTION="${2:-No description}"
        fi
        ID=$(generate_id "$SCOPE")
        TIMESTAMP=$(get_full_timestamp)
        # Find the last CRAFTED-type parent prompt (last entry where field 5 = CRAFTED or blank)
        PARENT_ID=$(awk -F'|' '{
            type = (NF >= 5) ? $5 : "CRAFTED"
            if (type == "CRAFTED") last = $1
        } END { print last }' "$TRACKER_FILE" 2>/dev/null)
        PARENT_ID="${PARENT_ID:-}"
        echo "${ID}|CRAFTED|${TIMESTAMP}|${DESCRIPTION}|DIRECT|${PARENT_ID}" >> "$TRACKER_FILE"
        if [ -n "$PARENT_ID" ]; then
            echo -e "${DIM}  ↳ linked to parent: ${PARENT_ID}${NC}" >&2
        fi
        echo "$ID"
        ;;

    status)
        # Update the status of a prompt
        PROMPT_ID="$2"
        NEW_STATUS="$3"
        if [ -z "$PROMPT_ID" ] || [ -z "$NEW_STATUS" ]; then
            echo "Usage: prompt-tracker.sh status <ID> <STATUS>"
            echo "Statuses: CRAFTED, SENT, BUILDING, DONE, FAILED, PARTIAL"
            exit 1
        fi
        # Escape sed special chars in variables
        safe_id=$(printf '%s' "$PROMPT_ID" | sed 's/[\/&]/\\&/g')
        safe_status=$(printf '%s' "$NEW_STATUS" | sed 's/[\/&]/\\&/g')

        # Update in place using sed
        if grep -q "^${PROMPT_ID}|" "$TRACKER_FILE"; then
            sed -i "s/^${safe_id}|\([^|]*\)|/${safe_id}|${safe_status}|/" "$TRACKER_FILE"
            echo -e "$(status_emoji "$NEW_STATUS") ${PROMPT_ID} → ${NEW_STATUS}"
        else
            echo -e "${RED}❌ Prompt ID not found: ${PROMPT_ID}${NC}"
            exit 1
        fi
        ;;

    show)
        # Show recent prompts with status, grouped by parent (CRAFTED prompts with DIRECT children indented)
        if [ ! -s "$TRACKER_FILE" ]; then
            echo -e "${DIM}No prompts tracked yet.${NC}"
            exit 0
        fi
        echo -e "${GOLD}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GOLD}${BOLD}║${NC}  🏷️  ${GOLD}${BOLD}PROMPT TRACKER${NC}                                     ${GOLD}${BOLD}║${NC}"
        echo -e "${GOLD}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
        echo ""

        # Extract all entries into temp arrays via awk, then display grouped
        # Show last 10 CRAFTED parents (most recent first), each followed by their DIRECT children
        CRAFTED_IDS=$(awk -F'|' '{ type=(NF>=5)?$5:"CRAFTED"; if(type=="CRAFTED") print $1 }' "$TRACKER_FILE" | tail -10 | tac)
        while IFS= read -r parent_id; do
            [ -z "$parent_id" ] && continue
            # Read parent's fields
            parent_line=$(grep "^${parent_id}|" "$TRACKER_FILE" | tail -1)
            IFS='|' read -r pid pstatus ptime pdesc ptype pparent <<< "$parent_line"
            pemoji=$(status_emoji "$pstatus")
            pcolor=$(status_color "$pstatus")
            short_desc="${pdesc:0:43}"
            [ "${#pdesc}" -gt 43 ] && short_desc="${short_desc}..."
            echo -e "  ${GOLD}${BOLD}${pid}${NC}  ${pcolor}${pstatus}${NC}  ${pemoji}  ${DIM}${short_desc}${NC}"

            # Show any DIRECT children of this parent
            grep '|DIRECT|' "$TRACKER_FILE" 2>/dev/null | while IFS='|' read -r cid cstatus ctime cdesc ctype cparent; do
                [ "$cparent" != "$parent_id" ] && continue
                cemoji=$(status_emoji "$cstatus")
                ccolor=$(status_color "$cstatus")
                cshort="${cdesc:0:38}"
                [ "${#cdesc}" -gt 38 ] && cshort="${cshort}..."
                echo -e "    ${DIM}↳${NC} ${CYAN}${cid}${NC}  ${ccolor}${cstatus}${NC}  ${cemoji}  ${DIM}${cshort} [direct]${NC}"
            done
        done <<< "$CRAFTED_IDS"
        echo ""
        ;;

    show-compact)
        # Two-line summary: last committed prompt + any active prompt
        if [ ! -s "$TRACKER_FILE" ]; then
            echo -e "🏷️  No prompts tracked yet"
            exit 0
        fi

        DONE_COUNT=$(grep -c '|DONE|' "$TRACKER_FILE" 2>/dev/null | tr -d '[:space:]')
        FAILED_COUNT=$(grep -c '|FAILED|' "$TRACKER_FILE" 2>/dev/null | tr -d '[:space:]')
        PARTIAL_COUNT=$(grep -c '|PARTIAL|' "$TRACKER_FILE" 2>/dev/null | tr -d '[:space:]')
        DONE_COUNT=${DONE_COUNT:-0}
        FAILED_COUNT=${FAILED_COUNT:-0}
        PARTIAL_COUNT=${PARTIAL_COUNT:-0}

        # Last fully committed (DONE) prompt
        LAST_DONE_LINE=$(grep '|DONE|' "$TRACKER_FILE" | tail -1)
        if [ -n "$LAST_DONE_LINE" ]; then
            LAST_DONE_ID=$(echo "$LAST_DONE_LINE" | cut -d'|' -f1)
            LAST_DONE_DESC=$(echo "$LAST_DONE_LINE" | cut -d'|' -f4)
            SHORT_DESC="${LAST_DONE_DESC:0:35}"
            [ "${#LAST_DONE_DESC}" -gt 35 ] && SHORT_DESC="${SHORT_DESC}..."
            echo -e "  ${GREEN}✅ Last Committed:${NC} ${GOLD}${BOLD}${LAST_DONE_ID}${NC}  ${DIM}${SHORT_DESC}${NC}"
        else
            echo -e "  ${DIM}✅ Last Committed: none yet${NC}"
        fi

        # Any active (CRAFTED/SENT/BUILDING) prompt
        ACTIVE_LINE=$(grep -E '\|(CRAFTED|SENT|BUILDING)\|' "$TRACKER_FILE" | tail -1)
        if [ -n "$ACTIVE_LINE" ]; then
            ACTIVE_ID=$(echo "$ACTIVE_LINE" | cut -d'|' -f1)
            ACTIVE_STATUS=$(echo "$ACTIVE_LINE" | cut -d'|' -f2)
            ACTIVE_DESC=$(echo "$ACTIVE_LINE" | cut -d'|' -f4)
            ACTIVE_EMOJI=$(status_emoji "$ACTIVE_STATUS")
            SHORT_ADESC="${ACTIVE_DESC:0:35}"
            [ "${#ACTIVE_DESC}" -gt 35 ] && SHORT_ADESC="${SHORT_ADESC}..."
            ACOLOR=$(status_color "$ACTIVE_STATUS")
            echo -e "  ${PURPLE}🔨 In Progress:${NC}    ${GOLD}${BOLD}${ACTIVE_ID}${NC}  ${ACOLOR}${ACTIVE_STATUS}${NC} ${ACTIVE_EMOJI}  ${DIM}${SHORT_ADESC}${NC}"
        else
            echo -e "  ${DIM}🔨 In Progress:    none${NC}"
        fi

        # Failure/partial alerts
        if [ "$FAILED_COUNT" -gt 0 ] || [ "$PARTIAL_COUNT" -gt 0 ]; then
            echo -e "  ${RED}⚠️  Alerts: ${FAILED_COUNT} FAILED, ${PARTIAL_COUNT} PARTIAL${NC}"
        fi
        ;;

    next-id)
        # Peek at the next ID without consuming it
        peek_next_id
        ;;

    reset-counter)
        # Reset the letter counter for a new batch
        echo "0" > "$COUNTER_FILE"
        echo -e "${GREEN}✓ Prompt counter reset${NC}"
        ;;

    batch-start)
        # Start a new batch: reset counter and return the first available ID
        # Warn if there are still pending (CRAFTED/SENT/BUILDING) prompts from a previous batch
        if [ -s "$TRACKER_FILE" ]; then
            PENDING=$(grep -E '\|(CRAFTED|SENT|BUILDING)\|' "$TRACKER_FILE" | tail -1)
            if [ -n "$PENDING" ]; then
                PENDING_ID=$(echo "$PENDING" | cut -d'|' -f1)
                PENDING_STATUS=$(echo "$PENDING" | cut -d'|' -f2)
                PENDING_DESC=$(echo "$PENDING" | cut -d'|' -f4)
                echo -e "${YELLOW}⚠️  WARNING: Unconfirmed prompt still pending:${NC} ${BOLD}${PENDING_ID}${NC} [${YELLOW}${PENDING_STATUS}${NC}] — ${PENDING_DESC}" >&2
                echo -e "${DIM}   Run: prompt-tracker.sh status ${PENDING_ID} DONE  — to mark it complete first.${NC}" >&2
                echo -e "${DIM}   Proceeding anyway, but verify the builder finished before sending the new prompt.${NC}" >&2
            fi
        fi
        echo "0" > "$COUNTER_FILE"
        peek_next_id
        ;;

    last-pending)
        # Return the most recent prompt that is still CRAFTED, SENT, or BUILDING
        if [ ! -s "$TRACKER_FILE" ]; then
            exit 1
        fi
        PENDING_LINE=$(grep -E '\|(CRAFTED|SENT|BUILDING)\|' "$TRACKER_FILE" | tail -1)
        if [ -z "$PENDING_LINE" ]; then
            exit 1
        fi
        IFS='|' read -r pid pstatus ptime pdesc <<< "$PENDING_LINE"
        echo -e "${YELLOW}⏳ Unconfirmed prompt:${NC} ${BOLD}${pid}${NC} [${YELLOW}${pstatus}${NC}] — ${pdesc}"
        exit 0
        ;;

    clear)
        # Clear all tracked prompts (archive first)
        if [ -s "$TRACKER_FILE" ]; then
            ARCHIVE="$CONTEXT_DIR/PROMPT_TRACKER_$(date +%Y%m%d_%H%M%S).archive"
            cp "$TRACKER_FILE" "$ARCHIVE"
            > "$TRACKER_FILE"
            echo "0" > "$COUNTER_FILE"
            echo -e "${GREEN}✓ Tracker cleared. Archive: ${ARCHIVE}${NC}"
        else
            echo -e "${DIM}Nothing to clear.${NC}"
        fi
        ;;

    *)
        echo "Usage: prompt-tracker.sh <command>"
        echo ""
        echo "Commands:"
        echo "  add \"description\"       Log a new prompt, returns its ID"
        echo "  status ID STATUS        Update prompt status"
        echo "  show                    Show recent prompts"
        echo "  show-compact            One-line summary"
        echo "  next-id                 Preview next ID (without logging)"
        echo "  reset-counter           Reset letter counter"
        echo "  batch-start             Reset counter, return first ID"
        echo "  last-pending            Show last unconfirmed prompt (exit 0=found, 1=none)"
        echo "  clear                   Archive and clear tracker"
        echo ""
        echo "Statuses: CRAFTED, SENT, BUILDING, DONE, FAILED, PARTIAL"
        ;;
esac
