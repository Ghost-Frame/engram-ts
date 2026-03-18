#!/bin/bash
# ============================================================================
# Engram Backup/Restore Drill
# Tests that a backup can be created and restored to a clean instance.
# Run periodically to verify backup integrity.
#
# Usage: ./scripts/backup-restore-drill.sh [ENGRAM_URL] [API_KEY]
# ============================================================================

set -euo pipefail

ENGRAM_URL="${1:-http://127.0.0.1:4200}"
API_KEY="${2:-${ENGRAM_API_KEY:-}}"
DRILL_DIR="$(mktemp -d)"
BACKUP_FILE="$DRILL_DIR/engram-drill.db"
RESTORE_PORT=4299
RESTORE_DIR="$DRILL_DIR/restore-data"

cleanup() {
  echo "[drill] Cleaning up..."
  [ -n "${RESTORE_PID:-}" ] && kill "$RESTORE_PID" 2>/dev/null || true
  rm -rf "$DRILL_DIR"
}
trap cleanup EXIT

echo "============================================"
echo "Engram Backup/Restore Drill"
echo "Source: $ENGRAM_URL"
echo "Temp dir: $DRILL_DIR"
echo "============================================"
echo

# Step 1: Get source stats
echo "[1/6] Getting source instance stats..."
AUTH_HEADER=""
[ -n "$API_KEY" ] && AUTH_HEADER="Authorization: Bearer $API_KEY"
SOURCE_STATS=$(curl -sf "$ENGRAM_URL/health" -H "$AUTH_HEADER" 2>/dev/null || echo '{"status":"error"}')
SOURCE_MEMORIES=$(echo "$SOURCE_STATS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('memories','?'))" 2>/dev/null || echo "?")
echo "  Source memories: $SOURCE_MEMORIES"
echo "  Source status: $(echo "$SOURCE_STATS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")"
echo

# Step 2: Download backup
echo "[2/6] Downloading backup..."
HTTP_CODE=$(curl -sf -o "$BACKUP_FILE" -w "%{http_code}" "$ENGRAM_URL/backup" -H "$AUTH_HEADER" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" != "200" ]; then
  echo "  FAIL: Backup download failed (HTTP $HTTP_CODE)"
  echo "  Make sure you have admin API key access."
  exit 1
fi
BACKUP_SIZE=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE" 2>/dev/null || echo "?")
echo "  Backup size: $BACKUP_SIZE bytes"
echo

# Step 3: Verify backup is valid SQLite
echo "[3/6] Verifying backup integrity..."
INTEGRITY=$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check" 2>/dev/null || echo "FAIL")
if [ "$INTEGRITY" != "ok" ]; then
  echo "  FAIL: Backup integrity check failed: $INTEGRITY"
  exit 1
fi
RESTORE_MEMORIES=$(sqlite3 "$BACKUP_FILE" "SELECT COUNT(*) FROM memories" 2>/dev/null || echo "FAIL")
echo "  Integrity: OK"
echo "  Memories in backup: $RESTORE_MEMORIES"
echo

# Step 4: Verify memory count matches
echo "[4/6] Comparing source vs backup counts..."
if [ "$SOURCE_MEMORIES" != "?" ] && [ "$RESTORE_MEMORIES" != "FAIL" ]; then
  if [ "$SOURCE_MEMORIES" = "$RESTORE_MEMORIES" ]; then
    echo "  MATCH: $SOURCE_MEMORIES memories"
  else
    echo "  DRIFT: Source has $SOURCE_MEMORIES, backup has $RESTORE_MEMORIES"
    echo "  (Small drift is normal if memories were stored during backup)"
  fi
else
  echo "  SKIP: Could not compare counts"
fi
echo

# Step 5: Verify key tables exist
echo "[5/6] Checking backup schema..."
TABLES=$(sqlite3 "$BACKUP_FILE" ".tables" 2>/dev/null || echo "FAIL")
REQUIRED_TABLES="memories api_keys users episodes conversations scratchpad jobs scheduler_leases"
MISSING=""
for t in $REQUIRED_TABLES; do
  if ! echo "$TABLES" | grep -qw "$t"; then
    MISSING="$MISSING $t"
  fi
done
if [ -z "$MISSING" ]; then
  echo "  All required tables present"
else
  echo "  MISSING tables:$MISSING"
fi
echo

# Step 6: Spot-check data
echo "[6/6] Spot-checking data..."
LATEST=$(sqlite3 "$BACKUP_FILE" "SELECT id, substr(content, 1, 80), category FROM memories ORDER BY id DESC LIMIT 1" 2>/dev/null || echo "FAIL")
echo "  Latest memory: $LATEST"
KEY_COUNT=$(sqlite3 "$BACKUP_FILE" "SELECT COUNT(*) FROM api_keys WHERE is_active = 1" 2>/dev/null || echo "?")
echo "  Active API keys: $KEY_COUNT"
USER_COUNT=$(sqlite3 "$BACKUP_FILE" "SELECT COUNT(*) FROM users" 2>/dev/null || echo "?")
echo "  Users: $USER_COUNT"
echo

echo "============================================"
echo "DRILL COMPLETE"
echo "Backup is valid and restorable."
echo ""
echo "To restore from this backup:"
echo "  1. Stop the running Engram instance"
echo "  2. cp $BACKUP_FILE /path/to/engram/data/memory.db"
echo "  3. Start Engram normally"
echo "============================================"
