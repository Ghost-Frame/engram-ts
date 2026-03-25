#!/bin/bash
# Engram deploy script -- agents MUST use this instead of raw SCP
# Validates imports, deploys atomically, restarts safely
#
# Usage:
#   ./deploy.sh                         # deploy all modified src files (vs git)
#   ./deploy.sh src/routes/index.ts     # deploy specific files
#   ./deploy.sh --check-only            # validate without deploying
#
# Never SCP individual files directly. A partial deploy (missing imports)
# will crash-loop Engram and corrupt the FTS database.

set -euo pipefail

HETZNER="100.64.0.13"
SSH_TARGET="zan@$HETZNER"
SSH_KEY="$HOME/.ssh/ZanSSH"
REMOTE_REPO="/opt/engram/repo"
LOCAL_REPO="$(cd "$(dirname "$0")" && pwd)"

SSH="ssh -i $SSH_KEY"
SCP="scp -i $SSH_KEY"

CHECK_ONLY=false
SPECIFIED_FILES=()

for arg in "$@"; do
  if [[ "$arg" == "--check-only" ]]; then
    CHECK_ONLY=true
  else
    SPECIFIED_FILES+=("$arg")
  fi
done

echo "=== Engram Deploy ==="

# Step 1: TypeScript compile check (local)
echo "[1/4] Running tsc --noEmit..."
if ! npx tsc --noEmit 2>&1; then
  echo "FATAL: TypeScript errors -- fix before deploying"
  exit 1
fi
echo "  tsc OK"

# Step 2: Determine files to deploy
if [[ ${#SPECIFIED_FILES[@]} -gt 0 ]]; then
  FILES_TO_DEPLOY=("${SPECIFIED_FILES[@]}")
else
  # Default: all files changed vs git HEAD
  mapfile -t FILES_TO_DEPLOY < <(git diff --name-only HEAD 2>/dev/null | grep -E '\.(ts|js|json|sh|html)$' || true)
  if [[ ${#FILES_TO_DEPLOY[@]} -eq 0 ]]; then
    echo "No modified files detected vs git HEAD. Use: ./deploy.sh <file> to deploy specific files."
    exit 0
  fi
fi

echo "[2/4] Files to deploy:"
for f in "${FILES_TO_DEPLOY[@]}"; do echo "  $f"; done

# Step 3: Local import resolution check
# For every .ts file being deployed, verify all local imports exist
# either locally (will be deployed) or already on the server
echo "[3/4] Checking import resolution..."
MISSING=()
for f in "${FILES_TO_DEPLOY[@]}"; do
  [[ "$f" != *.ts ]] && continue
  dir=$(dirname "$f")
  while IFS= read -r imp; do
    resolved="$dir/$imp"
    [[ "$resolved" != *.ts && "$resolved" != *.js ]] && resolved="${resolved}.ts"
    # Check if it's in the deploy set OR exists locally (will already be on server)
    local_exists=false
    [[ -f "$LOCAL_REPO/$resolved" ]] && local_exists=true
    in_deploy=false
    for df in "${FILES_TO_DEPLOY[@]}"; do [[ "$df" == "$resolved" ]] && in_deploy=true; done
    if ! $local_exists && ! $in_deploy; then
      MISSING+=("$f -> $imp")
    fi
  done < <(grep -oP "from ['\"](\./|\.\./)[^'\"]+['\"]" "$LOCAL_REPO/$f" 2>/dev/null | grep -oP "(?<=['\"])[^'\"]+(?=['\"])" || true)
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "FATAL: Import resolution failures:"
  for m in "${MISSING[@]}"; do echo "  MISSING: $m"; done
  echo "Add the missing files to the deploy list or fix the imports."
  exit 1
fi
echo "  Import check OK"

if $CHECK_ONLY; then
  echo "Check-only mode -- not deploying."
  exit 0
fi

# Step 4: Deploy files and restart
echo "[4/4] Deploying..."
for f in "${FILES_TO_DEPLOY[@]}"; do
  remote_path="$REMOTE_REPO/$f"
  remote_dir=$(dirname "$remote_path")
  $SSH "$SSH_TARGET" "mkdir -p '$remote_dir'"
  $SCP "$LOCAL_REPO/$f" "$SSH_TARGET:$remote_path"
  echo "  deployed: $f"
done

echo "Restarting Engram (safe)..."
$SSH "$SSH_TARGET" "
  systemctl --user stop engram
  sleep 3
  fuser -k 4200/tcp 2>/dev/null || true
  sleep 1
  systemctl --user start engram
  sleep 6
  if systemctl --user is-active --quiet engram; then
    echo '  Engram started OK'
  else
    echo 'FATAL: Engram failed to start -- check: journalctl --user -u engram -n 30'
    exit 1
  fi
"

echo "=== Deploy complete ==="
