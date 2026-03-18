#!/usr/bin/env bash
# ============================================================================
# Engram Shell History Integration
# ============================================================================
#
# Hooks into PROMPT_COMMAND (bash) or precmd (zsh) to automatically store
# meaningful shell commands as Engram memories.
#
# SETUP:
#   1. Source this file in your .bashrc or .zshrc:
#        source /path/to/shell-history.sh
#
#   2. Enable it (disabled by default):
#        export ENGRAM_SHELL_HISTORY=1
#
#   3. Optionally configure:
#        export ENGRAM_URL="http://127.0.0.1:4200"   # default
#        export ENGRAM_API_KEY="your-api-key"         # optional auth
#
# ============================================================================

_ENGRAM_LAST_CMD=""

_engram_store_cmd() {
    # Bail if not enabled
    [[ "${ENGRAM_SHELL_HISTORY:-0}" != "1" ]] && return

    local engram_url="${ENGRAM_URL:-http://127.0.0.1:4200}"

    # Get last command from history
    local last_cmd
    if [[ -n "$ZSH_VERSION" ]]; then
        last_cmd="$(fc -ln -1 2>/dev/null | sed 's/^[[:space:]]*//')"
    else
        last_cmd="$(history 1 2>/dev/null | sed 's/^[[:space:]]*[0-9]*[[:space:]]*//')"
    fi

    # Skip empty
    [[ -z "$last_cmd" ]] && return

    # Skip short commands (< 5 chars)
    [[ "${#last_cmd}" -lt 5 ]] && return

    # Deduplicate: skip if same as previous
    [[ "$last_cmd" == "$_ENGRAM_LAST_CMD" ]] && return
    _ENGRAM_LAST_CMD="$last_cmd"

    # Filter boring commands
    local base_cmd="${last_cmd%% *}"
    case "$base_cmd" in
        ls|cd|pwd|clear|exit|cat|head|tail|echo|man|help|history|\
        fg|bg|jobs|alias|which|type|whoami|id|date|uptime|top|htop|\
        ps|free|df|du)
            return
            ;;
    esac

    # Determine importance
    local importance=5
    case "$base_cmd" in
        ssh|docker|docker-compose|podman|git|systemctl|journalctl|\
        npm|npx|yarn|pnpm|cargo|curl|wget|kubectl|helm|terraform)
            importance=7
            ;;
        rm|rsync|scp|dd|mkfs|fdisk|parted|shred)
            importance=8
            ;;
    esac

    # Build content with context
    local hn
    hn="$(hostname 2>/dev/null || echo 'unknown')"
    local cwd
    cwd="$(pwd 2>/dev/null || echo '?')"
    local content="[${hn}:${cwd}] ${last_cmd}"
    local src="shell@${hn}"

    # Build auth header
    local auth_header=""
    if [[ -n "${ENGRAM_API_KEY:-}" ]]; then
        auth_header="-H \"Authorization: Bearer ${ENGRAM_API_KEY}\""
    fi

    # Store in background so we never block the terminal
    eval curl -s -o /dev/null -X POST \
        "${engram_url}/store" \
        -H '"Content-Type: application/json"' \
        ${auth_header} \
        -d "'$(printf '{"content":"%s","category":"task","source":"%s","importance":%d}' \
            "$(echo "$content" | sed 's/"/\\"/g; s/\\/\\\\/g')" \
            "$src" \
            "$importance")'" \
        &>/dev/null &
}

# Install hook based on shell
if [[ -n "$ZSH_VERSION" ]]; then
    autoload -Uz add-zsh-hook 2>/dev/null
    if typeset -f add-zsh-hook >/dev/null 2>&1; then
        add-zsh-hook precmd _engram_store_cmd
    else
        precmd_functions+=(_engram_store_cmd)
    fi
else
    if [[ -n "$PROMPT_COMMAND" ]]; then
        PROMPT_COMMAND="_engram_store_cmd;${PROMPT_COMMAND}"
    else
        PROMPT_COMMAND="_engram_store_cmd"
    fi
fi
