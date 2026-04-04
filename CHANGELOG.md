# Changelog

All notable changes to Engram will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.0.0] - 2026-04-03

### Added
- **Artifact storage** -- attach files and binary data to memories. Hybrid storage: inline BLOB under 1MB, disk with SHA-256 dedup for larger files. Artifact metadata surfaced in /search, /recall, and /context responses. Disk cleanup on memory forget/delete. Endpoints: `GET /artifacts/:memoryId`, `GET /artifact/:id`, `GET /artifacts/stats`.
- **Skills engine** -- filesystem skill registry with SKILL.md discovery, hybrid FTS5+vector search with RRF fusion, LLM-driven skill fixer, OpenSpace cloud search and upload. HTTP routes for sync, search, execute, fix, upload, and CRUD. MCP tools: `skill_search`, `skill_fix`, `skill_upload`, `skill_execute`. Auto-syncs `ENGRAM_SKILL_DIRS` at startup.
- **Modular server architecture** -- monolith decomposed into 23 domain modules with a lightweight router, auth middleware with request context, audit logging, and request validation. New entry point at `server.ts` replaces the old monolith.
- **Bulk ingestion pipeline** -- ZIP parser, file type detection, chunking, and processing pipeline. CLI `ingest` command and `POST /import/bulk` endpoint for batch memory import.
- **Embedding model upgrade** -- swapped to BGE-M3 embeddings and IBM Granite reranker. Configurable model directories via `ENGRAM_RERANKER_MODEL_DIR`. OpenAI-compatible embedding provider for custom model support.
- **Personality auto-injection** -- personality profile automatically included in /recall and /context responses.
- **GUI overhaul** -- living organism nodes with flow trail connections, reactive graph controls (labels, weight, clusters), bloom effects, spread layout. README redesign with animated GIFs.

### Fixed
- Docker entrypoint switched from server-split.ts to server.ts
- Syntheos services (Soma, Chiasm, Axon, Broca, Loom, Thymus) wired into modular router
- Silent truncation of long memories via chunked embedding
- Auth skipped for health probe endpoints (/live, /ready, /health, /metrics)
- Oracle memory cap at 8, content truncated to 300 chars for performance
- Artifact validation moved before memory insert for atomicity
- Consolidation interval units clarified, embedding output dims validated

## [5.11.0] - 2026-03-26

### Added
- **Syntheos Phase 2: Axon, Loom, Broca consolidation** -- Three more standalone microservices absorbed into the Engram monolith under `src/services/`. All six Syntheos services now run as native modules.
- **Axon** (`src/services/axon/`): Real-time event bus with pub/sub channels, SSE streaming via Web ReadableStream, webhook fan-out with SSRF validation, and cursor-based polling. Replaces the Phase 1 no-op stub. Endpoints under `/axon/*`.
- **Loom** (`src/services/loom/`): Workflow orchestration engine with dependency-based step execution. Supports webhook, LLM, and transform step types with retry logic. Endpoints under `/loom/*`.
- **Broca** (`src/services/broca/`): Agent action logger with 30+ template-based narratives and LLM fallback. Natural language query gateway (`POST /broca/ask`) routes questions to internal services via direct function calls. Endpoints under `/broca/*`.
- Hourly Axon event pruning timer for expired events

### Fixed
- Replaced Axon no-op stub with real event bus (Phase 1 services now emit real events)
- Fixed Axon `getEvent()` bug (`r.payload` to `row.payload` from standalone source)
- Moved `publish()` calls outside transaction callbacks in Chiasm engine
- Added SSRF validation on Axon webhook URLs and Loom step executor URLs
- Added `ON DELETE CASCADE` on all Loom foreign keys
- Added `CHECK` constraints on Loom run status, step status, and step type columns
- Broke recursive `advanceRun` chain in Loom with `setImmediate()` to prevent stack overflow

## [5.10.0] - 2026-03-26

### Added
- **Syntheos Phase 1: Service Consolidation** - Three standalone microservices absorbed into the Engram monolith as native modules under `src/services/`. Zero new dependencies, zero new processes. All services share the main database, auth middleware, and event bus.
- **Thymus** (`src/services/thymus/`): Rubric-based quality evaluation engine. Create rubrics with weighted criteria, score agent outputs, aggregate per-agent stats, and record arbitrary quality metrics. Endpoints under `/thymus/*`.
- **Soma** (`src/services/soma/`): Agent lifecycle registry. Register agents with capabilities, track heartbeats, detect stale agents, organize into groups, collect structured logs. Endpoints under `/soma/*`.
- **Chiasm** (`src/services/chiasm/`): Task tracking and coordination. Agents create tasks, update status with audit trail, read each other's active work via a feed endpoint. Endpoints under `/tasks/*` and `/feed`.
- **Shared service infrastructure** (`src/services/`): Common types, helpers (`parseJsonFields`, `parseJsonFieldsAll`), Axon event bus stub for cross-service pub/sub, bounded integer validation.
- **Service design spec** (`docs/superpowers/plans/2026-03-26-service-consolidation-design.md`): Architecture document for the consolidation approach.

### Fixed
- Division by zero in Thymus scoring normalization when `scale_max === scale_min`
- Soma heartbeat endpoint now validates status against allowed values before passing to engine
- Soma `deregisterAgent` wrapped in transaction for atomic cascade deletes
- Added `ON DELETE CASCADE` to Soma foreign key references (agent_groups, agent_logs)
- Added `CHECK` constraint on Chiasm task status column

## [5.9.5] - 2026-03-25

### Fixed
- `/ready` probe returned 503 on empty databases: was checking embedding cache size instead of model readiness. Fresh or cleaned-up DBs with zero memories were incorrectly marked "degraded" even though the embedding model was fully loaded.

## [5.9.4] - 2026-03-25

### Fixed
- Fresh-database crash: `recall_hits` migration ran after prepared statements that referenced it, causing "no such column" on first startup
- `/graph` GET returned GUI HTML to API clients instead of JSON (now checks Accept header)
- Documentation accuracy: removed false `/graph` community_id claim, fixed auto-link threshold (0.7 to 0.55), fixed LLM provider count (3 to 10), fixed CLI command names
- Replaced nonexistent Python SDK with CLI examples on landing page
- Fixed MCP server config in landing page (mcp-server.mjs to mcp-server.ts)
- Fixed SDK package name on landing page (@engram/sdk to @zanfiel/engram/sdk)
- Updated CONTRIBUTING.md to reflect v5.9 changes, removed shipped items from roadmap

## [5.9.0] - 2026-03-22

### Added
- **PageRank algorithm** (`src/graph/pagerank.ts`): iterative weighted PageRank with type-aware edge weights (caused_by/causes 2.0x, updates/corrects 1.5x, extends 1.3x). Normalizes scores to 0-1 and stores in `pagerank_score` column. Converges in ~25 iterations for typical graphs.
- **Search centrality boost**: search scoring now applies a 0-15% multiplicative boost from PageRank scores. Structurally important memories surface higher in `/search`, `/context`, and `/recall` results.
- **Auto graph analysis on store**: every 25th memory stored triggers community detection and PageRank recomputation via the post-store durable job pipeline. No impact on store latency.
- **`GET /graph/timeline` endpoint**: returns weekly aggregates of graph growth (new memories, running totals, link counts per week). Enables temporal evolution analysis.
- **Enriched `/graph` response**: nodes now include `pagerank_score` field. Node `size` boosted by PageRank.
- **`pagerank_score` column**: auto-created on memories table via `ensurePageRankColumn()`.

## [5.8.3] - 2026-03-20

### Added
- **Server-side source filtering**: `/search`, `/context`, and `/recall` accept a `source` parameter that filters at the vector scan and FTS5 stages inside `hybridSearch()`. When active, `/search` over-fetches 5x candidates to compensate for filtering, then trims to the requested limit. Enables agent-specific memory isolation and benchmark runs against production data.
- **Source field in embedding cache**: `CachedMem` now includes `source`, populated from the `getAllEmbeddings` query. Allows early filtering during in-memory vector scan without DB round-trips.
- **Worker thread embeddings**: ONNX embedding inference moved from main thread to a dedicated `Worker` thread via `postMessage`/`onmessage`. Embedding calls no longer block the HTTP event loop.
- **Batch link queries**: `getLinksForUserBatch()` replaces N+1 individual `getLinksForUser` calls during search relationship expansion. Single SQL query fetches all hop-1 links for a batch of seed IDs.

### Fixed
- TypeScript compilation: fixed `SharedArrayBuffer` not assignable to `Transferable` in `embedding-worker.ts` (explicit `as ArrayBuffer` cast)
- TypeScript compilation: fixed `link.source` type mismatch (`string | null` vs `string | undefined`) at both hop-1 and hop-2 graph expansion sites in `search.ts`
- MCP server version synced to 5.8.3 (was stuck at 5.8.1)
- Codebase now compiles with **zero TypeScript errors** (was 3)

## [5.8.2] - 2026-03-18

### Fixed
- CI contract tests now connect to correct server port (server starts on 4200, tests defaulted to 4201)
- CI server readiness: replaced fixed `sleep 5` with polling `/live` endpoint (up to 30s), fixing flaky test failures when ONNX model load takes longer than expected
- pixi.js graph visualization: added `@pixi/unsafe-eval` polyfill to fix "does not allow unsafe-eval" error in restrictive browser environments
- Webhook delivery: fire-and-forget promises now tracked in `_inFlight` set; `drainWebhooks()` called during graceful shutdown to prevent dropping in-flight deliveries
- Webhook auto-disable: failures now correctly route through `recordWebhookFailure()` for threshold counting and structured logging

## [5.8.1] - 2026-03-18

### Security
- **Atomic memory ownership**: `insertMemory` now accepts `user_id` and `space_id` as parameters (19 total), eliminating the post-insert UPDATE race window where rows briefly existed as default tenant. All 18 call sites updated.
- **Bootstrap hardening**: `/bootstrap` endpoint now requires localhost access or a one-time token from `DATA_DIR/.bootstrap_token`. Token is auto-generated on first access, deleted after successful bootstrap. Prevents drive-by admin key creation on fresh deploys.
- **Cross-tenant scratchpad fix**: TTL sweep now groups expired entries by `user_id:session`, preventing summaries from leaking into the wrong tenant.
- **GUI auth clarity**: Startup warning when GUI password is configured with multiple users. Documented as single-user-only.
- **SSRF redirect blocking**: Webhook and digest fetch calls use `redirect: "error"` to prevent redirect-based SSRF bypasses.
- **Passport tenant binding**: Agent passports now include `user_id` and `issuer` fields, preventing cross-tenant signature reuse.

### Added
- **Durable job queue**: DB-backed `jobs` table replaces fire-and-forget `setTimeout` for post-store processing (vector write, auto-link, fact extraction, personality signals). Jobs have retry with exponential backoff (3 attempts), crash recovery for stuck jobs, hourly cleanup of completed jobs.
- **Scheduler leases**: All 6 background intervals (forget sweep, scratchpad TTL, decay refresh, consolidation, digests, job cleanup) wrapped with DB-backed leases. Prevents duplicate work in multi-instance deployments. Leases released on graceful shutdown.
- **Readiness probes**: `GET /live` (process up), `GET /ready` (DB writable + embeddings loaded + LLM available). Returns 503 when degraded.
- **Schema versioning**: `schema_versions` table tracks applied migrations. `migrateCritical()` blocks startup on failure.
- **Webhook auto-disable**: Webhooks auto-deactivate after 10 consecutive failures with structured logging.
- **Scratchpad TTL summarization**: Expired multi-entry scratchpad sessions are LLM-summarized and stored as permanent memories before purging.
- **Working memory token cap**: `buildWorkingMemoryBlock` capped at 4000 chars (~1K tokens) with per-value truncation at 300 chars.
- **Gemini 3 Flash Preview**: Added as LLM provider via AI Studio API.
- **Vertex AI support**: Full service account OAuth2 auth, Gemini 2.5 Pro available via GCP trial credits.
- **Backup/restore drill**: `scripts/backup-restore-drill.sh` validates backup integrity, schema, and data.

### Fixed
- Digest duplicate-send risk: `processScheduledDigests` uses optimistic claiming (atomic `next_send_at` CAS) to prevent concurrent workers from sending the same digest.
- Consolidation `insertMemory` call was missing `model` parameter (only 16 args instead of 17).

## [5.7.0] - 2026-03-14

### Security
- **Multi-tenant data isolation**: Complete audit and fix of 30+ cross-tenant data boundaries
  - `getCachedEmbeddings` now accepts optional `userId` filter — all callers in search, auto-link, contradiction detection, deduplication, and fact extraction pass the authenticated user's ID
  - `autoLink` scoped to same-user memories — prevents cross-user link creation
  - `addToEmbeddingCache` now includes `user_id` — fixes cache filtering for newly added memories
  - Conversation prepared statements (`listConversations`, `listConversationsByAgent`, `searchMessages`, `getConversationBySession`, `deleteConversation`) all filter by `user_id`
  - Conversation CRUD endpoints (`GET/PATCH/DELETE /conversations/:id`, `POST /conversations/:id/messages`, `POST /conversations/bulk`, `POST /conversations/upsert`, `POST /messages/search`) have ownership checks and write scope guards
  - `/contradictions` and `/contradictions/resolve` scoped to authenticated user with ownership verification
  - `/duplicates` and `/deduplicate` scoped to authenticated user
  - `/memory/:id/update` now requires write scope and verifies memory ownership
  - Entity and project `GET /:id` endpoints verify ownership
  - Entity/project link and unlink endpoints verify ownership of both the entity/project and the memory
  - `/links/:id` and `/versions/:id` verify memory ownership before returning data
  - `/episodes/:id` GET and PATCH verify episode ownership
  - `/decay/scores` filtered by `user_id`
  - `/consolidations` filtered by `user_id`
  - `/fsrs/init` scoped to user's memories with write scope guard
  - `/graph` BFS traversal joins against `memories` table for user_id filtering
  - `/stats` consolidated from 13 unfiltered `COUNT(*)` queries to 4 user-scoped queries; `db_path` removed from non-admin response
- Write scope guards added to `/sweep`, `/backfill`, `/deduplicate`

### Fixed
- `propagateConfidence` in `src/llm/index.ts` fully implemented (was a no-op stub in the modular split)
  - "updates" relation: sets superseded memory confidence to 0.3
  - "contradicts" relation: reduces both memories' confidence, fires `contradiction.detected` webhook
  - "extends" relation: boosts corroborated memory confidence by 5%
- `insertConversation` and `insertConversationTx` now include `user_id` column — conversations are attributed to the authenticated user at insert time instead of via follow-up UPDATE

### Added
- API test suite: `tests/api.test.mjs` — 33 tests across 14 suites covering health, store, search, recall, memory CRUD, conversations, stats, contradictions, duplicates, graph, episodes, entities, projects, FSRS, and cleanup

## [5.5.0] - 2026-03-13

### Changed
- **Modular architecture**: Monolith `server.ts` split into focused modules under `src/`
  - `src/config/` — environment config and logger
  - `src/db/` — schema, migrations, prepared statements
  - `src/embeddings/` — model init, in-memory cache, similarity
  - `src/fsrs/` — FSRS-6 spaced repetition engine
  - `src/intelligence/` — fact extraction, consolidation
  - `src/llm/` — LLM client, reranking
  - `src/memory/` — hybrid search, auto-linking, profile
  - `src/platform/` — webhooks, digests
  - `src/auth/` — authentication middleware
  - `src/tier4/` — causal chains, predictive recall, emotional valence, reconsolidation
  - `src/routes/` — all HTTP handlers
- Entry point is now `server-split.ts` (imports from `src/`)

### Fixed
- `FSRSRating` is now both a const value and a type (declaration merging) — fixes TypeScript errors across FSRS consumers
- Exported `FSRSMemoryState` interface from `src/fsrs/`
- Aliased `calculateDecayScore` import to resolve shadowing by local route wrapper
- Exported `graphCache` + `setGraphCache` from `src/embeddings/` to break module boundary
- Added `"corrects"` to `FactExtractionResult` relation type union — was in the LLM prompt but missing from the TypeScript type
- Fixed `trackAccessWithFSRS` local wrapper to accept optional `grade` parameter
- Fixed `addToEmbeddingCache` calls missing `user_id` field

## [5.4.0] - 2026-03-10

### Security
- **S1**: Cookie verification now uses `timingSafeEqual` — prevents timing attacks on GUI auth
- **S2**: Fixed undefined `reason` variable in inbox reject — was crashing on every reject
- **S3**: Fixed `require("fs")` in ESM backup cleanup — temp files were never deleted
- **S4**: Fixed `extractFacts()` call signatures in `/add` and `/ingest` — was passing memory ID as content and Float32Array as similar memories, sending garbage to LLM
- **S5**: Added per-IP rate limiting for `OPEN_ACCESS` mode — prevents DoS
- **S6**: Added webhook URL validation — blocks SSRF to private/internal IP ranges
- **S7**: Split `/health` into light (unauthenticated: status + version + count) and full (authenticated: all config + stats)
- Added `Strict-Transport-Security` header (HSTS)
- Added `Content-Security-Policy` header on all responses

### Added
- **RBAC**: Users now have roles (`admin`, `writer`, `reader`) with enforced scope restrictions
  - `reader`: can only search/recall, cannot create/modify memories
  - `writer`: can create/modify own memories, cannot access admin endpoints
  - `admin`: full access (default for backwards compatibility)
- Source filter on `/list` endpoint (`?source=conversation`)
- Body fields `is_static`, `forget_after`, `forget_reason`, `is_inference` now respected on `/store`
- `.env.example` with all configuration variables documented
- `tsconfig.json` with strict mode
- `CHANGELOG.md` (this file)
- `CONTRIBUTING.md` with development guidelines

### Fixed
- **B1**: `/store` now respects `is_static` from request body (was always 0)
- **B2**: `/store` now respects `forget_after` from request body (was always null)
- **B3**: `/list` now supports `?source=` query parameter
- **B5**: GUI PATCH now invalidates embedding cache after edits
- **B6**: Bulk inbox error handler no longer re-reads consumed request body

## [5.3.0] - 2026-03-09

### Added
- FSRS-6 spaced repetition system (21 trained weights from Anki dataset)
- Dual-strength model (Bjork & Bjork 1992) — storage strength vs retrieval strength
- LLM-based fact extraction with relationship detection (updates, extends, contradicts, caused_by, prerequisite_for)
- Contradiction detection and resolution (`/contradictions`, `/contradictions/resolve`)
- Time travel queries (`/timetravel`) — query memory state at any past timestamp
- Smart context builder (`/context`) with token-budgeted packing and strategies (balanced/precision/breadth)
- Memory reflections (`/reflect`) — periodic meta-analysis with theme detection
- Scheduled digests (`/digests`) — webhook delivery of memory summaries
- Derived memories (`/derive`) — LLM inference of new facts from existing clusters
- Auto-consolidation — summarizes large memory clusters automatically
- Import from Mem0 and SuperMemory formats
- Entity and project management with scoped search
- Review queue / inbox (`/inbox`) with approve/reject/edit workflow
- Comprehensive audit log with per-action tracking
- Webhook event system with HMAC signing
- Multi-instance sync (`/sync/changes`, `/sync/receive`)
- Graph API with BFS traversal, entity overlay, and project grouping
- Episode tracking for conversation sessions
- Duplicate detection and deduplication (`/duplicates`, `/deduplicate`)
- WebGL galaxy visualization GUI
- Prompt template engine (`/prompt`) with Anthropic/OpenAI/LlamaIndex formats
- Context window optimizer (`/pack`) with greedy token packing

## [5.0.0] - 2026-03-08

### Added
- Multi-tenant architecture: users, API keys, spaces
- API key authentication with scoped permissions
- Per-key rate limiting
- Web GUI with password authentication
- Full-text search (FTS5) + vector hybrid search
- In-memory embedding cache for sub-millisecond search
- Auto-linking based on embedding similarity
- Version chains with parent/root memory tracking
- Memory forgetting with TTL (`forget_after`)
- Static vs dynamic memory classification
- Confidence scoring with propagation
- libsql native FLOAT32 vector column with HNSW index

## [4.0.0] - 2026-03-07

### Added
- SQLite + FTS5 persistent storage
- Xenova/all-MiniLM-L6-v2 local embeddings (384 dimensions)
- Basic CRUD: store, search, recall, delete
- Conversation storage with message search
- JSON export/import
- Node.js HTTP server (minimal dependencies: libsql, onnxruntime-node, graphology)

## [3.0.0] - 2026-03-06

### Added
- Initial release as ZanMemory/MegaMind
- In-memory storage with periodic persistence
- Basic embedding search
