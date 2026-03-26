#!/bin/bash
# Promote tested staging changes to production
# This unlocks prod source, copies from staging, re-locks, restarts prod
set -euo pipefail

PROD_REPO="/opt/engram/repo"
STAGING_DIR="/opt/engram/staging"

if [[ ! -d "$STAGING_DIR" ]]; then
  echo "ERROR: No staging dir found. Run /opt/engram/start-staging.sh first."
  exit 1
fi

echo "=== Promoting staging to production ==="

# Stop staging
if [[ -f /tmp/engram-staging.pid ]]; then
  kill "$(cat /tmp/engram-staging.pid)" 2>/dev/null || true
  rm -f /tmp/engram-staging.pid
  echo "Staging stopped."
fi

# Unlock prod source files
echo "Unlocking production source..."
find "$PROD_REPO/src" -name '*.ts' -exec sudo chattr -i {} \;
sudo chattr -i "$PROD_REPO/server-split.ts" 2>/dev/null || true

# Copy staged source over production
echo "Copying staged files to production..."
rsync -a --delete "$STAGING_DIR/src/" "$PROD_REPO/src/"
cp "$STAGING_DIR/server-split.ts" "$PROD_REPO/server-split.ts"

# Re-lock production
echo "Re-locking production source..."
find "$PROD_REPO/src" -name '*.ts' -exec sudo chattr +i {} \;
sudo chattr +i "$PROD_REPO/server-split.ts"

# Clean up staging
rm -rf "$STAGING_DIR" /opt/engram/staging-data
echo "Staging cleaned up."

# Restart production
echo "Restarting production Engram..."
systemctl --user stop engram
sleep 3
fuser -k 4200/tcp 2>/dev/null || true
sleep 1
systemctl --user start engram
sleep 8

if systemctl --user is-active --quiet engram; then
  echo "=== Promote complete. Production is running. ==="
else
  echo "FATAL: Production failed to start after promote."
  echo "Check: journalctl --user -u engram -n 30"
  exit 1
fi
