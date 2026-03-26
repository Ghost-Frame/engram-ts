#!/bin/bash
# Discard staging without promoting -- production unchanged
set -euo pipefail

STAGING_DIR="/opt/engram/staging"

echo "=== Discarding staging (production unchanged) ==="

if [[ -f /tmp/engram-staging.pid ]]; then
  kill "$(cat /tmp/engram-staging.pid)" 2>/dev/null || true
  rm -f /tmp/engram-staging.pid
  echo "Staging process stopped."
fi

if [[ -d "$STAGING_DIR" ]]; then
  rm -rf "$STAGING_DIR" /opt/engram/staging-data
  echo "Staging files removed."
fi

echo "Done. Production Engram was not touched."
