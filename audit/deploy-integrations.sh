#!/bin/bash
# Deploy Engram integrations to hetzner-zan
# Run from the engram project root on Windows
set -euo pipefail

HETZNER="100.64.0.13"
SSH_TARGET="zan@$HETZNER"
ENGRAM_PORT=4200
N8N_PORT=5678

echo "=== Engram Integration Deployment ==="
echo "Target: $SSH_TARGET"
echo

# 1. Deploy Open WebUI pipeline
echo "[1/4] Deploying Open WebUI Engram RAG pipeline..."
OWUI_DATA=$(ssh $SSH_TARGET "podman inspect open-webui 2>/dev/null | python3 -c \"import sys,json; mounts=json.load(sys.stdin)[0].get('Mounts',[]); [print(m['Source']) for m in mounts if '/data' in m.get('Destination','')]\" 2>/dev/null || echo '/home/zan/services/open-webui/data'")
echo "  Open WebUI data dir: $OWUI_DATA"
ssh $SSH_TARGET "mkdir -p $OWUI_DATA/pipelines"
scp audit/n8n-workflows/engram_rag_filter.py "$SSH_TARGET:$OWUI_DATA/pipelines/"
echo "  Pipeline deployed. Restarting Open WebUI..."
ssh $SSH_TARGET "podman restart open-webui 2>/dev/null || echo 'Could not restart open-webui container'"
echo

# 2. Import n8n workflows
echo "[2/4] Importing n8n workflows..."
for wf in audit/n8n-workflows/*.json; do
  name=$(basename "$wf")
  echo "  Importing $name..."
  scp "$wf" "$SSH_TARGET:/tmp/$name"
  ssh $SSH_TARGET "curl -sf http://127.0.0.1:$N8N_PORT/api/v1/workflows -X POST -H 'Content-Type: application/json' -d @/tmp/$name > /dev/null 2>&1 && echo '    OK' || echo '    Manual import needed: /tmp/$name'"
done
echo

# 3. Create Engram API key for integrations
echo "[3/4] Creating Engram API key for n8n..."
KEY_RESPONSE=$(ssh $SSH_TARGET "curl -sf http://127.0.0.1:$ENGRAM_PORT/keys -X POST -H 'Authorization: Bearer \$ENGRAM_API_KEY' -H 'Content-Type: application/json' -d '{\"name\": \"n8n-automation\", \"scopes\": \"read,write\"}' 2>/dev/null || echo '{}'")
echo "  Response: $KEY_RESPONSE"
echo "  SAVE THIS KEY -- configure it in n8n credentials"
echo

# 4. Register webhook
echo "[4/4] Registering Engram webhook for n8n..."
ssh $SSH_TARGET "curl -sf http://127.0.0.1:$ENGRAM_PORT/webhooks -X POST -H 'Authorization: Bearer \$ENGRAM_API_KEY' -H 'Content-Type: application/json' -d '{\"url\": \"http://127.0.0.1:$N8N_PORT/webhook/engram-events\", \"events\": [\"memory.created\", \"memory.approved\", \"reflection.created\"], \"secret\": \"engram-n8n-secret-$(date +%s)\"}' 2>/dev/null || echo 'Webhook registration may need SSRF allowlist (Phase 1)'"
echo

echo "=== Deployment Complete ==="
echo
echo "Manual steps:"
echo "  1. Configure n8n Engram API Key credential with the key above"
echo "  2. Configure Open WebUI pipeline Valves (engram_url, engram_api_key)"
echo "  3. Activate n8n workflows"
echo "  4. Test: store a memory in Engram, verify n8n receives webhook"
echo "  5. Test: chat in Open WebUI, verify Engram context appears"
