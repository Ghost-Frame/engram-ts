<div align="center">

# Engram

### Persistent memory for AI agents

Store, search, recall, and link memories with automatic embeddings,
fact extraction, versioning, deduplication, and graph visualization.

[![License: Elastic-2.0](https://img.shields.io/badge/License-Elastic--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-5.8.1-gold.svg)](CHANGELOG.md)

[Quick Start](#quick-start) · [API Reference](#api-reference) · [SDKs](#sdks) · [MCP Server](#mcp-server) · [CLI](#cli) · [Self-Host](#self-hosting) · [GUI](#gui)

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
- 🏘️ **Community detection** - label propagation groups related memories into discoverable clusters
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
- ⌨️ **CLI** - full-featured command-line interface (`engram store`, `engram search`, etc.)
- 📥 **Review queue / inbox** - auto-detected memories land in review; explicit stores bypass
- 🔒 **Security hardening** - auth required by default, body/content limits, IP allowlists, timing-safe auth
- 📋 **Audit trail** - every mutation logged (who, what, when, from where)
- 📊 **Structured JSON logging** - configurable log levels, request IDs, zero raw console output
- 💾 **Backup & checkpoint** - download SQLite DB via API, manual WAL checkpoint, graceful shutdown
- 🐳 **One-command deploy** - `docker compose up`

---

## What's New in v5.8

### Reciprocal Rank Fusion (RRF) Search
Replaced simple weighted-sum scoring with **RRF across four channels**: vector similarity (BGE-large), FTS5 full-text, personality signal matching, and graph-based relationships. Type-aware link weighting gives causal links 2x multiplier, updates/corrections 1.5x, and extensions/contradictions 1.3x.

Question-type-aware scoring adapts retrieval strategy based on intent:
- `fact_recall` (default), `preference`, `reasoning`, `generalization`, `temporal`
- Temporal queries get date-aware Gaussian proximity boosts

### SimHash Deduplication
64-bit locality-sensitive hashing via FNV-1a tokenization. Hamming distance <= 3 flags near-duplicates **before** embedding, saving compute. Matching memories get boosted instead of re-embedded.

### Bi-Temporal Fact Tracking
Structured facts now carry temporal validity windows (`valid_at`, `invalid_at`) with automatic contradiction-based invalidation. When a new fact contradicts an existing one on the same subject+verb, the old fact is automatically marked invalid. Relative date resolution handles phrases like "last Tuesday" or "3 weeks ago."

### Entity Cooccurrence Graph
Entities appearing together in memories build weighted relationships scored by name similarity (0.2), cooccurrence frequency (0.5), and temporal proximity (0.3). Relationships above 0.6 threshold are auto-created. Incremental updates on each memory store.

### Community Detection
Label propagation algorithm on the memory links graph groups related memories into communities. Type-aware edge weights match the search multipliers. Run via `POST /admin/detect-communities`, browse via `GET /communities`.

### Cross-Encoder Reranker
BGE-reranker-base (XLM-RoBERTa) with hand-written SentencePiece tokenizer (zero deps). Quantized INT8, ~337MB model, sub-100ms inference. Auto-downloads from Hugging Face on startup. Disable with `ENGRAM_CROSS_ENCODER=0`.

### Personality Engine
Extracts six signal types from memories: preference, value, motivation, decision, emotion, and identity. Each signal captures subject, valence (positive/negative/neutral/mixed), intensity (0.0-1.0), reasoning, and source text. Synthesizes a coherent personality profile via LLM covering core values, decision-making patterns, emotional tendencies, and growth trajectory. Integrated into search scoring when `includePersonalitySignals` is true.

### Context Depth
`/context` now supports a `depth` parameter (1/2/3):
- **Depth 1:** Direct matches only
- **Depth 2:** 1-hop relationships
- **Depth 3:** 2-hop relationships with source memories

### New Endpoints
- `GET /facts` - query structured facts with filtering
- `GET /communities` - list and browse memory communities
- `GET /preferences` - get stored user preferences
- `GET /state` - get current user state
- `POST /profile/synthesize` - synthesize personality profile from signals
- `POST /admin/backfill-facts` - re-extract facts from all memories
- `POST /admin/rebuild-cooccurrences` - rebuild entity cooccurrence graph
- `POST /admin/detect-communities` - run community detection

### Search & Context Overrides
`POST /search` accepts optional body parameters: `vector_floor` (minimum similarity threshold), `question_type` (fact_recall/preference/reasoning/generalization/temporal).

`POST /context` supports 12 overrides: `max_memory_tokens`, `dedup_threshold`, `min_relevance`, `semantic_ceiling`, `semantic_limit`, and 7 layer toggles (`episodes`, `linked`, `inference`, `current_state`, `preferences`, `structured_facts`, `working_memory`).

#### v5.8 - Intelligence Pipeline Overhaul

**Reciprocal Rank Fusion** - Replaced weighted-sum scoring with RRF across 4 search channels (vector, FTS5, personality, graph). More robust ranking with less parameter tuning.

**SimHash Deduplication** - 64-bit locality-sensitive hashing detects near-duplicate memories before embedding, saving compute. Hamming distance threshold of 3 bits. Existing memories get source_count boosted instead of creating duplicates.

**Bi-Temporal Fact Tracking** - Structured facts now carry valid_at/invalid_at windows inspired by Graphiti/Zep. Old facts are never deleted, just invalidated. Contradiction detection auto-invalidates predecessor facts on the same subject+verb.

**Entity Cooccurrence Graph** - Tracks entity co-mentions with composite scoring (name similarity, frequency, temporal proximity). Auto-creates relationships above threshold.

**Community Detection** - Label propagation on the memory_links graph with type-aware edge weights. Detects memory clusters for browsing and context enrichment.

**Temporal Retrieval** - New "temporal" question type with date-aware Gaussian proximity boost. Resolves relative dates ("last Tuesday", "two weeks ago") against query context.

**Progressive Disclosure** - `/context` accepts depth=1 (core only), depth=2 (+ semantic/preferences), depth=3 (full context). Reduces token usage for simple queries.

**Cross-Encoder Reranker** - Optional re-ranking pass for search results using a cross-encoder model.

**Core Memory Auto-Promotion** - Memories automatically promoted to static when they exceed access, source, and stability thresholds.

<details>
<summary><strong>Previous releases</strong></summary>

#### v5.7 - BGE-large, Episodic Memory, Multi-Tenant Isolation

**BGE-large 1024-dim Embeddings** - Replaced MiniLM-L6-v2 (384-dim) with BGE-large-en-v1.5 (1024-dim) using raw `onnxruntime-node` and a hand-written BERT WordPiece tokenizer. 1024 dimensions, 512-token context, quantized INT8 (337MB, sub-200ms on CPU). Auto-migration re-embeds existing vectors on first startup.

**Episodic Memory** - Conversation episodes as first-class embedded, searchable objects. BGE-large embeddings, FTS5 search, temporal date-range queries, semantic search, `POST /episodes/:id/finalize` for narrative summaries, FSRS decay, and automatic `/context` injection.

**Multi-Tenant Data Isolation** - Complete security audit of all cross-tenant boundaries. User-scoped embedding cache, ownership checks on all endpoints, conversation isolation, write scope enforcement, user-scoped stats, and user-filtered graph BFS.

**Guardrails** - `POST /guard` checks proposed actions against stored rules. Returns `allow`, `warn`, or `block` with matched rule context.

**Benchmark Features** - Abstention (`ENGRAM_SEARCH_MIN_SCORE`), assistant recall (LLM + regex extraction of AI actions), temporal sort, 2-hop graph traversal, implicit connection inference in `/context`.

#### v5.6 - Node.js 22, Graph Intelligence
- Node.js 22+ as primary runtime (`--experimental-strip-types`), Bun maintained for compatibility
- Optimized MCP server (529 to 168 lines), vitest framework (76+ tests)
- Graphology knowledge graph: centrality, shortest paths, community detection, relationship inference

#### v5.5 - Intelligence Layer
- LLM fact extraction, auto-tagging, relationship classification
- Conversation extraction, URL ingest, reflections, derived memories, auto-consolidation
- MCP server improvements: error handling, streaming, tool introspection

#### v5.3 - Security Hardening
- Auth required by default, rate limit fix, body size limits
- GUI auth rate limiting, timing-safe password comparison
- Security headers, CORS origin pinning, IP allowlisting
- Audit trail, structured JSON logging

#### v5.0 - FSRS-6 Spaced Repetition
- 21-parameter power-law forgetting curve (ported from open-spaced-repetition/fsrs4anki)
- Dual-strength model (Bjork & Bjork 1992): storage strength + retrieval strength
- Formula: `R = (1 + factor * t/S)^(-w20)`

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

### 6. Open the GUI

Visit `http://localhost:4200` in your browser. Log in with the `ENGRAM_GUI_PASSWORD` you set. Explore the memory graph, search, and review the inbox.

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

The GUI also shows an inbox badge with the pending count. Memories you store directly via `/store` bypass the inbox and are approved immediately.

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
| `memory_store` | Store a new memory with category, importance, and model attribution |
| `memory_recall` | Semantic + full-text search across memories |
| `memory_context` | Token-budget-aware context packing for LLM injection |
| `memory_list` | List recent memories, optionally filtered by category |
| `memory_delete` | Delete a memory by ID |

> **Note:** The MCP server connects to a running Engram instance via HTTP. All tools support signed tool manifests for integrity verification when `ENGRAM_SIGNING_SECRET` is set.

---

## CLI

> **Roadmap:** A dedicated CLI is planned. For now, use `curl` or any HTTP client directly against the API.

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
| `GET` | `/state` | Get current user state |
| `POST` | `/profile/synthesize` | Synthesize personality profile from signals |

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

### System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (30+ feature flags) |
| `GET` | `/stats` | Detailed statistics |
| `GET` | `/audit` | Query audit log (admin) |
| `POST` | `/checkpoint` | Manual WAL checkpoint (admin) |
| `GET` | `/backup` | Download SQLite database (admin) |

---

## How It Works

### Memory Lifecycle

1. **Store** - Memory content is checked for near-duplicates via SimHash (Hamming distance <= 3). If unique, it is embedded using BGE-large-en-v1.5 (1024-dim vectors, runs locally via ONNX) and stored in libsql with FTS5 full-text indexing.

2. **Auto-link** - New memories are compared against existing ones via in-memory cosine similarity. Memories above 0.7 similarity are linked with typed relationships (similarity, updates, extends, contradicts, caused_by, prerequisite_for).

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

Engram works with any OpenAI-compatible provider via `LLM_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Automatic failover across up to 3 providers.

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

## GUI

Engram includes a WebGL graph visualization at `/gui`. Login with your `ENGRAM_GUI_PASSWORD`.

**Features:**
- Interactive galaxy-style memory graph
- Click memories to view details
- Create, edit, archive, and delete memories
- Semantic search with hybrid client/API matching
- Category filters and sorting
- Keyboard shortcuts (L=list, N=new, Z=fit, C=center, arrows=navigate)
- Export data

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
| `ENGRAM_CORS_ORIGIN` | unset | Optional allowed browser origin for cross-origin access |
| `ENGRAM_MAX_BODY_SIZE` | `1048576` | Max request body (bytes) |
| `ENGRAM_MAX_CONTENT_SIZE` | `102400` | Max memory content (bytes) |
| `ENGRAM_ALLOWED_IPS` | - | Comma-separated IP allowlist |
| `ENGRAM_EMBEDDING_PROVIDER` | `local` | Embedding provider: `local`, `google`, `vertex` |
| `ENGRAM_EMBEDDING_DIM` | auto | Embedding dimension (1024 for local, 768 for google/vertex) |
| `ENGRAM_CROSS_ENCODER` | `1` | Set `0` to disable the ONNX cross-encoder reranker |
| `ENGRAM_RERANKER` | `1` | Set `0` to disable LLM-based reranking |
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
