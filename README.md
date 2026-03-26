<div align="center">

# Engram

### Persistent memory for AI agents

Store, search, recall, and link memories with automatic embeddings,
fact extraction, versioning, deduplication, and graph visualization.

[![License: Elastic-2.0](https://img.shields.io/badge/License-Elastic--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-5.11.0-gold.svg)](CHANGELOG.md)

[Quick Start](#quick-start) · [API Reference](#api-reference) · [SDKs](#sdks) · [MCP Server](#mcp-server) · [CLI](#cli) · [Self-Host](#self-hosting)

</div>

---

## What is Engram?

Engram gives your AI agents **long-term memory**. Instead of losing context between sessions, agents store what they learn and recall it when relevant, automatically.

```bash
# Store what the agent learns
curl -X POST http://localhost:4200/store \
  -H "Authorization: Bearer eg_your_key" \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers dark mode and uses Vim keybindings", "category": "decision", "importance": 8}'

# Later, in a new session - recall relevant context
curl -X POST http://localhost:4200/recall \
  -H "Authorization: Bearer eg_your_key" \
  -H "Content-Type: application/json" \
  -d '{"query": "setting up the user editor"}'
# → Returns the dark mode + Vim preference automatically
```

**Key features:**

- 🧠 **FSRS-6 spaced repetition** - cognitive science-backed memory decay using power-law forgetting curves (ported from [open-spaced-repetition](https://github.com/open-spaced-repetition/fsrs4anki))
- 💪 **Dual-strength memory model** - Bjork & Bjork (1992) storage strength (never decays) + retrieval strength (decays via power law)
- 🧬 **Reciprocal Rank Fusion search** - four-channel RRF scoring across vector similarity, FTS5 full-text, personality signals, and graph relationships
- 🔗 **Auto-linking** - memories automatically connect via cosine similarity, forming a knowledge graph
- 🧹 **SimHash deduplication** - 64-bit locality-sensitive hashing detects near-duplicates before embedding, saving compute
- 🕐 **Bi-temporal fact tracking** - structured facts carry temporal validity windows with automatic contradiction-based invalidation
- 🧩 **Entity cooccurrence graph** - entities that appear together build weighted relationships automatically
- 🏘️ **Community detection** - label propagation groups related memories into discoverable clusters, auto-runs on store
- 📈 **PageRank** - iterative weighted PageRank ranks memories by structural importance, not just connection count
- 📊 **Graph timeline** - `GET /graph/timeline` shows how your knowledge graph grew week by week
- 🔬 **Cross-encoder reranker** - BGE-reranker-base (quantized INT8) reranks search results for semantic precision
- 🎭 **Personality engine** - extracts preferences, values, motivations, decisions, emotions, and identity signals from memories
- 📊 **Graph visualization** - explore your memory space in a WebGL galaxy
- 🔄 **Versioning** - update memories without losing history
- ⏰ **Implicit spaced repetition** - every access is an FSRS review, building stability over time
- 🔍 **Fact extraction & auto-tagging** - LLM extracts facts, classifies, tags (optional, requires LLM)
- 💬 **Conversation extraction** - feed chat logs, get structured memories
- ⚡ **Contradiction detection** - find and resolve conflicting memories
- ⏪ **Time-travel queries** - query what you knew at any point in time
- 🎯 **Smart context builder** - token-budget-aware RAG context assembly with progressive depth (1/2/3-hop)
- 💭 **Reflections** - periodic meta-analysis that becomes searchable memory
- 🧬 **Derived memories** - inference engine finds patterns across memories
- 🗜️ **Auto-consolidation** - summarize large memory clusters automatically
- 👥 **Multi-tenant** - isolated memory per user with API keys
- 📖 **Episodic memory** - store conversation episodes as embedded, searchable narratives with temporal + semantic search. Facts link to source episodes.
- 🚫 **Abstention** - search returns `abstained: true` when confidence is below threshold. The system knows when it doesn't know.
- 🤖 **Assistant recall** - extracts what the AI said/did, not just user facts. LLM + regex patterns for assistant actions.
- ⏳ **Temporal search** - `temporal_sort` orders results chronologically. Episode search by date range.
- 🔗 **2-hop graph traversal** - relationship expansion reaches 2 levels deep for multi-hop reasoning
- 🧩 **Implicit connection inference** - LLM post-processing in /context finds unstated relationships between memories
- 🛡️ **Guardrails** - `POST /guard` checks proposed actions against stored rules before execution. Returns allow/warn/block. Prevents repeated deployment mistakes, outdated references, and policy violations.
- 📦 **Spaces, tags, episodes** - organize memories into named collections
- 🧩 **Entities & projects** - track people, servers, tools, projects
- 📬 **Webhooks & digests** - event hooks + scheduled HMAC-signed summaries
- 🔄 **Sync & import** - cross-instance sync, import from Mem0 / Supermemory
- 📥 **URL ingest** - extract facts from web pages or text blobs
- 🛠️ **MCP server** - JSON-RPC 2.0 stdio transport for Claude Desktop, Cursor, Windsurf
- ⌨️ **CLI** - full-featured command-line interface (`engram-cli store`, `engram-cli search`, etc.)
- 📥 **Review queue / inbox** - auto-detected memories land in review; explicit stores bypass
- 🔒 **Security hardening** - auth required by default, body/content limits, IP allowlists, timing-safe auth
- 📋 **Audit trail** - every mutation logged (who, what, when, from where)
- 📊 **Structured JSON logging** - configurable log levels, request IDs, zero raw console output
- 💾 **Backup & checkpoint** - download SQLite DB via API, manual WAL checkpoint, graceful shutdown
- 🏗️ **Structural analysis** - deterministic graph analysis engine (absorbed from OpenSpace). Describe systems in EN syntax, get topology classification (Pipeline/Tree/DAG/Cycle), node roles, bridges, betweenness centrality, blast radius, shortest paths, and Louvain community detection. 12 MCP tools for architecture reasoning.
- 🐳 **One-command deploy** - `docker compose up`

---

## What's New

### Syntheos Service Consolidation (v5.11.0)

Seven standalone microservices absorbed into the Engram monolith as native modules. No new dependencies, no new processes. Same database, same auth.

**Thymus** (quality evaluation) - Rubric-based scoring engine for agent output quality. Define evaluation criteria with weighted scales, run evaluations, track agent scores over time. Stores quality metrics alongside memories.

- `POST /thymus/rubrics` - Create evaluation rubrics with weighted criteria
- `GET /thymus/rubrics` - List rubrics
- `POST /thymus/evaluations` - Score agent output against a rubric
- `GET /thymus/evaluations` - List evaluations with agent/rubric filtering
- `GET /thymus/agents/:agent/scores` - Aggregate scores per agent
- `POST /thymus/metrics` - Record arbitrary quality metrics
- `GET /thymus/metrics` - Query metrics with time range and agent filtering
- `GET /thymus/stats` - Rubric, evaluation, and metric counts

**Soma** (agent registry) - Agent lifecycle management. Register agents with capabilities, track heartbeats, organize into groups, collect structured logs.

- `POST /soma/agents` - Register an agent
- `GET /soma/agents` - List agents with type/status/capability filtering
- `PATCH /soma/agents/:id` - Update agent metadata
- `DELETE /soma/agents/:id` - Deregister (atomic cascade delete)
- `POST /soma/agents/:id/heartbeat` - Heartbeat with optional status update
- `GET /soma/agents/stale` - Find agents that missed heartbeats
- `POST /soma/agents/:id/logs` - Submit structured log entries
- `GET /soma/agents/:id/logs` - Read agent logs
- `POST /soma/groups` - Create agent groups
- `GET /soma/groups` - List groups
- `POST /soma/groups/:id/members` - Add agent to group
- `DELETE /soma/groups/:id/members/:agentId` - Remove from group
- `GET /soma/agents/capability/:name` - Find agents by capability
- `GET /soma/stats` - Registry statistics

**Chiasm** (task tracking) - Lightweight task coordination for multi-agent systems. Agents create tasks, update status, and read each other's active work via a feed endpoint.

- `POST /tasks` - Create a task
- `GET /tasks` - List tasks with status/agent/project filtering
- `GET /tasks/:id` - Get task with full audit trail
- `PATCH /tasks/:id` - Update status/summary (creates audit entry)
- `DELETE /tasks/:id` - Delete task
- `GET /tasks/stats` - Task counts by status
- `GET /feed` - Activity feed of recent task updates

**Axon** (event bus) - Real-time pub/sub event bus with SSE streaming, webhook fan-out, and cursor-based polling. Agents publish events to named channels, subscribe for real-time delivery or poll at their own pace.

- `POST /axon/publish` - Publish an event to a channel
- `GET /axon/events` - Query events with channel/type/source filtering
- `GET /axon/channels` - List channels with event and subscriber counts
- `POST /axon/channels` - Create a new channel
- `POST /axon/subscribe` - Subscribe agent to channel (optional webhook URL)
- `POST /axon/unsubscribe` - Remove subscription
- `GET /axon/subscriptions` - List subscriptions
- `GET /axon/poll` - Cursor-based event consumption
- `GET /axon/stream` - SSE real-time event stream
- `GET /axon/stats` - Bus statistics

**Loom** (workflow orchestration) - Multi-step pipeline engine with dependency-based execution. Define reusable workflows with webhook, LLM, and transform step types. Runs track progress, retry failed steps, and collect outputs.

- `POST /loom/workflows` - Create a workflow definition
- `GET /loom/workflows` - List workflows
- `POST /loom/runs` - Start a workflow run with input
- `GET /loom/runs` - List runs with status filtering
- `GET /loom/runs/:id` - Get run with full state
- `POST /loom/runs/:id/cancel` - Cancel a running workflow
- `GET /loom/runs/:id/steps` - Get step states for a run
- `GET /loom/runs/:id/logs` - Get execution logs
- `POST /loom/steps/:id/complete` - External callback to complete a step
- `POST /loom/steps/:id/fail` - External callback to fail a step
- `GET /loom/stats` - Workflow and run statistics

**Broca** (action log and narrator) - Agent action logger with template-based narration and natural language query. Logs what agents do, translates actions into plain English, and answers questions about system activity.

- `POST /broca/actions` - Log an action with auto-narration
- `GET /broca/actions` - Query actions with filtering
- `GET /broca/actions/:id` - Get single action
- `GET /broca/actions/:id/narrate` - Generate narrative for action
- `GET /broca/feed` - Activity feed with narratives
- `POST /broca/narrate` - Bulk narrate actions
- `POST /broca/ask` - Natural language query over the system
- `GET /broca/stats` - Action statistics

**OpenSpace** (structural analysis) - Deterministic graph analysis engine for architecture reasoning. Describe systems in EN (Entity-Notation) syntax and get topology classification, node role detection, bridge analysis, betweenness centrality, shortest paths, blast radius assessment, structural diffs, and Louvain community detection. No AI inside the computation -- pure graph theory via Graphology.

- `structural_analyze` - Topology classification (Pipeline/Tree/DAG/Cycle), node roles (SOURCE/SINK/FORK/JOIN/HUB), bridges
- `structural_detail` - Concurrency metrics, critical path, flow depth, resilience analysis
- `structural_between` - Betweenness centrality for any node (0-1)
- `structural_distance` - Shortest path with subsystem crossing annotations
- `structural_trace` - Follow directed flow from A to B along yields->needs edges
- `structural_impact` - Blast radius: what disconnects if a node is removed
- `structural_diff` - Structural diff between two system descriptions
- `structural_evolve` - Dry-run architectural changes, preview structural delta
- `structural_categorize` - Auto-discover subsystem boundaries via Louvain
- `structural_extract` - Extract a named subsystem as standalone EN source
- `structural_compose` - Merge two EN graphs with entity linking
- `structural_memory_graph` - Analyze Engram's own memory link graph structurally

Available via MCP tools or HTTP at `/structural/*` endpoints. No LLM required.

All seven services share the main Engram database, reuse auth middleware, and publish events via the Axon event bus.

<details>
<summary><strong>v5.9.x</strong></summary>

**PageRank for Memory Graphs** - Full iterative PageRank algorithm with type-aware edge weighting. Memories linked to by important memories score higher, not just memories with lots of connections. Scores are normalized 0-1 and stored per memory. Runs automatically every 25th store alongside community detection.

**Search Ranking from Graph Structure** - Search results now get a 0-15% boost based on their PageRank score. Structurally important memories surface higher in `/search` and `/context` results. This works on top of the existing RRF scoring, decay, and temporal signals.

**Auto Graph Analysis on Store** - Every 25th memory stored triggers background community detection and PageRank recomputation via the durable job queue. No impact on store latency.

**Temporal Graph Evolution** - New `GET /graph/timeline` endpoint returns weekly aggregates of graph growth.

**Enriched Graph Endpoint** - `/graph` now returns `pagerank_score` per node. Node sizes are boosted by PageRank.

</details>

<details>
<summary><strong>v5.8.3</strong></summary>

**Server-Side Source Filtering** - `/search`, `/context`, and `/recall` accept a `source` parameter. Filter propagates into hybrid search at both vector and FTS5 stages.

**Worker Thread Embeddings** - ONNX inference moved to a dedicated Worker thread. No more event loop blocking.

**Batch Link Queries** - Relationship expansion uses single batch query instead of N+1.

**TypeScript Zero Errors** - Clean compilation with zero TS errors.

</details>

<details>
<summary><strong>Previous releases</strong></summary>

#### v5.8.2 - Blended Retrieval, Memory Health, Feedback Loop

**Blended Multi-Strategy Retrieval** - `classifyQuestionMixed` detects mixed-intent queries and blends multiple question types with normalized weights. `blendStrategies` produces a weighted combination of SearchStrategy configs.

**Memory Health Endpoint** - `GET /memory-health` returns four diagnostic categories: stale, duplicates, high-value unlinked, and contradiction hints.

**Retrieval Feedback** - `POST /feedback` accepts signals (used, ignored, corrected, irrelevant, helpful). Auto-adjusts importance. `GET /feedback/stats` returns analytics.

**Search Explainability** - Per-channel score breakdowns (vector, FTS, graph, personality, reranker, decay) in search results.

**Freshness-Weighted Structured Facts** - Facts sorted by freshness with linear decay. Old facts tagged `[possibly outdated]`.

**Contradiction Ranking Penalty** - Non-latest-version memories with contradiction keywords receive 0.65x score penalty.

#### v5.8.1 - Durable Jobs, Security Hardening, Scheduler Leases

**Durable Job Queue** - DB-backed jobs table with retry, exponential backoff, and crash recovery.

**Scheduler Leases** - DB-backed leases prevent duplicate background work in multi-instance deployments.

**Security** - Atomic memory ownership, bootstrap hardening, cross-tenant scratchpad fix, SSRF redirect blocking, passport tenant binding.

**Readiness Probes** - `GET /live` and `GET /ready` with 503 when degraded.

#### v5.8.0 - Intelligence Pipeline Overhaul

**Reciprocal Rank Fusion** - 4-channel RRF scoring (vector, FTS5, personality, graph). Question-type-aware strategies.

**SimHash Deduplication** - 64-bit locality-sensitive hashing detects near-duplicates before embedding.

**Bi-Temporal Fact Tracking** - Structured facts with valid_at/invalid_at windows. Contradiction-based invalidation.

**Entity Cooccurrence Graph** - Composite scoring (name similarity, frequency, temporal proximity).

**Community Detection** - Label propagation on memory_links graph.

**Cross-Encoder Reranker** - BGE-reranker-base (INT8, sub-100ms). Optional.

**Personality Engine** - Six signal types: preference, value, motivation, decision, emotion, identity.

**Progressive Disclosure** - `/context` depth=1/2/3 for token budget control.

#### v5.7.0 - BGE-large, Episodic Memory, Multi-Tenant Isolation

BGE-large-en-v1.5 (1024-dim), episodic memory, complete multi-tenant security audit, guardrails, abstention, assistant recall, 2-hop graph traversal, implicit connection inference.

#### v5.6.0 - Node.js 22, Graph Intelligence

Node.js 22+, optimized MCP server, vitest, Graphology knowledge graph.

#### v5.5.0 - Intelligence Layer

LLM fact extraction, auto-tagging, conversation extraction, URL ingest, reflections, derived memories, auto-consolidation.

#### v5.4.0 - Security Hardening

7 security fixes (S1-S7), RBAC, timing-safe auth, rate limiting, HSTS, CSP.

#### v5.3.0 - FSRS-6 Spaced Repetition

FSRS-6 with 21 trained weights, dual-strength model, time travel, smart context, reflections, digests, derived memories, auto-consolidation.

#### v5.0.0 - Multi-Tenant

Users, API keys, spaces, FTS5+vector hybrid search, auto-linking, version chains, libsql.

#### v4.0.0 - SQLite + Local Embeddings

SQLite + FTS5, MiniLM-L6-v2 embeddings, basic CRUD, conversations.

#### v3.0.0 - Initial Release

In-memory storage, basic embedding search.

</details>


---

## Quick Start (10 minutes)

### 1. Start the server

```bash
git clone https://github.com/zanfiel/engram.git && cd engram
npm install
cp .env.example .env    # Edit .env: set ENGRAM_GUI_PASSWORD
npm start               # Or: docker compose up -d
```

### 2. Bootstrap your admin key

```bash
curl -X POST http://localhost:4200/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"name": "my-admin-key"}'
# Save the returned eg_... key
```

### 3. Store your first memories

```bash
export KEY="eg_your_key_here"

curl -X POST http://localhost:4200/store \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content": "Production database is PostgreSQL 16 on db.example.com:5432", "category": "reference", "importance": 8}'

curl -X POST http://localhost:4200/store \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content": "Never deploy on Fridays - outage on 2026-01-15 was caused by Friday deploy", "category": "decision", "importance": 9}'

curl -X POST http://localhost:4200/store \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content": "Migrated auth service from JWT to opaque sessions for compliance", "category": "decision", "importance": 7}'
```

### 4. Recall what matters

```bash
# Semantic search
curl -X POST http://localhost:4200/search \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"query": "database connection details"}'

# Decision-focused search
curl -X POST http://localhost:4200/search \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"query": "deployment policy", "mode": "decision"}'

# Budget-aware context for RAG injection
curl -X POST http://localhost:4200/context \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"query": "setting up a new deploy pipeline", "mode": "fast"}'
```

### 5. Check the guardrails

```bash
# Before deploying, check against stored rules
curl -X POST http://localhost:4200/guard \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"action": "deploy to production on Friday"}'
# Returns: { "verdict": "warn", "reasons": ["Never deploy on Fridays..."] }
```

---

## Decision Memory

Engram is especially strong as a **decision memory system**. It tracks not just what you know, but what you decided, why, and what changed.

- **Versioning**: update a memory and the full version chain is preserved
- **Contradictions**: when new information conflicts with old, both are flagged with a `contradicts` link
- **Corrections**: `POST /correct` stores a correction that supersedes the original, with `corrects` relationship
- **Guardrails**: `POST /guard` checks proposed actions against stored decision rules before execution
- **Temporal queries**: "what did we know last Tuesday?" via `mode=timeline` or time-travel queries
- **Structured facts**: subject/verb/object decomposition with temporal validity windows

This makes Engram ideal for:
- **Agent memory**: agents that learn from mistakes and don't repeat them
- **Ops runbooks**: infrastructure decisions with context ("we chose X because Y")
- **Project continuity**: decisions survive team turnover

---

## Review Inbox

Memories extracted by LLM (fact extraction, personality signals) land in the **review inbox** instead of being immediately trusted. This gives you control over what enters long-term memory.

```bash
# List pending memories
curl http://localhost:4200/inbox -H "Authorization: Bearer $KEY"

# Approve a memory
curl -X POST http://localhost:4200/inbox/42/approve -H "Authorization: Bearer $KEY"

# Reject a memory
curl -X POST http://localhost:4200/inbox/42/reject -H "Authorization: Bearer $KEY"
```

Memories you store directly via `/store` bypass the inbox and are approved immediately.

---

## SDK

### TypeScript SDK

```typescript
import { Engram } from "@zanfiel/engram/sdk";

const engram = new Engram({ url: "http://localhost:4200", apiKey: "eg_..." });

// Store
await engram.store("User prefers dark mode", { category: "decision", importance: 8 });

// Search with presets
const results = await engram.search("dark mode", { mode: "preference" });

// Budget-aware context for RAG
const ctx = await engram.context("setting up the editor", { mode: "fast" });

// Guardrails
const check = await engram.guard("deploy to production on Friday");
if (check.verdict === "block") console.log("Blocked:", check.reasons);

// Inbox review
const pending = await engram.inbox();
for (const mem of pending.pending) {
  await engram.approve(mem.id);  // or: engram.reject(mem.id)
}
```

### cURL

```bash
# Store
curl -X POST http://localhost:4200/store \
  -H "Authorization: Bearer eg_your_key" \
  -H "Content-Type: application/json" \
  -d '{"content": "Server migrated to new IP", "category": "state", "importance": 7}'

# Search with mode preset
curl -X POST http://localhost:4200/search \
  -H "Authorization: Bearer eg_your_key" \
  -H "Content-Type: application/json" \
  -d '{"query": "server migration", "mode": "timeline", "limit": 5}'

# Recall
curl -X POST http://localhost:4200/recall \
  -H "Authorization: Bearer eg_your_key" \
  -H "Content-Type: application/json" \
  -d '{"query": "infrastructure changes"}'

# FSRS state
curl http://localhost:4200/fsrs/state?id=42 \
  -H "Authorization: Bearer eg_your_key"
```

---

## MCP Server

Engram includes a real [Model Context Protocol](https://modelcontextprotocol.io/) server for integration with Claude Desktop, Cursor, Windsurf, and other MCP-compatible tools.

**Transport:** JSON-RPC 2.0 over stdio

### Setup (Claude Desktop)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["--experimental-strip-types", "path/to/engram/mcp-server.ts"],
      "env": {
        "ENGRAM_URL": "http://localhost:4200",
        "ENGRAM_API_KEY": "eg_your_key"
      }
    }
  }
}
```

### Available Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store a new memory with category, importance, model, and optional source attribution |
| `memory_search_preset` | Semantic search with query-optimized presets: fact, timeline, preference, decision, recent |
| `memory_recall` | Load broad session context (static facts + semantic + important + recent). For precise search, use `memory_search_preset` |
| `memory_context` | Token-budget-aware context packing for LLM injection |
| `memory_list` | List recent memories, optionally filtered by category |
| `memory_delete` | Delete a memory by ID |
| `memory_guard` | Check a proposed action against stored rules (allow/warn/block) |
| `memory_inbox` | Review pending memories awaiting triage (approve/reject) |
| `memory_entities` | List or search tracked entities (people, servers, tools, services) |
| `memory_projects` | List or search tracked projects |
| `memory_episodes` | List conversation episodes (sessions of related work) |
| `memory_scratch` | Read/write scratchpad (short-term working memory, 30min TTL) |
| `structural_analyze` | Analyze a system in EN syntax -- topology (Pipeline/Tree/DAG/Cycle), node roles, bridges |
| `structural_detail` | Deep analysis -- concurrency metrics, critical path, flow depth, resilience |
| `structural_between` | Betweenness centrality for a node (0-1 score) |
| `structural_distance` | Shortest path between two nodes with subsystem annotations |
| `structural_trace` | Follow directed flow from A to B along yields->needs edges |
| `structural_impact` | Blast radius -- what disconnects if a node is removed |
| `structural_diff` | Structural diff between two systems -- topology changes, role changes, bridges |
| `structural_evolve` | Dry-run architectural changes and preview the structural delta |
| `structural_categorize` | Auto-discover subsystem boundaries via Louvain community detection |
| `structural_extract` | Extract a named subsystem as standalone EN source |
| `structural_compose` | Merge two EN graphs with entity linking |
| `structural_memory_graph` | Analyze Engram's own memory link graph structurally |

> **Note:** The MCP server connects to a running Engram instance via HTTP. All tools support signed tool manifests for integrity verification when `ENGRAM_SIGNING_SECRET` is set.

---

## CLI

Engram ships a full CLI that wraps the HTTP API. Zero external dependencies -- uses Node.js 22 built-in `util.parseArgs`.

```bash
# Install globally (or use npx)
npm install -g @zanfiel/engram

# Configure
export ENGRAM_URL=http://localhost:4200
export ENGRAM_API_KEY=eg_your_key

# Store
engram-cli store "Deployed auth migration to production" --category state --importance 9

# Search
engram-cli search "deployment history" --limit 5 --explain

# Context (RAG)
engram-cli context "current infrastructure state" --budget 4000

# Recall
engram-cli recall --context "what changed recently"

# Other commands
engram-cli list --limit 20
engram-cli forget 42 --reason "outdated"
engram-cli delete 42
engram-cli health
engram-cli stats
```

All commands support `--json` for raw API output and `--quiet` for minimal output (IDs and counts only). Config can also be set in `~/.engram/config.json`.

---

## API Reference

### Authentication

All endpoints require `Authorization: Bearer eg_...` header by default. Set `ENGRAM_OPEN_ACCESS=1` for unauthenticated single-user mode.

Use `X-Space: space-name` (or `X-Engram-Space`) header to scope operations to a specific memory space. Every response includes an `X-Request-Id` header for correlation.

### Core Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/store` | Store a memory |
| `POST` | `/search` | RRF search across vector, FTS5, personality, and graph channels |
| `POST` | `/recall` | Contextual recall (agent-optimized) |
| `POST` | `/context` | Smart context builder (token-budget RAG with depth 1/2/3) |
| `GET` | `/list` | List recent memories |
| `GET` | `/profile` | User profile (static facts + recent) |
| `GET` | `/graph` | Full memory graph (nodes + edges) |

### Memory Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/memory/:id/update` | Create new version |
| `POST` | `/memory/:id/forget` | Soft delete |
| `POST` | `/memory/:id/archive` | Archive (hidden from recall) |
| `POST` | `/memory/:id/unarchive` | Restore from archive |
| `DELETE` | `/memory/:id` | Permanent delete |
| `GET` | `/versions/:id` | Version chain for a memory |

### FSRS-6 Spaced Repetition

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/fsrs/review` | Manual review (grade 1-4: Again/Hard/Good/Easy) |
| `GET` | `/fsrs/state?id=N` | Retrievability, stability, next review interval |
| `POST` | `/fsrs/init` | Backfill FSRS state for all memories |
| `POST` | `/decay/refresh` | Recalculate all decay scores |
| `GET` | `/decay/scores` | View decay scores + FSRS state |

### Intelligence

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/add` | Extract memories from conversations |
| `POST` | `/ingest` | Extract facts from URLs or text |
| `POST` | `/guard` | Pre-action guardrail check (allow/warn/block) |
| `POST` | `/derive` | Generate inferred memories |
| `POST` | `/reflect` | Generate period reflection |
| `GET` | `/reflections` | List past reflections |
| `GET` | `/contradictions` | Find conflicting memories |
| `POST` | `/contradictions/resolve` | Resolve a contradiction |
| `POST` | `/timetravel` | Query memory state at a past time |
| `GET` | `/facts` | Query structured facts with filtering |
| `GET` | `/preferences` | Get stored user preferences |
| `DELETE` | `/preferences` | Delete preference entries (surgical cleanup) |
| `GET` | `/state` | Get current user state |
| `DELETE` | `/state` | Delete state entries (surgical cleanup) |
| `POST` | `/profile/synthesize` | Synthesize personality profile from signals |
| `GET` | `/memory-health` | Diagnostic report: stale, duplicates, unlinked, contradiction hints |
| `POST` | `/feedback` | Submit retrieval feedback (used/ignored/corrected/irrelevant/helpful) |
| `GET` | `/feedback/stats` | Feedback analytics: signal breakdown, precision estimate, top memories |

### Graph & Communities

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/communities` | List and browse memory communities |
| `POST` | `/admin/detect-communities` | Run community detection (admin) |
| `POST` | `/admin/rebuild-cooccurrences` | Rebuild entity cooccurrence graph (admin) |
| `POST` | `/admin/backfill-facts` | Re-extract facts from all memories (admin) |

### Organization

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tags` | List all tags |
| `POST` | `/tags/search` | Search by tags |
| `POST` | `/episodes` | Create episode |
| `GET` | `/episodes` | List episodes |
| `POST` | `/entities` | Create entity |
| `GET` | `/entities` | List entities |
| `POST` | `/projects` | Create project |
| `GET` | `/projects` | List projects |

### Conversations

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/conversations/bulk` | Bulk store conversation (`agent` + `messages` required) |
| `POST` | `/conversations/upsert` | Upsert by session_id |
| `GET` | `/conversations` | List conversations |
| `GET` | `/conversations/:id/messages` | Get conversation messages |
| `POST` | `/messages/search` | Search across all messages |

### Data & Sync

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/export` | Export all memories + links (JSON/JSONL) |
| `POST` | `/import` | Bulk import memories |
| `POST` | `/import/mem0` | Import from Mem0 |
| `POST` | `/import/supermemory` | Import from Supermemory |
| `GET` | `/sync/changes` | Get changes since timestamp |
| `POST` | `/sync/receive` | Receive synced changes |

### Platform

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhooks` | Create webhook |
| `GET` | `/webhooks` | List webhooks |
| `POST` | `/digests` | Create scheduled digest |
| `GET` | `/digests` | List digests |
| `POST` | `/digests/send` | Manually trigger a digest |
| `POST` | `/pack` | Pack memories into token budget |
| `GET` | `/prompt` | Generate prompt template |

### Auth & Multi-tenant

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/users` | Create user (admin) |
| `GET` | `/users` | List users (admin) |
| `POST` | `/keys` | Create API key |
| `GET` | `/keys` | List API keys |
| `DELETE` | `/keys/:id` | Revoke key |
| `POST` | `/keys/rotate` | Rotate an API key (atomically replace, preserving scopes) |
| `POST` | `/spaces` | Create space |
| `GET` | `/spaces` | List spaces |
| `DELETE` | `/spaces/:id` | Delete space |

### Review Queue

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/inbox` | List pending memories |
| `POST` | `/inbox/:id/approve` | Approve a pending memory |
| `POST` | `/inbox/:id/reject` | Reject (archive + set reason) |
| `POST` | `/inbox/:id/edit` | Edit content + auto-approve |
| `POST` | `/inbox/bulk` | Bulk approve/reject |

### Thymus (Quality Evaluation)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/thymus/rubrics` | Create evaluation rubric with weighted criteria |
| `GET` | `/thymus/rubrics` | List rubrics |
| `GET` | `/thymus/rubrics/:id` | Get rubric by ID |
| `POST` | `/thymus/evaluations` | Score agent output against a rubric |
| `GET` | `/thymus/evaluations` | List evaluations (filter by agent, rubric) |
| `GET` | `/thymus/agents/:agent/scores` | Aggregate score stats for an agent |
| `POST` | `/thymus/metrics` | Record a quality metric |
| `GET` | `/thymus/metrics` | Query metrics (filter by agent, metric, time range) |
| `GET` | `/thymus/stats` | Rubric, evaluation, and metric counts |

### Soma (Agent Registry)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/soma/agents` | Register a new agent |
| `GET` | `/soma/agents` | List agents (filter by type, status, capability) |
| `GET` | `/soma/agents/:id` | Get agent by ID |
| `PATCH` | `/soma/agents/:id` | Update agent metadata |
| `DELETE` | `/soma/agents/:id` | Deregister agent (cascade deletes logs and group memberships) |
| `POST` | `/soma/agents/:id/heartbeat` | Send heartbeat with optional status |
| `GET` | `/soma/agents/stale` | Find agents that missed heartbeats |
| `POST` | `/soma/agents/:id/logs` | Submit structured log entry |
| `GET` | `/soma/agents/:id/logs` | Read agent logs |
| `POST` | `/soma/groups` | Create agent group |
| `GET` | `/soma/groups` | List groups |
| `GET` | `/soma/groups/:id` | Get group with member list |
| `DELETE` | `/soma/groups/:id` | Delete group |
| `POST` | `/soma/groups/:id/members` | Add agent to group |
| `DELETE` | `/soma/groups/:id/members/:agentId` | Remove agent from group |
| `GET` | `/soma/agents/capability/:name` | Find agents by capability |
| `GET` | `/soma/stats` | Registry statistics |

### Chiasm (Task Tracking)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/tasks` | Create a task |
| `GET` | `/tasks` | List tasks (filter by status, agent, project) |
| `GET` | `/tasks/:id` | Get task with audit trail |
| `PATCH` | `/tasks/:id` | Update task status/summary |
| `DELETE` | `/tasks/:id` | Delete task |
| `GET` | `/tasks/stats` | Task counts by status |
| `GET` | `/feed` | Activity feed of recent task updates |

### Axon (Event Bus)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/axon/publish` | Publish event to a channel |
| `GET` | `/axon/events` | Query events (filter by channel, type, source) |
| `GET` | `/axon/events/:id` | Get single event |
| `GET` | `/axon/channels` | List channels with counts |
| `POST` | `/axon/channels` | Create channel |
| `POST` | `/axon/subscribe` | Subscribe agent to channel |
| `POST` | `/axon/unsubscribe` | Remove subscription |
| `GET` | `/axon/subscriptions` | List subscriptions |
| `GET` | `/axon/poll` | Cursor-based event consumption |
| `GET` | `/axon/stream` | SSE real-time event stream |
| `GET` | `/axon/stats` | Bus statistics |

### Loom (Workflow Orchestration)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/loom/workflows` | Create workflow definition |
| `GET` | `/loom/workflows` | List workflows |
| `GET` | `/loom/workflows/:id` | Get workflow |
| `PATCH` | `/loom/workflows/:id` | Update workflow |
| `DELETE` | `/loom/workflows/:id` | Delete workflow |
| `POST` | `/loom/runs` | Start workflow run |
| `GET` | `/loom/runs` | List runs (filter by status, workflow) |
| `GET` | `/loom/runs/:id` | Get run state |
| `POST` | `/loom/runs/:id/cancel` | Cancel run |
| `GET` | `/loom/runs/:id/steps` | Get step states |
| `GET` | `/loom/runs/:id/logs` | Get execution logs |
| `POST` | `/loom/steps/:id/complete` | Complete step (external callback) |
| `POST` | `/loom/steps/:id/fail` | Fail step (external callback) |
| `GET` | `/loom/stats` | Workflow statistics |

### Broca (Action Log)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/broca/actions` | Log action with auto-narration |
| `GET` | `/broca/actions` | Query actions |
| `GET` | `/broca/actions/:id` | Get single action |
| `GET` | `/broca/actions/:id/narrate` | Generate narrative |
| `GET` | `/broca/feed` | Activity feed with narratives |
| `POST` | `/broca/narrate` | Bulk narrate actions |
| `POST` | `/broca/ask` | Natural language query |
| `GET` | `/broca/stats` | Action statistics |

### System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (30+ feature flags) |
| `GET` | `/stats` | Detailed statistics |
| `GET` | `/metrics` | Prometheus-format metrics (admin) |
| `GET` | `/openapi.json` | OpenAPI 3.1 spec |
| `GET` | `/audit` | Query audit log (admin) |
| `POST` | `/checkpoint` | Manual WAL checkpoint (admin) |
| `GET` | `/backup` | Download SQLite database (admin) |
| `POST` | `/backup/verify` | Verify backup integrity (admin) |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/tasks` | List all available admin operations |
| `GET` | `/admin/quotas` | View per-tenant memory quotas |
| `PUT` | `/admin/quotas` | Update tenant quota |
| `GET` | `/admin/tenants` | List all tenants with usage statistics |
| `POST` | `/tenants/provision` | Provision a new tenant |
| `POST` | `/tenants/deprovision` | Deprovision a tenant |
| `GET` | `/admin/providers` | View configured embedding and LLM providers |
| `GET` | `/admin/schema` | Schema info, migration history, drift detection |
| `GET` | `/admin/scale-report` | Scale tier assessment with recommendations |
| `GET` | `/admin/cold-storage` | Memory access distribution and cold storage config |
| `POST` | `/admin/maintenance` | Toggle maintenance mode (rejects non-admin writes) |
| `GET` | `/admin/maintenance` | Check maintenance mode status |
| `POST` | `/admin/reembed` | Re-embed all memories with current provider |
| `POST` | `/admin/rebuild-fts` | Drop and rebuild full-text search index |
| `POST` | `/admin/rebuild-cooccurrences` | Rebuild entity cooccurrence graph |
| `POST` | `/admin/detect-communities` | Run Louvain community detection |
| `POST` | `/admin/backfill-facts` | Extract facts from memories missing structured data |
| `POST` | `/admin/refresh-cache` | Force reload embedding cache from DB |
| `POST` | `/admin/compact` | VACUUM + ANALYZE database to reclaim space |

---

## How It Works

### Memory Lifecycle

1. **Store** - Memory content is checked for near-duplicates via SimHash (Hamming distance <= 3). If unique, it is embedded using BGE-large-en-v1.5 (1024-dim vectors, runs locally via ONNX) and stored in libsql with FTS5 full-text indexing.

2. **Auto-link** - New memories are compared against existing ones via in-memory cosine similarity. Memories above 0.55 cosine similarity are linked with typed relationships (similarity, updates, extends, contradicts, caused_by, prerequisite_for).

3. **FSRS-6 initialization** - Each new memory gets initial FSRS state: stability, difficulty, storage strength, retrieval strength. The power-law forgetting curve starts tracking retrievability.

4. **Fact extraction** - If an LLM is configured, Engram analyzes new memories, extracts structured facts with temporal validity windows (valid_at, invalid_at), auto-tags with keywords, classifies importance, and detects relationships to existing memories. Contradicting facts automatically invalidate predecessors.

5. **Entity cooccurrence** - Entities appearing in the same memory update the cooccurrence graph, building weighted relationships based on frequency, name similarity, and temporal proximity.

6. **Personality extraction** - The personality engine scans for preference, value, motivation, decision, emotion, and identity signals, building a profile over time.

7. **Recall** - Reciprocal Rank Fusion combines four channels: vector similarity, FTS5 full-text, personality signals, and graph relationships. Question-type detection adapts scoring strategy. Cross-encoder reranker refines the final ordering. Every recalled memory gets an implicit FSRS review, building stability.

8. **Spaced repetition** - Each access is an FSRS-6 review graded as "Good". Archived/forgotten memories receive an "Again" grade. Stability grows with successful recalls; frequently accessed memories can have stability measured in months or years.

9. **Dual-strength decay** - Storage strength (0-10) accumulates over time, representing deep consolidation. Retrieval strength (0-1) decays via power law, representing current accessibility. Together they produce a retention score: `0.7 * retrieval + 0.3 * (storage/10)`.

10. **Contradiction detection** - Scans for memories that conflict. LLM verification eliminates false positives. Contradictions can be resolved by keeping one side, both, or merging.

11. **Consolidation** - Large clusters of related memories get summarized into a single dense memory. Originals are archived, links preserved.

12. **Community detection** - Label propagation groups related memories into communities via type-aware edge weights. Communities are browsable and searchable.

13. **Reflection** - On-demand meta-analysis generates insights about themes, progress, and patterns. Reflections become searchable memories themselves.

### Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Engram Server                      │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │  FSRS-6  │  │   RRF    │  │  FTS5    │           │
│  │  Engine   │  │  Scorer  │  │  Search  │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │              │              │                 │
│  ┌────┴──────────────┴──────────────┴────┐           │
│  │    libsql (SQLite + vector columns)   │           │
│  │      FLOAT32(1024) + FTS5             │           │
│  └───────────────────────────────────────┘           │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ BGE-large│  │ Reranker │  │  Graph   │           │
│  │  Embedder │  │ (BGE-rr) │  │  Engine  │           │
│  └──────────┘  └──────────┘  └──────────┘           │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ SimHash  │  │Personality│  │ Temporal │           │
│  │  Dedup   │  │  Engine   │  │  Facts   │           │
│  └──────────┘  └──────────┘  └──────────┘           │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Thymus   │  │  Soma    │  │ Chiasm   │           │
│  │ (Quality)│  │(Registry)│  │ (Tasks)  │           │
│  └──────────┘  └──────────┘  └──────────┘           │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │  Axon    │  │  Loom    │  │  Broca   │           │
│  │(EventBus)│  │(Workflow)│  │(Narrator)│           │
│  └──────────┘  └──────────┘  └──────────┘           │
└──────────────────────────────────────────────────────┘
```

- **Runtime:** Node.js 22+ (primary, with `--experimental-strip-types`) or Bun
- **Database:** libsql (SQLite fork with vector column support)
- **Embeddings:** BGE-large-en-v1.5 (1024-dim, runs locally via raw ONNX inference)
- **Reranker:** BGE-reranker-base (XLM-RoBERTa, quantized INT8, optional)
- **Search:** Reciprocal Rank Fusion across vector, FTS5, personality, and graph channels
- **LLM:** Optional, for fact extraction / personality / consolidation (with fallback chain)
- **Decay:** FSRS-6 (21-parameter power-law forgetting curve)

### Supported LLM Providers

Engram works with any OpenAI-compatible provider via `LLM_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Supports up to 10 providers with automatic failover or round-robin rotation.

| Provider | Example URL | Example Model |
|----------|-------------|---------------|
| **Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-2.5-flash` |
| **MiniMax** | `https://api.minimax.io/v1/chat/completions` | `MiniMax-M2.5` |
| **Groq** | `https://api.groq.com/openai/v1/chat/completions` | `llama-3.3-70b-versatile` |
| **DeepSeek** | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` |
| **OpenAI** | `https://api.openai.com/v1/chat/completions` | `gpt-4o` |
| **Anthropic** | `https://api.anthropic.com/v1/messages` | `claude-sonnet-4-20250514` |
| **Ollama** | `http://127.0.0.1:11434/v1/chat/completions` | `llama3` |
| **LiteLLM** | `http://127.0.0.1:4000/v1/chat/completions` | Any routed model |

---

## Self-Hosting

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_PORT` | `4200` | Server port |
| `ENGRAM_HOST` | `0.0.0.0` | Bind address |
| `ENGRAM_DATA_DIR` | `./data` | Data directory for DB and models |
| `ENGRAM_GUI_PASSWORD` | required | GUI login password unless `ENGRAM_OPEN_ACCESS=1` |
| `ENGRAM_OPEN_ACCESS` | `0` | Set `1` for unauthenticated single-user mode |
| `ENGRAM_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `none` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Enable OpenTelemetry tracing (e.g. `http://localhost:4318`) |
| `ENGRAM_CORS_ORIGIN` | unset | Optional allowed browser origin for cross-origin access |
| `ENGRAM_MAX_BODY_SIZE` | `1048576` | Max request body (bytes) |
| `ENGRAM_MAX_CONTENT_SIZE` | `102400` | Max memory content (bytes) |
| `ENGRAM_ALLOWED_IPS` | - | Comma-separated IP allowlist |
| `ENGRAM_EMBEDDING_PROVIDER` | `local` | Embedding provider: `local`, `google`, `vertex` |
| `ENGRAM_EMBEDDING_DIM` | auto | Embedding dimension (1024 for local, 768 for google/vertex) |
| `ENGRAM_CROSS_ENCODER` | `1` | Set `0` to disable the ONNX cross-encoder reranker |
| `ENGRAM_RERANKER` | `1` | Set `0` to disable all reranking in search results |
| `ENGRAM_RERANKER_TOP_K` | `12` | Rerank top K candidates |
| `ENGRAM_RERANKER_FP32` | `0` | Set `1` for full-precision reranker instead of quantized INT8 |
| `GOOGLE_API_KEY` | - | Google AI Studio API key (for `google` embedding provider) |
| `GOOGLE_CLOUD_PROJECT` | - | GCP project ID (for `vertex` embedding provider) |
| `GOOGLE_APPLICATION_CREDENTIALS` | - | Service account JSON path (for `vertex`) |
| `LLM_URL` | - | OpenAI-compatible API URL |
| `LLM_API_KEY` | - | API key for LLM |
| `LLM_MODEL` | - | Model name (e.g., `gpt-4o`, `claude-sonnet-4-20250514`) |
| `LLM_STRATEGY` | `fallback` | `fallback` or `round-robin` for multi-provider LLM rotation |

#### Search Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_DECAY_FLOOR` | `0.3` | Minimum decay multiplier (0-1). Lower values penalize stale memories harder |
| `ENGRAM_PAGERANK_WEIGHT` | `0.15` | PageRank boost weight in search scoring (0-15% boost for hub memories) |
| `ENGRAM_SEARCH_MIN_SCORE` | `0.58` | Min overall score for search results |
| `ENGRAM_SEARCH_FACT_VECTOR_FLOOR` | `0.22` | Min vector score for fact_recall queries |
| `ENGRAM_SEARCH_PREFERENCE_VECTOR_FLOOR` | `0.12` | Min vector score for preference queries |
| `ENGRAM_SEARCH_REASONING_VECTOR_FLOOR` | `0.10` | Min vector score for reasoning queries |
| `ENGRAM_SEARCH_GENERALIZATION_VECTOR_FLOOR` | `0.12` | Min vector score for generalization queries |
| `ENGRAM_SEARCH_PERSONALITY_MIN_SCORE` | `0.30` | Min score for personality signal matching |
| `AUTO_LINK_MAX` | `6` | Max auto-links created per memory |

### Storage

All data lives in a single libsql database (`data/memory.db`). Embedding BLOBs are stored alongside native `FLOAT32(N)` vector columns matching the configured `EMBEDDING_DIM`.

**Backup:** `GET /backup` returns a consistent SQLite snapshot via `VACUUM INTO` (admin required). Safe to call under write load. WAL checkpoints every 5 minutes and on graceful shutdown. Manual checkpoint via `POST /checkpoint`.

**Audit:** `GET /audit` shows all mutations - who stored, deleted, archived, or modified memories, from which IP, with request IDs.


### Safe Deployment

Production source files are locked immutable (`chattr +i`). Direct writes -- including SCP, git checkout, and editor saves -- are blocked at the kernel level.

To make changes:

1. **Start staging** -- copies production into an unlocked staging directory and launches on port 4201:
   ```bash
   /opt/engram/start-staging.sh
   ```

2. **Edit and test** -- modify files in `/opt/engram/staging/`, then verify:
   ```bash
   curl http://localhost:4201/health
   ```

3. **Promote or discard:**
   - **Promote** -- unlocks production, copies staged files over, re-locks, and restarts:
     ```bash
     /opt/engram/promote.sh
     ```
   - **Discard** -- throws away staging, production untouched:
     ```bash
     /opt/engram/stop-staging.sh
     ```

Staging runs on-demand only. Production source is re-locked automatically after every promote.

### Observability

Engram ships Grafana dashboard provisioning JSON in `grafana/`:

| Dashboard | Contents |
|-----------|----------|
| `engram-service-overview.json` | Request rate, p95 latency, error rate, search throughput, embedding/LLM latency, recent traces |
| `chiasm-service-overview.json` | Chiasm task coordination metrics |
| `service-map.json` | Inter-service dependency map |

To enable tracing, set `OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. `http://localhost:4318`). The server instruments `embed()`, `callLLM()`, and `hybridSearch()` with spans exported via OTLP HTTP. Metrics are available at `GET /metrics` in Prometheus format.

Import the dashboards via Grafana's provisioning API or the UI (Dashboards > Import > Upload JSON).

### Reverse Proxy

```nginx
server {
    server_name memory.example.com;

    location / {
        proxy_pass http://127.0.0.1:4200;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Test Suite

```bash
# Start the server, then:
npm test
# or directly:
node --test tests/api.test.mjs
```

---

## License

Elastic License 2.0 - see [LICENSE](LICENSE).
