#!/usr/bin/env bash
# ============================================================================
# Engram Shell History Search
# ============================================================================
#
# Search your stored shell history from Engram.
#
# USAGE:
#   shellhist what docker commands did I run
#   shellhist ssh deploy production
#
# CONFIG:
#   export ENGRAM_URL="http://127.0.0.1:4200"   # default
#   export ENGRAM_API_KEY="your-api-key"         # optional auth
#
# TIP: alias this in your shell:
#   alias shellhist='bash /path/to/shell-search.sh'
#
# ============================================================================

set -euo pipefail

if [[ $# -eq 0 ]]; then
    echo "Usage: shell-search.sh <query...>"
    echo "Example: shell-search.sh docker compose restart"
    exit 1
fi

ENGRAM_URL="${ENGRAM_URL:-http://127.0.0.1:4200}"
QUERY="$*"

# Build auth header args
auth_args=()
if [[ -n "${ENGRAM_API_KEY:-}" ]]; then
    auth_args=(-H "Authorization: Bearer ${ENGRAM_API_KEY}")
fi

# Search Engram
response="$(curl -s -X POST "${ENGRAM_URL}/search" \
    -H "Content-Type: application/json" \
    "${auth_args[@]}" \
    -d "$(printf '{"query":"%s","limit":20}' "$(echo "$QUERY" | sed 's/"/\\"/g')")"
)"

if [[ -z "$response" ]] || ! echo "$response" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    echo "Error: could not reach Engram at ${ENGRAM_URL}"
    exit 1
fi

# Filter to shell@ sources and format output
echo "$response" | python3 -c "
import sys, json
from datetime import datetime

data = json.load(sys.stdin)
results = data if isinstance(data, list) else data.get('results', data.get('memories', []))

found = 0
for r in results:
    src = r.get('source', '')
    if 'shell@' not in src:
        continue
    found += 1
    content = r.get('content', '')
    ts = r.get('timestamp', r.get('created_at', ''))
    hostname = src.replace('shell@', '')
    # Parse timestamp
    date_str = ''
    if ts:
        try:
            dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            date_str = dt.strftime('%Y-%m-%d %H:%M')
        except Exception:
            date_str = ts[:16]
    # Strip the [host:cwd] prefix from content if present for cleaner display
    cmd = content
    cwd = ''
    if content.startswith('['):
        bracket_end = content.find('] ')
        if bracket_end > 0:
            meta = content[1:bracket_end]
            cmd = content[bracket_end+2:]
            if ':' in meta:
                cwd = meta.split(':', 1)[1]
    print(f'  {date_str}  {hostname:15s}  {cwd:30s}  {cmd}')

if found == 0:
    print('No shell history found for that query.')
else:
    print(f'\n  ({found} results)')
"
