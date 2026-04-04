#!/bin/bash
# ============================================================================
# Engram Nightly Backup Sync to Rocky
# Rsyncs /opt/engram/data/ to Rocky Linux backup server.
# Runs via root crontab: 0 2 * * * (2am UTC daily)
#
# Setup:
#   ssh-keygen -t ed25519 -f ~/.ssh/sync_key -N ''
#   ssh-copy-id -i ~/.ssh/sync_key.pub user@<backup-server>
#   crontab -e  (add the cron line below)
#
# Cron entry (root crontab on deployment host):
#   0 2 * * * /opt/engram/repo/scripts/sync-to-rocky.sh >> /tmp/engram-sync.log 2>&1
# ============================================================================

set -euo pipefail

ENGRAM_DATA="/opt/engram/data/"
ROCKY_TARGET="user@<backup-server>:/path/to/engram-backup/"
SSH_KEY="$HOME/.ssh/sync_key"
LOG_DATE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')

echo "[$LOG_DATE] Starting Engram backup sync to Rocky..."
rsync -az   -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no"   "$ENGRAM_DATA"   "$ROCKY_TARGET"
echo "[$LOG_DATE] Sync complete."
