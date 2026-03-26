# Syntheos Service Consolidation into Engram

**Goal:** Absorb all 6 standalone Syntheos Agent OS services (Thymus, Soma, Chiasm, Axon, Broca, Loom) into Engram as native modules, eliminating 6 separate processes, 6 separate databases, and 6 separate auth configurations.

**Approach:** Phased absorption. Each phase adds new tables to Engram's libsql database, new route modules under `src/services/`, and new prepared statements. Each phase is independently deployable and testable. After each phase, the standalone service is decommissioned.

**Tech Stack:** TypeScript + libsql (existing Engram stack), raw Node.js HTTP (existing pattern), ONNX embeddings (existing), `callLLM` (existing for Broca narrator/ask).

---

## Current State

| Service | Port | LOC | Tables | Purpose | Status |
|---------|------|-----|--------|---------|--------|
| Thymus | 4900 | 620 | 3 | Quality scoring, rubric evaluations, metrics | v0.1.0 |
| Soma | 4800 | 588 | 4 | Agent registry, heartbeat, capabilities, groups | v0.1.0 |
| Chiasm | 4300 | ~800 | 2 | Agent task tracking, events | v0.2.0 (mature) |
| Axon | 4600 | 554 | 3 | Event bus, pub/sub, SSE streaming, webhooks | v0.1.0 |
| Broca | 5000 | 1,467 | 1 | Action log, NL narrator, /ask query gateway | v0.1.0 |
| Loom | 4700 | 640 | 4 | Workflow orchestration, step executors | v0.1.0 |

All services share: Node 22+ with `--experimental-strip-types`, libsql/WAL, raw `node:http`, Bearer token auth, fire-and-forget Axon integration, ~64KB body limits.

**Total: ~4,669 LOC across 6 services, 17 tables, 6 ports, 6 databases.**

---

## Target Architecture

All services become modules inside Engram. One process, one database, one auth layer, one port.

### File Structure

```
src/
  services/
    thymus/
      routes.ts         # /thymus/* HTTP handlers
      scoring.ts        # weighted normalized scoring algorithm
    soma/
      routes.ts         # /agents/*, /groups/* HTTP handlers
      registry.ts       # agent CRUD, heartbeat, capability search, groups
    chiasm/
      routes.ts         # /tasks/* HTTP handlers
      engine.ts         # task state machine, event logging
    axon/
      routes.ts         # /events/*, /channels/*, /stream/* HTTP handlers
      bus.ts            # publish(), subscribe(), SSE streaming, webhook fan-out
    broca/
      routes.ts         # /actions/*, /feed, /ask HTTP handlers
      narrator.ts       # template registry (30+ event types) + LLM fallback
      ask.ts            # NL query router, SERVICE_CATALOG, plan+execute+narrate
    loom/
      routes.ts         # /workflows/*, /runs/*, /steps/* HTTP handlers
      engine.ts         # state machine, advanceRun, step executors
    index.ts            # barrel: wires all service routes into Engram's fetchHandler
```

### Route Mapping

| Service | Prefix | Key endpoints |
|---------|--------|---------------|
| Thymus | `/thymus/` | `POST /thymus/evaluate`, `GET /thymus/rubrics`, `GET /thymus/agents/:name/scores`, `POST /thymus/metrics`, `GET /thymus/metrics/summary` |
| Soma | `/agents/`, `/groups/` | `POST /agents`, `GET /agents`, `POST /agents/:id/heartbeat`, `GET /agents/stale`, `GET /agents/capability/:name`, `POST /agents/:id/logs` |
| Chiasm | `/tasks/` | `POST /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id`, `GET /feed` |
| Axon | `/events/` | `POST /events/publish`, `GET /events/stream` (SSE), `POST /events/subscribe`, `GET /events/poll` |
| Broca | `/actions/` | `POST /actions`, `GET /actions`, `GET /actions/feed`, `POST /ask` |
| Loom | `/workflows/`, `/runs/` | `POST /workflows`, `POST /runs`, `GET /runs/:id/steps`, `POST /steps/:id/complete`, `POST /steps/:id/fail` |

All routes go through Engram's existing auth middleware. Each service's standalone API key is replaced by Engram's unified auth.

### Database Schema

17 new tables added to Engram's libsql database via `migrate()`:

**Phase 1 tables:**

```sql
-- Thymus
rubrics (id INTEGER PK, name TEXT UNIQUE, description TEXT, criteria TEXT, created_at, updated_at)
evaluations (id INTEGER PK, rubric_id FK, agent TEXT, subject TEXT, input TEXT, output TEXT, scores TEXT, overall_score REAL, notes TEXT, evaluator TEXT, created_at)
quality_metrics (id INTEGER PK, agent TEXT, metric TEXT, value REAL, tags TEXT, recorded_at)

-- Soma
agents (id INTEGER PK, name TEXT UNIQUE, type TEXT, description TEXT, capabilities TEXT, status TEXT, config TEXT, heartbeat_at TEXT, created_at, updated_at)
agent_groups (agent_id FK, group_id FK, PRIMARY KEY)
groups (id INTEGER PK, name TEXT UNIQUE, description TEXT, created_at)
agent_logs (id INTEGER PK, agent_id FK, level TEXT, message TEXT, data TEXT, created_at)

-- Chiasm (schema from existing Chiasm v0.2)
tasks (id INTEGER PK, agent TEXT, project TEXT, title TEXT, description TEXT, status TEXT, summary TEXT, metadata TEXT, created_at, updated_at)
task_events (id INTEGER PK, task_id FK, type TEXT, data TEXT, created_at)
```

**Phase 2 tables:**

```sql
-- Axon
events (id INTEGER PK, channel TEXT, source TEXT, type TEXT, payload TEXT, created_at)
channels (name TEXT PK, description TEXT, created_at)
subscriptions (id INTEGER PK, channel TEXT, url TEXT, secret TEXT, active INTEGER, created_at)

-- Broca
actions (id INTEGER PK, agent TEXT, service TEXT, action TEXT, payload TEXT, narrative TEXT, axon_event_id INTEGER, created_at)
```

**Phase 3 tables:**

```sql
-- Loom
workflows (id INTEGER PK, name TEXT UNIQUE, description TEXT, steps TEXT, created_at, updated_at)
workflow_runs (id INTEGER PK, workflow_id FK, status TEXT, input TEXT, output TEXT, error TEXT, started_at, completed_at, created_at, updated_at)
workflow_steps (id INTEGER PK, run_id FK, name TEXT, type TEXT, config TEXT, status TEXT, input TEXT, output TEXT, error TEXT, depends_on TEXT, retry_count INTEGER, max_retries INTEGER, timeout_ms INTEGER, started_at, completed_at, created_at)
run_logs (id INTEGER PK, run_id FK, step_id FK, level TEXT, message TEXT, data TEXT, created_at)
```

### Internal Event Bus

Once Axon is absorbed (Phase 2), all internal service communication switches from HTTP fetch to direct function calls:

```typescript
// src/services/axon/bus.ts
export function publish(channel: string, source: string, type: string, payload: any): void
export function subscribe(channel: string, callback: (event: any) => void): () => void
```

- Internal producers (Thymus, Soma, Broca, Loom) call `publish()` directly
- External consumers still get SSE streaming via `GET /events/stream` and webhook fan-out
- Broca's narrator subscribes internally to auto-narrate events

### Broca /ask Internalization

Once all services are co-located, Broca's `/ask` NL query gateway becomes dramatically more powerful:

- The `SERVICE_CATALOG` references internal functions instead of HTTP URLs
- `executeplan()` calls Engram's own route handlers or DB queries directly
- No network latency, no auth overhead, no timeout concerns
- The catalog auto-updates as services are absorbed (no hardcoded URL maintenance)

---

## Phasing Plan

### Phase 1: Foundation (Thymus + Soma + Chiasm)

**What:** 3 simplest services. Pure CRUD + scoring. ~2,008 LOC. 9 tables.

**Why first:** Agent identity (Soma) and task tracking (Chiasm) are foundational. Quality scoring (Thymus) is self-contained. All three have zero cross-service dependencies (only Axon fire-and-forget which can be stubbed).

**Migration:**
1. Add 9 tables to Engram via `migrate()` (schema version v7.0)
2. Port route handlers into `src/services/{thymus,soma,chiasm}/`
3. Wire routes into `src/services/index.ts` and Engram's `fetchHandler`
4. One-time data migration script: copy rows from standalone `.db` files
5. Add MCP tools: `thymus_evaluate`, `task_create`, `task_update`, `agent_register`, `agent_heartbeat`
6. Decommission 3 systemd services on zan-hetzner
7. Update all agent configs to point at Engram instead of standalone services

**Axon stub:** Until Phase 2, internal events are logged but not published. Services that previously called Axon will call a no-op `publish()` stub.

### Phase 2: Event Infrastructure (Axon + Broca)

**What:** Event bus internalization + action log/narrator. ~2,021 LOC. 4 tables.

**Why second:** Axon must be absorbed before Broca since Broca subscribes to Axon events. Once Axon is internal, all Phase 1 services retroactively gain real event emission.

**Migration:**
1. Add 4 tables (schema version v8.0)
2. Port Axon's pub/sub engine, SSE streaming, webhook fan-out into `src/services/axon/bus.ts`
3. Replace no-op `publish()` stub with real implementation
4. Port Broca's narrator templates, LLM fallback, and `/ask` pipeline
5. Wire Broca's narrator as an internal Axon subscriber
6. Add MCP tools: `ask`, `action_log`, `event_publish`
7. Decommission 2 systemd services

**Key integration:** Broca's `/ask` SERVICE_CATALOG is rewritten to call internal functions instead of HTTP endpoints.

### Phase 3: Orchestration (Loom)

**What:** Workflow engine with async step executors. 640 LOC. 4 tables.

**Why last:** Most complex state machine. Benefits from all other services being internal (step executors can call Engram APIs directly). Loom's webhook/LLM step executors reuse Engram's existing `callLLM()`.

**Migration:**
1. Add 4 tables (schema version v9.0)
2. Port engine: `createWorkflow`, `createRun`, `advanceRun`, step executors
3. Fix stuck-run problem: add recovery sweep on startup for steps left in `running` state
4. Wire step executors to use internal `callLLM()` and `publish()` instead of HTTP
5. Add MCP tools: `workflow_create`, `workflow_run`, `workflow_status`
6. Decommission last systemd service

---

## Agent-Forge: Native Skills

Agent-forge's 27 MCP tools become SKILL.md files in Engram's skill directory, searchable via hybrid FTS5+vector search. The MCP server continues running for backward compatibility.

| Skill file | Tools covered |
|------------|---------------|
| `planning-protocol/SKILL.md` | `spec_task`, `declare_unknowns`, `consider_approaches` |
| `debugging-protocol/SKILL.md` | `log_hypothesis`, `recall_errors`, `log_outcome` |
| `code-safety-protocol/SKILL.md` | `dep_risk`, `check_breakage`, `challenge_code` |
| `session-management/SKILL.md` | `checkpoint`, `rollback`, `session_learn`, `session_recall`, `session_diff` |
| `verification-protocol/SKILL.md` | `verify`, `test_impact` |
| `code-navigation/SKILL.md` | `repo_map`, `search_code`, `ast_search` |
| `reasoning-protocol/SKILL.md` | `think`, `prose_analyze`, `prose_learn` |

---

## Decommission Schedule

| Phase | Services killed | Ports freed | DBs retired |
|-------|----------------|-------------|-------------|
| 1 | thymus.service, soma.service, chiasm.service | 4900, 4800, 4300 | thymus.db, soma.db, chiasm.db |
| 2 | axon.service, broca.service | 4600, 5000 | axon.db, broca.db |
| 3 | loom.service | 4700 | loom.db |

**After all phases:** Engram is the single service. One port (4200), one database, one auth layer.

---

## Data Migration Strategy

Each phase includes a one-time migration script:

```bash
# Example for Phase 1
node --experimental-strip-types scripts/migrate-thymus.ts --source /path/to/thymus.db
node --experimental-strip-types scripts/migrate-soma.ts --source /path/to/soma.db
node --experimental-strip-types scripts/migrate-chiasm.ts --source /path/to/chiasm.db
```

Each script:
1. Opens the source DB read-only
2. Reads all rows from each table
3. Inserts into Engram's unified DB using prepared statements
4. Reports row counts and any skipped/errored rows
5. Does NOT delete the source DB (kept as backup)

---

## Risk Mitigation

- **Each phase is independently reversible.** If Phase 2 fails, Phase 1 services continue working inside Engram while Axon/Broca stay standalone.
- **Pre-migration backup.** Engram's auto-backup runs before each schema migration.
- **Existing corruption hardening.** The DB corruption fixes (NaN validation, transaction wrapping, PASSIVE checkpoints, integrity checks) apply to all new tables automatically.
- **No big bang.** Agent configs are updated per-phase. No single moment where everything changes at once.

---

## Success Criteria

- All 6 services absorbed, all standalone processes stopped
- Zero data loss during migration
- All existing API consumers work without changes (same endpoints, same auth via Engram)
- MCP tools available for all absorbed services
- Broca `/ask` works against internal services with no HTTP round-trips
- Internal event bus replaces all fire-and-forget HTTP calls
- Agent-forge tools available as searchable native skills
