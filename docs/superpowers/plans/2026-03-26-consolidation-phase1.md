# Phase 1: Syntheos Service Consolidation into Engram

> **Spec:** `docs/superpowers/specs/2026-03-26-service-consolidation-design.md`
> **Branch:** `feat/consolidation-phase1`
> **Worktree:** `C:/Users/Zan/Projects/engram/.worktrees/feat-consolidation-p1`
> **Scope:** Absorb Thymus (620 LOC), Soma (588 LOC), Chiasm (~800 LOC) into Engram
> **Status:** Planning

---

## Architecture Decisions

### AD-1: Soma table naming
Engram has an existing `agents` table (v5.8 Agent Identity/Trust at db/index.ts:342) for signing/trust. Soma has an `agents` table for registry/heartbeat/capabilities. **Decision:** Prefix Soma tables with `soma_` to avoid collision.

### AD-2: Chiasm auth adaptation
Chiasm has its own `agent_keys` table. **Decision:** Drop it. Use Engram's auth. The per-agent enforcement from Chiasm is relaxed; any authenticated Engram user can manage tasks.

### AD-3: Chiasm schema uses actual v0.2
The spec has a simplified schema, but actual Chiasm has 4 tables with guardrails, path claims, dependencies, heartbeats, work queue. **Decision:** Port actual schema. Prefix with `chiasm_`.

### AD-4: Tracing
Chiasm uses OpenTelemetry. **Decision:** Drop OTel. Use Engram's JSON logger.

### AD-5: Route prefixes
- Thymus: `/thymus/*` (avoid collision with existing routes)
- Soma: `/soma/*` (avoid collision with existing `agents` routes)
- Chiasm: `/tasks/*`, `/feed`, `/claims/*`, `/queue/*` (no collisions)

### AD-6: Axon stub
Single `axon-stub.ts` with `publish()` that logs at debug level. Phase 2 replaces with real bus.

### AD-7: Schema version
Use version 100 for Phase 1 consolidation (clear boundary from existing v60).

### AD-8: DB module organization
Separate db.ts per service under `src/services/{service}/db.ts`. Migrations run at module scope so prepared statements compile safely.

### AD-9: Shared helpers
Extract identical `parseJsonFields`/`parseJsonFieldsAll`/`bounded` into `src/services/helpers.ts`.

---

## Task Breakdown

See the full task details below. Each task includes exact file paths, complete code, and commit instructions.

### Task 1: Shared types, helpers, axon stub
### Task 2: Thymus DB + business logic
### Task 3: Thymus routes
### Task 4: Soma DB + business logic
### Task 5: Soma routes
### Task 6: Chiasm DB + engine
### Task 7: Chiasm routes
### Task 8: Service barrel + fetchHandler wiring
### Task 9: MCP tools
### Task 10: Data migration scripts
### Task 11: Integration tests

---

## Critical Implementation Notes

### Prepared Statement Timing Fix
Migrations MUST run at module scope (when db.ts is imported), NOT deferred to `initServices()`. This ensures tables exist before prepared statements are compiled. Pattern:

```
// db.ts for each service:
migrate(`CREATE TABLE IF NOT EXISTS ...`);  // module scope
export const insertXxx = db.prepare("...");  // safe: table exists
```

### `deleteSomaAgentLogs` Table Reference
Must reference `soma_agent_logs`, not `agent_logs` (the standalone table name).

### Chiasm Auth Relaxation
Standalone Chiasm enforced per-agent ownership via `canActOnAgent`. The consolidated version trusts Engram's auth but does NOT enforce agent-level ownership. Any authenticated user can CRUD any task. This is acceptable for Phase 1 since all agents share the same API key.

### New Tables for `getExpectedTables()`
Must add all 11 new tables to the expected tables list in db/index.ts to prevent schema drift alerts.
