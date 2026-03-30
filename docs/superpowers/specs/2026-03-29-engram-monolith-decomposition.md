# Engram Monolith Decomposition

**Date:** 2026-03-29
**Version:** 6.0.0
**Status:** Approved

## Problem

Engram is 105K lines of TypeScript. The core API lives in a single 8,410-line route handler (`src/routes/index.ts`) containing 150+ endpoints across 22 functional domains. The database layer is a single 2,244-line file (`src/db/index.ts`). Business logic (search algorithms, context assembly, graph traversal, LLM extraction, reflection generation) is embedded inline in route handlers, making it untestable in isolation and impossible for agents to work on one domain without loading the entire project.

The ingestion pipeline built in v5.12.0 proved the target architecture: domain modules with their own types, logic, routes, DB queries, and tests. This refactor applies that pattern to the entire codebase.

## Solution

Full decomposition of the monolith into domain modules following the ingestion template. A lightweight custom router replaces the manual URL matching dispatch. Each domain gets its own directory with types, routes, business logic, DB queries, and tests. The refactored codebase is built and tested on Rocky (100.64.0.2) staging before replacing production.

A future second project migrates the lightweight router to Hono once the decomposition is stable. That is out of scope here.

## Architecture

### Foundation Layer

Five new infrastructure pieces that all domain modules depend on:

**`src/db/connection.ts`** — Database connection setup, schema migrations, WAL/pragma configuration. Exports a single `db` object. Replaces the connection portion of `src/db/index.ts`.

**`src/router/index.ts`** — Lightweight router (~100 lines). Supports path parameters (`/memory/:id`), HTTP method dispatch, middleware chains, and route grouping. Each domain exports a `registerRoutes(router)` function.

**`src/middleware/auth.ts`** — Auth and scope checking. Extracts the `hasScope(auth, "write")`, `canAccessOwnedRow()`, and API key validation currently copy-pasted into every route handler. Applied as router middleware.

**`src/middleware/validate.ts`** — Request body parsing and validation. Replaces the manual `typeof body.content === "string"` checks. Simple schema objects per route.

**`src/middleware/audit.ts`** — Audit logging middleware. Extracts the `audit()` calls scattered across ~30 routes.

**New server entry point** — Fresh `server.ts` that creates the router, mounts domain routes, and starts listening. The old `server-split.ts` stays untouched until the swap.

### Domain Module Pattern

Every domain follows the ingestion template:

```
src/<domain>/
  types.ts     — Interfaces, enums, constants
  routes.ts    — Route definitions (thin: parse request, call logic, format response)
  db.ts        — All SQL queries for this domain
  index.ts     — Business logic
```

Some domains add more files when logic is complex enough to split. But the base 4-file pattern is the minimum.

Routes are thin. They parse the request, call business logic from `index.ts`, and format the response. No algorithms, no LLM calls, no database queries in route handlers.

### Database Strategy

Single shared database connection. One `db` object exported from `src/db/connection.ts`, imported by every domain's `db.ts`. Cross-domain queries (search joining memories + entities + episodes) work because it is all one SQLite database.

The current `src/db/index.ts` is decomposed: connection setup goes to `src/db/connection.ts`, and each query function moves to the domain that owns it. Schema migrations stay centralized in `src/db/connection.ts` since migration ordering matters.

### Router Design

Lightweight custom router. No framework dependency. Approximately 100 lines.

Features:
- `router.get("/path/:id", handler)` — method + path registration with named parameters
- `router.use(middleware)` — global middleware (auth, logging)
- `router.group("/prefix", groupFn)` — route grouping for domains
- Path parameter extraction into handler arguments
- 404 fallback for unmatched routes

Each domain's `routes.ts` receives the router and registers its routes:

```typescript
// src/memory/routes.ts
export function registerRoutes(router: Router) {
  router.post("/store", storeMemory);
  router.post("/memory", storeMemory);
  router.get("/memory/:id", getMemory);
  router.delete("/memory/:id", deleteMemory);
  // ...
}
```

The main server mounts all domains:

```typescript
// server.ts
import { createRouter } from "./src/router/index.ts";
import { registerRoutes as memoryRoutes } from "./src/memory/routes.ts";
import { registerRoutes as searchRoutes } from "./src/search/routes.ts";
// ...

const router = createRouter();
router.use(authMiddleware);
router.use(auditMiddleware);

memoryRoutes(router);
searchRoutes(router);
// ... all domains
```

## Domain Inventory

22 functional domains extracted from the current route handler, grouped by extraction wave.

### Wave 1: Core (depends on Foundation)

**memory** — Memory CRUD, store pipeline (SimHash dedup, embedding, quota enforcement, episode auto-creation, status handling). 18 routes. Heaviest domain.
- Routes: `/store`, `/memory`, `/memory/:id`, `/memory/:id/update`, `/memory/:id/forget`, `/memory/:id/archive`, `/memory/:id/unarchive`, `/memory/:id/tags`, `/correct`, `/feedback`, `/feedback/stats`, `/memory-health`, `/list`, `/duplicates`, `/deduplicate`, `/backfill`

**search** — Hybrid search with mode presets, cross-encoder reranking, temporal sort, tag/episode filtering. Recall with 5-layer stacking (static + semantic + important + recent + tags). 4 routes.
- Routes: `/search`, `/recall`, `/decay/refresh`, `/decay/scores`

**episodes** — Episode lifecycle: create, list, fetch, update, finalize with LLM summary. Auto-creation triggered by memory store. 6 routes.
- Routes: `/episodes`, `/episodes/:id`, `/episodes/:id/memories/:mid`, `/episodes/:id/finalize`

### Wave 2: Knowledge (depends on Wave 1)

**graph** — Knowledge graph: BFS traversal, batch link fetching, node sizing, response caching. Entity CRUD, relationships, cooccurrence, scoped search. Facts listing. 15 routes.
- Routes: `/graph`, `/graph/raw`, `/graph/view`, `/entities`, `/entities/:id`, `/entities/:id/memories/:mid`, `/entities/:id/relationships`, `/entities/:id/search`, `/entities/:id/cooccurrences`, `/facts`

**projects** — Project CRUD with memory linking and scoped search. 7 routes.
- Routes: `/projects`, `/projects/:id`, `/projects/:id/memories/:mid`, `/projects/:id/search`

**intelligence** — Reflection generation, contradiction detection/resolution, time travel (version history), consolidation (cluster + summarize + archive). 8 routes.
- Routes: `/reflect`, `/reflections`, `/contradictions`, `/contradictions/resolve`, `/timetravel`, `/consolidate`, `/consolidations`, `/digests`

**tier4** — Causal inference, reconsolidation, predictive modeling, valence scoring. Already well-isolated in `src/tier4/`. Needs routes extracted. 0 routes currently exposed (called internally).

### Wave 3: Integration (depends on Waves 1+2)

**context** — Progressive disclosure context assembly. Multi-phase token budget management, 8-layer disclosure (static, recent, episodes, linked, inference), dedup via cosine similarity, sentence boundary truncation. 1 route but 150+ lines of algorithmic logic.
- Routes: `/context`

**pack** — Token budget packing. Greedy knapsack selection with format switching (text/json/xml). 1 route.
- Routes: `/pack`

**conversations** — Conversation sessions, message CRUD, bulk insert, upsert dedup, message search. 9 routes.
- Routes: `/conversations`, `/conversations/:id`, `/conversations/:id/messages`, `/conversations/bulk`, `/conversations/upsert`, `/messages/search`

**ingestion** — Already extracted in v5.12.0. Wire its routes into the new router. 7 routes.
- Routes: `/ingest`, `/import/bulk`, `/import/mem0`, `/import/supermemory`, `/import/json`, `/derive`, `/add`

### Wave 4: Platform (mostly independent)

**auth** — Authentication, API key management, spaces, bootstrap, user CRUD. MFA, rate limiting, lockout tracking. 9 routes.
- Routes: `/gui/auth`, `/gui/logout`, `/bootstrap`, `/users`, `/keys`, `/keys/:id`, `/keys/rotate`, `/spaces`

**admin** — Maintenance operations: reembed, backfill facts, rebuild cooccurrences, detect communities, rebuild FTS, compact, GC, schema check, cold storage, scale report, SLA metrics. 20+ routes.
- Routes: `/admin/*`, `/export`, `/import`, `/reset`, `/checkpoint`, `/backup`, `/tenants/*`

**fsrs** — Spaced repetition: FSRS review, state, initialization. Already mostly in `src/fsrs/`. Needs routes extracted. 3 routes.
- Routes: `/fsrs/review`, `/fsrs/state`, `/fsrs/init`

**webhooks** — Webhook subscriptions and sync protocol (change polling, conflict resolution). 5 routes.
- Routes: `/webhooks`, `/webhooks/:id`, `/sync/changes`, `/sync/receive`

**agents** — Agent registration, passport generation, execution tracking, credential verification. 8 routes.
- Routes: `/agents`, `/agents/:id`, `/agents/:agent/passport`, `/agents/:agent/link-key`, `/agents/:id/executions`, `/agents/:id/revoke`, `/verify`

**scratch** — Working memory scratch pad with TTL, promotion to permanent memory, LLM summarization. 6 routes.
- Routes: `/scratch`, `/scratch/:session/:key`, `/scratch/:session`, `/scratch/:session/promote`, `/scratch/:session/summarize`

**skills** — Skill registry, search, upload, execution, auto-fix. 7 routes.
- Routes: `/skills`, `/skills/sync`, `/skills/search`, `/skills/upload`, `/skills/execute`, `/skills/:name`, `/skills/:name/fix`

**inbox** — Pending memory moderation: list, approve, reject, edit, bulk operations. 5 routes.
- Routes: `/inbox`, `/inbox/:id/approve`, `/inbox/:id/reject`, `/inbox/:id/edit`, `/inbox/bulk`

**health** — Health checks, readiness, metrics, OpenAPI, audit log. 7 routes.
- Routes: `/health`, `/live`, `/ready`, `/metrics`, `/openapi.json`, `/api/examples`, `/audit`

**prompts** — System prompt templates and task header generation. 2 routes.
- Routes: `/prompt`, `/header`

**guard** — Content moderation and credential verification. 2 routes.
- Routes: `/guard`, `/verify`

**docs** — Documentation resolution, error reporting with auto-fix suggestions. 3 routes.
- Routes: `/docs/resolve`, `/errors`

## Extraction Waves

### Foundation (sequential, no parallelism)

1. `src/db/connection.ts` — Extract connection setup from `src/db/index.ts`
2. `src/router/index.ts` — Build lightweight router
3. `src/middleware/auth.ts` — Extract auth/scope guards
4. `src/middleware/validate.ts` — Extract request validation
5. `src/middleware/audit.ts` — Extract audit logging
6. New `server.ts` entry point wiring router + middleware + domain mounting

### Wave 1: Core (parallel extraction, 3 subagents)

- **memory** — Largest domain. Store pipeline, CRUD, health diagnostics.
- **search** — Hybrid search, recall layering, decay scoring.
- **episodes** — Episode lifecycle, auto-creation, finalization.

### Wave 2: Knowledge (parallel extraction, 4 subagents)

- **graph** — BFS, entities, relationships, cooccurrence, facts.
- **projects** — Project CRUD with scoped search.
- **intelligence** — Reflections, contradictions, consolidation, digests.
- **tier4** — Wire existing `src/tier4/` into routes.

### Wave 3: Integration (parallel extraction, 3 subagents)

- **context** — Progressive disclosure context assembly.
- **pack** — Token budget packing algorithm.
- **conversations** — Conversation/message CRUD and search.
- **ingestion** — Wire existing `src/ingestion/` into new router.

### Wave 4: Platform (parallel extraction, batches of 4-5 subagents)

All remaining domains. Mostly simple CRUD. Two batches:
- Batch A: auth, admin, fsrs, webhooks, agents
- Batch B: scratch, skills, inbox, health, prompts, guard, docs

## Testing Strategy

Each domain extraction includes unit tests for the extracted business logic:

- **Unit tests** per domain: test business logic in `index.ts` without HTTP. Mock the `db` object. Assert on function inputs/outputs.
- **Route tests** per domain: test route handlers with mock request/response. Verify parsing, validation, error handling.
- **Existing integration test** (`api.test.mjs`): runs against the full server. Kept as a smoke test throughout. Must pass after every wave.

Tests use `node:test` with `node:assert/strict` (same as ingestion tests). No test framework dependencies.

## Staging on Rocky

The refactored codebase is built and tested on Rocky (100.64.0.2).

- Rocky already runs a mirror copy of production Engram
- Copy Rocky's existing Engram database to the staging instance
- Staging runs on a separate port (4202) to avoid conflicts
- Verification: run full test suite against staging, then compare key query results (search, recall, context) between the mirror and the refactored instance using the same database
- Real data proves correctness. Synthetic test data only proves the code runs.

## Production Swap

Once staging passes all tests and manual verification:

1. Stop production Engram on hetzner-zan
2. Deploy refactored codebase
3. Start with production database (no migration needed, schema unchanged)
4. Verify health endpoint, run integration tests against production
5. Monitor for 24 hours

Rollback: keep the old `server-split.ts` and monolith files in the repo. If something breaks, revert the entry point and restart.

## Out of Scope

- Hono framework migration (separate future project after decomposition is stable)
- Database schema changes (schema stays identical, only query locations move)
- New features (pure refactoring, no behavior changes)
- UI/GUI changes
- Production deployment (staging only until manual approval)
