# Engram Integration Plan: Open WebUI + n8n + Ollama

**Date:** 2026-03-21
**Author:** Quantum (audit agent)
**Deployment:** hetzner-zan (100.64.0.13)

Step-by-step implementation plan for an AI coding agent (Sonnet).
Each task includes exact file paths, deployment commands, and acceptance criteria.
Do NOT deviate. Do NOT improvise. Do NOT use em dashes anywhere.

---

## CURRENT STATE

| Service | Host | Port | Tailscale IP | Status |
|---------|------|------|-------------|--------|
| Engram | hetzner-zan | 4200 | 100.64.0.13 | Running, v5.8.3 |
| Ollama | hetzner-zan | 11434 | 100.64.0.13 | Running, qwen2.5:14b |
| Open WebUI | hetzner-zan | 3200 | 100.64.0.13 | Running, connects to Ollama |
| n8n | hetzner-zan | 5678 | 100.64.0.13 | Running, rootless podman |

All services are on the same box. They can reach each other via localhost or 127.0.0.1.
Engram's SSRF protection blocks localhost webhook URLs, so n8n webhooks must use the
Tailscale IP (100.64.0.13) or a domain name.

**IMPORTANT:** Engram blocks private IPs in webhook URLs (100.64.* is in the private range).
This means we need to either:
(a) Add a config flag to allow Tailscale IPs in webhooks, OR
(b) Use domain names (e.g., n8n.zanfiel.com) for webhook URLs, OR
(c) Modify the SSRF check to allow a configurable allowlist

We will use option (c) since it's the most flexible for self-hosted deployments.

---

## TABLE OF CONTENTS

- [PHASE 1: SSRF Allowlist for Internal Services](#phase-1-ssrf-allowlist-for-internal-services)
- [PHASE 2: Open WebUI Pipeline - Engram RAG](#phase-2-open-webui-pipeline----engram-rag)
- [PHASE 3: Open WebUI Pipeline - Conversation Memory](#phase-3-open-webui-pipeline----conversation-memory)
- [PHASE 4: n8n Webhook Receiver](#phase-4-n8n-webhook-receiver)
- [PHASE 5: n8n Maintenance Workflows](#phase-5-n8n-maintenance-workflows)
- [PHASE 6: n8n Agent Loop - Daily Reflection](#phase-6-n8n-agent-loop----daily-reflection)
- [PHASE 7: Wiring and Verification](#phase-7-wiring-and-verification)

---

## PHASE 1: SSRF Allowlist for Internal Services

**Problem:** Engram's `isPrivateHostname()` in `src/helpers/index.ts` blocks ALL private IPs
including Tailscale addresses (100.64.*). This prevents webhooks from reaching n8n on the
same Tailscale network. We need an allowlist for trusted internal services.

**Files to modify:**
- `src/config/index.ts`
- `src/helpers/index.ts`

### Task 1.1: Add webhook allowlist config

In `src/config/index.ts`, after the `ALLOWED_IPS` line (line 118), add:

```typescript
// Webhook SSRF allowlist: IPs/hostnames that bypass private IP checks for webhooks
// Used for self-hosted services on the same network (e.g., n8n on Tailscale)
export const WEBHOOK_ALLOWED_HOSTS = (process.env.ENGRAM_WEBHOOK_ALLOWED_HOSTS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
```

### Task 1.2: Modify SSRF check to respect allowlist

In `src/helpers/index.ts`, find the `isPrivateHostname` function (or wherever the webhook
URL validation happens). The function checks hostnames against private ranges.

Add an allowlist bypass. Find the function signature and add a parameter:

```typescript
import { WEBHOOK_ALLOWED_HOSTS } from "../config/index.ts";
```

Then find the check that runs before webhook dispatch. There are two places SSRF is validated:

1. `validatePublicWebhookUrl()` - called at registration time
2. The dispatch-time DNS rebinding check in `webhooks.ts`

For both, add an early return if the hostname is in the allowlist:

```typescript
// At the top of the validation function, before any private IP checks:
if (WEBHOOK_ALLOWED_HOSTS.length > 0) {
  const urlObj = new URL(url);
  if (WEBHOOK_ALLOWED_HOSTS.includes(urlObj.hostname)) {
    return; // Trusted internal host, skip SSRF check
  }
}
```

Read `src/helpers/index.ts` and `src/platform/webhooks.ts` to find the exact function names
and modify them. The pattern will be clear - look for where `isPrivateHostname` is called
and add the allowlist check before it.

### Task 1.3: Set the env var on Hetzner

This is a deployment step, not a code change. After deploying, set:

```
ENGRAM_WEBHOOK_ALLOWED_HOSTS=100.64.0.13,127.0.0.1,localhost
```

**Acceptance criteria:**
- Webhook registration with `http://100.64.0.13:5678/webhook/...` succeeds
- Webhook registration with `http://10.0.0.1:1234/evil` still fails (not in allowlist)
- Empty ENGRAM_WEBHOOK_ALLOWED_HOSTS preserves existing behavior (all private IPs blocked)
- Both registration-time and dispatch-time validation respect the allowlist

---

## PHASE 2: Open WebUI Pipeline - Engram RAG

**Goal:** Create an Open WebUI Filter pipeline that intercepts every chat message, queries
Engram for relevant context, and injects it into the system prompt before Ollama sees it.
This gives every Open WebUI conversation access to Engram's full memory.

**Files to create:**
- Pipeline Python file (deployed to Open WebUI's pipeline directory on Hetzner)

### Task 2.1: Create the Engram RAG filter pipeline

Create this file on the Hetzner server. The file path depends on how Open WebUI's pipeline
directory is configured. Check the Open WebUI container's data directory.

SSH into hetzner-zan and determine the pipeline directory:

```bash
# Check Open WebUI container for pipeline dir
podman exec <open-webui-container-name> ls /app/backend/data/pipelines/ 2>/dev/null || echo "no pipelines dir"

# If pipelines dir doesn't exist, create it
podman exec <open-webui-container-name> mkdir -p /app/backend/data/pipelines/
```

If Open WebUI is running with a volume mount for data, the pipelines directory will be
at `<data-volume>/pipelines/` on the host. Find it:

```bash
podman inspect <open-webui-container-name> | grep -A5 Mounts
```

Create the file `engram_rag_filter.py` at whatever path maps to
`/app/backend/data/pipelines/` inside the container:

```python
"""
title: Engram RAG Filter
description: Injects Engram memory context into every conversation before LLM processing
author: zan
version: 1.0.0
requirements: aiohttp
"""

from pydantic import BaseModel, Field
from typing import Optional
import aiohttp
import json
import time


class Pipeline:
    class Valves(BaseModel):
        engram_url: str = Field(
            default="http://127.0.0.1:4200",
            description="Engram API base URL",
        )
        engram_api_key: str = Field(
            default="",
            description="Engram API key (eg_...)",
        )
        context_budget: int = Field(
            default=3000,
            description="Max token budget for injected context",
        )
        search_limit: int = Field(
            default=8,
            description="Max memories to retrieve per query",
        )
        min_score: float = Field(
            default=0.3,
            description="Minimum relevance score to include a memory",
        )
        enabled: bool = Field(
            default=True,
            description="Enable/disable Engram context injection",
        )
        source_tag: str = Field(
            default="open-webui",
            description="Source tag for stored memories",
        )

    def __init__(self):
        self.valves = self.Valves()

    async def inlet(self, body: dict, __user__: dict) -> dict:
        """
        Before LLM: fetch relevant context from Engram and inject into system message.
        """
        if not self.valves.enabled or not self.valves.engram_api_key:
            return body

        messages = body.get("messages", [])
        if not messages:
            return body

        # Get the latest user message as the query
        user_messages = [m for m in messages if m.get("role") == "user"]
        if not user_messages:
            return body

        query = user_messages[-1].get("content", "").strip()
        if not query or len(query) < 3:
            return body

        # Call Engram /context for budget-aware retrieval
        try:
            context_text = await self._fetch_context(query)
        except Exception:
            # Engram is down or unreachable -- don't block the conversation
            return body

        if not context_text:
            return body

        # Inject context into system message
        context_block = (
            "You have access to the user's memory system. "
            "The following relevant memories were retrieved:\n\n"
            f"{context_text}\n\n"
            "Use these memories to inform your response when relevant. "
            "Do not mention the memory system unless the user asks about it."
        )

        # Find existing system message or create one
        system_idx = None
        for i, m in enumerate(messages):
            if m.get("role") == "system":
                system_idx = i
                break

        if system_idx is not None:
            messages[system_idx]["content"] = (
                messages[system_idx]["content"] + "\n\n" + context_block
            )
        else:
            messages.insert(0, {"role": "system", "content": context_block})

        body["messages"] = messages
        return body

    async def outlet(self, body: dict, __user__: dict) -> dict:
        """
        After LLM: no-op for now. Phase 3 adds conversation storage.
        """
        return body

    async def _fetch_context(self, query: str) -> str:
        """Call Engram /context endpoint for budget-aware retrieval."""
        headers = {
            "Authorization": f"Bearer {self.valves.engram_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "query": query,
            "budget": self.valves.context_budget,
        }

        timeout = aiohttp.ClientTimeout(total=5)  # 5 second timeout
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.valves.engram_url}/context",
                json=payload,
                headers=headers,
            ) as resp:
                if resp.status != 200:
                    return ""
                data = await resp.json()

        # Format context from response
        # /context returns a structured response with memories
        memories = data.get("memories", data.get("results", []))
        if not memories:
            # /context might return a plain text "context" field
            return data.get("context", "")

        lines = []
        for mem in memories:
            content = mem.get("content", "")
            category = mem.get("category", "")
            score = mem.get("score", 0)
            if score < self.valves.min_score:
                continue
            created = mem.get("created_at", "")[:10]
            lines.append(f"- [{category}] ({created}) {content}")

        return "\n".join(lines[: self.valves.search_limit])
```

### Task 2.2: Configure the pipeline in Open WebUI

After placing the file, restart Open WebUI (or it will auto-detect on next startup):

```bash
podman restart <open-webui-container-name>
```

Then in Open WebUI admin panel:
1. Go to Admin Panel > Settings > Pipelines (or Workspace > Functions)
2. The Engram RAG Filter should appear
3. Click on it to configure Valves:
   - `engram_url`: `http://127.0.0.1:4200` (same host, use localhost)
   - `engram_api_key`: Create a dedicated key via Engram's POST /keys
   - `context_budget`: 3000
   - `search_limit`: 8
   - `enabled`: true
4. Enable the pipeline for all models

NOTE: If Open WebUI uses the Pipelines Server (port 9099) instead of built-in pipelines,
deploy the file to the Pipelines Server's directory instead. Check which architecture is
in use:

```bash
podman ps | grep -i pipeline
```

If there's a separate pipelines container, put the file there.

**Acceptance criteria:**
- Open WebUI shows the Engram RAG Filter in admin panel
- When chatting, Engram context appears in LLM responses (test by asking about something
  only Engram would know)
- If Engram is down, conversations still work (graceful fallback)
- Pipeline Valves are configurable in the admin UI

---

## PHASE 3: Open WebUI Pipeline - Conversation Memory

**Goal:** Extend the pipeline to store Open WebUI conversations back into Engram after each
exchange. This creates a bidirectional loop: Engram feeds context into conversations, and
conversations feed back into Engram.

**Files to modify:**
- The same pipeline file from Phase 2

### Task 3.1: Add outlet handler for conversation storage

Replace the `outlet` method in `engram_rag_filter.py`:

```python
    async def outlet(self, body: dict, __user__: dict) -> dict:
        """
        After LLM: store the conversation exchange in Engram.
        Only stores if the response is substantial (not just greetings/errors).
        """
        if not self.valves.enabled or not self.valves.engram_api_key:
            return body

        messages = body.get("messages", [])
        if len(messages) < 2:
            return body

        # Get the last user message and assistant response
        user_msg = None
        assistant_msg = None
        for m in reversed(messages):
            if m.get("role") == "assistant" and assistant_msg is None:
                assistant_msg = m.get("content", "")
            elif m.get("role") == "user" and user_msg is None:
                user_msg = m.get("content", "")
            if user_msg and assistant_msg:
                break

        if not user_msg or not assistant_msg:
            return body

        # Skip trivial exchanges
        if len(user_msg) < 20 and len(assistant_msg) < 50:
            return body

        # Build a condensed exchange to store
        exchange = f"User asked: {user_msg}\nAssistant answered: {assistant_msg[:500]}"

        try:
            await self._store_memory(exchange)
        except Exception:
            pass  # Don't break the response if storage fails

        return body

    async def _store_memory(self, content: str) -> None:
        """Store a conversation exchange in Engram."""
        headers = {
            "Authorization": f"Bearer {self.valves.engram_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "content": content,
            "category": "conversation",
            "source": self.valves.source_tag,
            "importance": 4,
            "tags": ["open-webui", "chat"],
        }

        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.valves.engram_url}/store",
                json=payload,
                headers=headers,
            ) as resp:
                pass  # Fire and forget
```

### Task 3.2: Add conversation-level storage via /conversations

For richer storage, also store the full conversation using Engram's conversation API.
Add this additional method and call it from outlet:

```python
    async def _store_conversation(self, messages: list, model: str) -> None:
        """Store full conversation in Engram's conversation tracking."""
        headers = {
            "Authorization": f"Bearer {self.valves.engram_api_key}",
            "Content-Type": "application/json",
        }

        # Filter to just user/assistant messages (no system)
        conv_messages = [
            {"role": m["role"], "content": m.get("content", "")}
            for m in messages
            if m.get("role") in ("user", "assistant")
        ]

        if len(conv_messages) < 2:
            return

        payload = {
            "agent": f"open-webui/{model}",
            "title": conv_messages[0]["content"][:100] if conv_messages else "Chat",
            "messages": conv_messages,
        }

        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.valves.engram_url}/conversations",
                json=payload,
                headers=headers,
            ) as resp:
                pass
```

Then at the end of the `outlet` method, before `return body`, add:

```python
        # Also store full conversation
        model = body.get("model", "unknown")
        try:
            await self._store_conversation(messages, model)
        except Exception:
            pass
```

### Task 3.3: Add Valve to control storage behavior

Add to the Valves class:

```python
        store_conversations: bool = Field(
            default=True,
            description="Store conversation exchanges back into Engram",
        )
        min_exchange_length: int = Field(
            default=20,
            description="Minimum user message length to trigger storage",
        )
```

Then update the outlet method to check `self.valves.store_conversations`.

**Acceptance criteria:**
- After each non-trivial exchange, the conversation is stored in Engram
- Trivial exchanges (< 20 chars user message, < 50 chars response) are skipped
- Storage failures don't break the response
- Full conversation also stored via /conversations endpoint
- Configurable via Valves in admin panel

---

## PHASE 4: n8n Webhook Receiver

**Goal:** Register Engram webhooks pointing to n8n, and create n8n workflows that process
memory events in real time.

### Task 4.1: Create Engram API key for n8n

On hetzner-zan, create a dedicated API key for n8n:

```bash
curl -s http://127.0.0.1:4200/keys \
  -X POST \
  -H "Authorization: Bearer $ENGRAM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "n8n-automation", "scopes": "read,write"}'
```

Save the returned key. This will be used in all n8n HTTP Request nodes.

### Task 4.2: Register webhooks in Engram

After Phase 1 deploys (SSRF allowlist), register the n8n webhook:

```bash
curl -s http://127.0.0.1:4200/webhooks \
  -X POST \
  -H "Authorization: Bearer $ENGRAM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://100.64.0.13:5678/webhook/engram-events",
    "events": ["memory.created", "memory.approved", "reflection.created"],
    "secret": "engram-n8n-webhook-secret-2026"
  }'
```

### Task 4.3: Create n8n workflow - Engram Event Router

Create this workflow JSON file. Import it into n8n via the UI (Workflows > Import from File)
or via the n8n API.

Create the file locally, then we'll deploy it.

**File to create:** `audit/n8n-workflows/engram-event-router.json`

```json
{
  "name": "Engram Event Router",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "engram-events",
        "responseMode": "onReceived",
        "options": {}
      },
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [250, 300]
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict"
          },
          "conditions": [
            {
              "id": "1",
              "leftValue": "={{ $json.body.event }}",
              "rightValue": "memory.created",
              "operator": {
                "type": "string",
                "operation": "equals"
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "name": "Is Memory Created?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [480, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://127.0.0.1:4200/search",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ query: $json.body.data.content.substring(0, 200), limit: 3 }) }}",
        "options": {
          "timeout": 10000
        }
      },
      "name": "Find Related Memories",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [720, 200],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "const event = $('Webhook').first().json.body;\nconst related = $('Find Related Memories').first().json.results || [];\n\nconst relatedCount = related.filter(r => r.id !== event.data.id).length;\nconst hasContradiction = related.some(r => r.score > 0.8 && r.content !== event.data.content);\n\nreturn [{\n  json: {\n    event_type: event.event,\n    memory_id: event.data.id,\n    content_preview: event.data.content?.substring(0, 100),\n    category: event.data.category,\n    importance: event.data.importance,\n    related_count: relatedCount,\n    possible_contradiction: hasContradiction,\n    timestamp: event.timestamp\n  }\n}];"
      },
      "name": "Summarize Event",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [960, 200]
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "name": "event",
              "value": "={{ $json.body.event }}",
              "type": "string"
            },
            {
              "name": "data",
              "value": "={{ JSON.stringify($json.body.data) }}",
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "name": "Log Other Event",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [720, 420]
    }
  ],
  "connections": {
    "Webhook": {
      "main": [
        [
          {
            "node": "Is Memory Created?",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Is Memory Created?": {
      "main": [
        [
          {
            "node": "Find Related Memories",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Log Other Event",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Find Related Memories": {
      "main": [
        [
          {
            "node": "Summarize Event",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "settings": {
    "executionOrder": "v1"
  }
}
```

### Task 4.4: Configure n8n credentials

In n8n UI, create an HTTP Header Auth credential:
- Name: `Engram API Key`
- Header Name: `Authorization`
- Header Value: `Bearer eg_<the key from Task 4.1>`

This credential will be referenced by all Engram HTTP Request nodes.

**Acceptance criteria:**
- n8n receives webhook events from Engram when memories are created
- Event is routed based on type (memory.created triggers related search)
- Non-memory events are logged
- n8n can authenticate to Engram's API

---

## PHASE 5: n8n Maintenance Workflows

**Goal:** Create n8n workflows that run Engram maintenance tasks on schedule, replacing
the need for internal cron jobs and giving operators visibility into maintenance status.

### Task 5.1: Create maintenance workflow

**File to create:** `audit/n8n-workflows/engram-maintenance.json`

```json
{
  "name": "Engram Scheduled Maintenance",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "hours",
              "triggerAtHour": 3
            }
          ]
        }
      },
      "name": "Daily 3 AM",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [250, 300]
    },
    {
      "parameters": {
        "method": "GET",
        "url": "http://127.0.0.1:4200/health",
        "options": {
          "timeout": 10000
        }
      },
      "name": "Check Health",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [480, 300],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://127.0.0.1:4200/backup/verify",
        "options": {
          "timeout": 30000
        }
      },
      "name": "Verify DB Integrity",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [720, 200],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://127.0.0.1:4200/admin/gc",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\"dry_run\": false}",
        "options": {
          "timeout": 60000
        }
      },
      "name": "Garbage Collection",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [720, 400],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    },
    {
      "parameters": {
        "method": "GET",
        "url": "http://127.0.0.1:4200/jobs?status=failed",
        "options": {
          "timeout": 10000
        }
      },
      "name": "Check Failed Jobs",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [960, 200],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "const health = $('Check Health').first().json;\nconst integrity = $('Verify DB Integrity').first().json;\nconst gc = $('Garbage Collection').first().json;\nconst failedJobs = $('Check Failed Jobs').first().json;\n\nconst report = {\n  timestamp: new Date().toISOString(),\n  status: health.status || 'unknown',\n  memories: health.memories || 0,\n  db_integrity: integrity.integrity || 'unknown',\n  gc_rows_deleted: gc.reclaimable_rows || 0,\n  failed_jobs: failedJobs.total || 0,\n  issues: []\n};\n\nif (integrity.integrity !== 'ok') report.issues.push('DB integrity check failed');\nif ((failedJobs.total || 0) > 10) report.issues.push(`${failedJobs.total} failed jobs`);\nif (integrity.foreign_key_violations > 0) report.issues.push(`${integrity.foreign_key_violations} FK violations`);\n\nreport.healthy = report.issues.length === 0;\n\nreturn [{ json: report }];"
      },
      "name": "Build Report",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1200, 300]
    }
  ],
  "connections": {
    "Daily 3 AM": {
      "main": [
        [
          {
            "node": "Check Health",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Check Health": {
      "main": [
        [
          {
            "node": "Verify DB Integrity",
            "type": "main",
            "index": 0
          },
          {
            "node": "Garbage Collection",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Verify DB Integrity": {
      "main": [
        [
          {
            "node": "Check Failed Jobs",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Garbage Collection": {
      "main": [
        [
          {
            "node": "Check Failed Jobs",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Check Failed Jobs": {
      "main": [
        [
          {
            "node": "Build Report",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "settings": {
    "executionOrder": "v1"
  }
}
```

### Task 5.2: Create weekly compaction workflow

**File to create:** `audit/n8n-workflows/engram-weekly-compact.json`

```json
{
  "name": "Engram Weekly Compact",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "weeks",
              "triggerAtDay": 0,
              "triggerAtHour": 4
            }
          ]
        }
      },
      "name": "Sunday 4 AM",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [250, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://127.0.0.1:4200/admin/maintenance",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\"enabled\": true, \"reason\": \"Weekly compaction\"}",
        "options": {
          "timeout": 10000
        }
      },
      "name": "Enable Maintenance Mode",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [480, 300],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://127.0.0.1:4200/admin/compact",
        "options": {
          "timeout": 300000
        }
      },
      "name": "Compact Database",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [720, 300],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://127.0.0.1:4200/admin/refresh-cache",
        "options": {
          "timeout": 60000
        }
      },
      "name": "Refresh Cache",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [960, 300],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://127.0.0.1:4200/admin/maintenance",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\"enabled\": false}",
        "options": {
          "timeout": 10000
        }
      },
      "name": "Disable Maintenance Mode",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1200, 300],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    }
  ],
  "connections": {
    "Sunday 4 AM": {
      "main": [[{"node": "Enable Maintenance Mode", "type": "main", "index": 0}]]
    },
    "Enable Maintenance Mode": {
      "main": [[{"node": "Compact Database", "type": "main", "index": 0}]]
    },
    "Compact Database": {
      "main": [[{"node": "Refresh Cache", "type": "main", "index": 0}]]
    },
    "Refresh Cache": {
      "main": [[{"node": "Disable Maintenance Mode", "type": "main", "index": 0}]]
    }
  },
  "settings": {
    "executionOrder": "v1"
  }
}
```

**Acceptance criteria:**
- Daily maintenance runs at 3 AM: health check, integrity verify, GC, failed job check
- Weekly compact runs Sunday 4 AM: maintenance mode on, VACUUM, cache refresh, maintenance mode off
- All workflows use the shared Engram API Key credential
- Workflow execution history visible in n8n UI

---

## PHASE 6: n8n Agent Loop - Daily Reflection

**Goal:** Create an n8n workflow that runs daily, searches Engram for the day's memories,
feeds them to Ollama for synthesis, and stores the reflection back in Engram. This is the
full Search > Ollama > Store loop.

### Task 6.1: Create reflection workflow

**File to create:** `audit/n8n-workflows/engram-daily-reflection.json`

```json
{
  "name": "Engram Daily Reflection",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "hours",
              "triggerAtHour": 23
            }
          ]
        }
      },
      "name": "Daily 11 PM",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [250, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://127.0.0.1:4200/search",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ query: 'What happened today? What was learned, decided, or discovered?', limit: 20, source: null }) }}",
        "options": {
          "timeout": 30000
        }
      },
      "name": "Search Today Memories",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [480, 300],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "const results = $input.first().json.results || [];\n\n// Filter to today's memories only\nconst today = new Date().toISOString().slice(0, 10);\nconst todayMemories = results.filter(r => r.created_at && r.created_at.startsWith(today));\n\nif (todayMemories.length < 3) {\n  // Not enough memories for a meaningful reflection\n  return [];\n}\n\nconst summaryLines = todayMemories.map((m, i) => \n  `${i+1}. [${m.category}] ${m.content.substring(0, 200)}`\n).join('\\n');\n\nconst prompt = `You are a reflection assistant. Review these memories from today and write a concise daily reflection (3-5 sentences). Focus on patterns, decisions, and what was accomplished. Do not list items individually.\\n\\nToday's memories:\\n${summaryLines}\\n\\nDaily reflection:`;\n\nreturn [{ json: { prompt, memory_count: todayMemories.length } }];"
      },
      "name": "Build Reflection Prompt",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [720, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://127.0.0.1:11434/v1/chat/completions",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ model: 'qwen2.5:14b', messages: [{ role: 'user', content: $json.prompt }], temperature: 0.7, max_tokens: 500 }) }}",
        "options": {
          "timeout": 120000
        }
      },
      "name": "Ollama Generate Reflection",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [960, 300]
    },
    {
      "parameters": {
        "jsCode": "const ollamaResp = $input.first().json;\nconst content = ollamaResp.choices?.[0]?.message?.content || '';\nconst memCount = $('Build Reflection Prompt').first().json.memory_count;\n\nif (!content || content.length < 20) {\n  return []; // Skip empty reflections\n}\n\nreturn [{ json: {\n  content: content.trim(),\n  memory_count: memCount\n}}];"
      },
      "name": "Extract Reflection Text",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1200, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://127.0.0.1:4200/store",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ content: $json.content, category: 'reflection', source: 'n8n-daily-reflection', importance: 7, tags: ['daily-reflection', 'auto-generated', new Date().toISOString().slice(0,10)] }) }}",
        "options": {
          "timeout": 10000
        }
      },
      "name": "Store Reflection in Engram",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1440, 300],
      "credentials": {
        "httpHeaderAuth": {
          "name": "Engram API Key"
        }
      }
    }
  ],
  "connections": {
    "Daily 11 PM": {
      "main": [[{"node": "Search Today Memories", "type": "main", "index": 0}]]
    },
    "Search Today Memories": {
      "main": [[{"node": "Build Reflection Prompt", "type": "main", "index": 0}]]
    },
    "Build Reflection Prompt": {
      "main": [[{"node": "Ollama Generate Reflection", "type": "main", "index": 0}]]
    },
    "Ollama Generate Reflection": {
      "main": [[{"node": "Extract Reflection Text", "type": "main", "index": 0}]]
    },
    "Extract Reflection Text": {
      "main": [[{"node": "Store Reflection in Engram", "type": "main", "index": 0}]]
    }
  },
  "settings": {
    "executionOrder": "v1"
  }
}
```

**Acceptance criteria:**
- Runs at 11 PM daily
- Searches Engram for today's memories
- Skips if fewer than 3 memories today (not enough signal)
- Sends memories to Ollama (qwen2.5:14b) for synthesis
- Stores reflection back in Engram with category "reflection" and tagged with date
- Empty/short reflections are not stored

---

## PHASE 7: Wiring and Verification

### Task 7.1: Create the n8n workflow directory

```bash
mkdir -p /c/Users/Zan/Projects/engram/audit/n8n-workflows
```

The three workflow JSON files from Phases 4-6 should be created there. They will be
imported into n8n on Hetzner.

### Task 7.2: Create deployment script

**File to create:** `audit/deploy-integrations.sh`

```bash
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
  # n8n API import (requires n8n API key or basic auth)
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
```

### Task 7.3: Verification checklist

After deployment, verify each integration:

**Open WebUI + Engram:**
1. Open chat.zanfiel.com (or Open WebUI directly)
2. Ask "What programming language does Zan use?" - Engram should provide context
3. Have a conversation about something specific
4. Check Engram: `curl /search -d '{"query": "open-webui conversation"}'` - should find it
5. Check pipeline is active: Admin Panel > Pipelines > Engram RAG Filter

**n8n + Engram:**
1. Store a test memory: `curl /store -d '{"content": "n8n integration test"}'`
2. Check n8n execution history: the event router workflow should show a new execution
3. Wait for 3 AM: check maintenance workflow ran successfully
4. Wait for 11 PM: check daily reflection was generated and stored

**Ollama loop:**
1. Check the daily reflection stored in Engram has source "n8n-daily-reflection"
2. Verify the reflection content was generated by Ollama (not a template)

**Acceptance criteria:**
- Open WebUI conversations have Engram context injected
- Open WebUI conversations are stored back in Engram
- n8n receives webhook events from Engram
- n8n runs daily maintenance (health + integrity + GC)
- n8n runs weekly compaction with maintenance mode
- n8n runs daily reflection (search > Ollama > store)
- All three services form a connected loop

---

## IMPLEMENTATION ORDER

1. **Phase 1** (SSRF Allowlist) - Must be first. Unblocks webhook registration.
2. **Phase 2** (Open WebUI RAG Pipeline) - Independent of n8n. Deploy and test.
3. **Phase 3** (Conversation Memory) - Extends Phase 2. Test bidirectional flow.
4. **Phase 4** (n8n Webhook Receiver) - Requires Phase 1. Deploy and test.
5. **Phase 5** (n8n Maintenance) - Independent of Phase 4. Deploy and test.
6. **Phase 6** (n8n Daily Reflection) - Requires Phase 4 + Ollama working. Deploy and test.
7. **Phase 7** (Wiring) - Deploy script and verification.

## FILES TO CREATE

| File | Purpose |
|------|---------|
| `audit/n8n-workflows/engram_rag_filter.py` | Open WebUI pipeline for Engram RAG |
| `audit/n8n-workflows/engram-event-router.json` | n8n workflow: process Engram webhooks |
| `audit/n8n-workflows/engram-maintenance.json` | n8n workflow: daily health + GC |
| `audit/n8n-workflows/engram-weekly-compact.json` | n8n workflow: weekly VACUUM |
| `audit/n8n-workflows/engram-daily-reflection.json` | n8n workflow: Ollama reflection loop |
| `audit/deploy-integrations.sh` | Deployment script for all integrations |

## CODE CHANGES TO ENGRAM

| File | Change |
|------|--------|
| `src/config/index.ts` | Add ENGRAM_WEBHOOK_ALLOWED_HOSTS |
| `src/helpers/index.ts` | Add allowlist bypass to SSRF check |
| `src/platform/webhooks.ts` | Add allowlist bypass to dispatch-time check |

## RULES FOR THE IMPLEMENTING AGENT

1. Do NOT modify any Engram code beyond what Phase 1 specifies
2. Do NOT install npm packages
3. Do NOT use em dashes
4. The pipeline Python file must be valid Python 3.11
5. The n8n workflow JSON files must be valid n8n import format
6. All HTTP URLs pointing to local services use 127.0.0.1, NOT localhost (IPv6 issues on Hetzner)
7. All n8n workflows must use the shared "Engram API Key" credential name
8. The deployment script uses SSH - it runs from Windows, not from Hetzner
9. Do NOT hardcode API keys in any file. Use environment variables or n8n credentials.
10. The Open WebUI pipeline must gracefully degrade if Engram is unreachable (5s timeout, catch all exceptions)
