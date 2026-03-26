#!/bin/bash
# Start an ephemeral staging instance of Engram on port 4201
# Run this when you need to make and test changes
# When done: promote.sh (keep changes) or stop-staging.sh (discard)
set -euo pipefail

PROD_REPO="/opt/engram/repo"
STAGING_DIR="/opt/engram/staging"
STAGING_PORT=4201
STAGING_DB="/opt/engram/staging-data/staging.db"

if [[ -d "$STAGING_DIR" ]]; then
  echo "ERROR: Staging dir already exists. Is staging already running?"
  echo "  To stop: /opt/engram/stop-staging.sh"
  exit 1
fi

echo "=== Starting Engram staging instance ==="

mkdir -p "$STAGING_DIR" /opt/engram/staging-data
cp -r "$PROD_REPO/src" "$STAGING_DIR/"
cp "$PROD_REPO/server-split.ts" "$STAGING_DIR/"
cp "$PROD_REPO/tsconfig.json" "$STAGING_DIR/"
cp "$PROD_REPO/package.json" "$STAGING_DIR/"
cp "$PROD_REPO/package-lock.json" "$STAGING_DIR/"
ln -s "$PROD_REPO/node_modules" "$STAGING_DIR/node_modules"

# Write staging .env with overridden port and DB
cp "$PROD_REPO/.env" "$STAGING_DIR/.env"
if grep -q '^PORT=' "$STAGING_DIR/.env"; then
  sed -i "s|^PORT=.*|PORT=$STAGING_PORT|" "$STAGING_DIR/.env"
else
  echo "PORT=$STAGING_PORT" >> "$STAGING_DIR/.env"
fi
if grep -q '^DB_PATH=' "$STAGING_DIR/.env"; then
  sed -i "s|^DB_PATH=.*|DB_PATH=$STAGING_DB|" "$STAGING_DIR/.env"
else
  echo "DB_PATH=$STAGING_DB" >> "$STAGING_DIR/.env"
fi

cd "$STAGING_DIR"
nohup node --experimental-strip-types --env-file=.env server-split.ts > /tmp/engram-staging.log 2>&1 &
echo $! > /tmp/engram-staging.pid

sleep 6
if kill -0 "$(cat /tmp/engram-staging.pid)" 2>/dev/null; then
  echo "Staging running on port $STAGING_PORT (pid $(cat /tmp/engram-staging.pid))"
  echo "Logs:      tail -f /tmp/engram-staging.log"
  echo "Test:      curl http://localhost:$STAGING_PORT/health"
  echo "Promote:   /opt/engram/promote.sh"
  echo "Discard:   /opt/engram/stop-staging.sh"
else
  echo "FATAL: Staging failed to start"
  cat /tmp/engram-staging.log
  rm -rf "$STAGING_DIR"
  exit 1
fi
