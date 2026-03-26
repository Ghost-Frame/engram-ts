# Engram Hardening & Commercial Readiness Plan

**Date:** 2026-03-21
**Version:** 5.8.3
**Author:** Quantum (audit agent)

This document is a step-by-step implementation plan for an AI coding agent (Sonnet).
Each task includes exact file paths, line numbers, function names, existing patterns to follow,
and acceptance criteria. Do NOT deviate from the patterns already in the codebase.
Do NOT add dependencies. Do NOT refactor unrelated code. Do NOT create new files unless
explicitly instructed. Do NOT add comments explaining what you changed. Do NOT use em dashes
anywhere.

---

## TABLE OF CONTENTS

- [PHASE 1: Security Fixes](#phase-1-security-fixes)
  - [1.1 Tighten OPEN_ACCESS Posture](#11-tighten-open_access-posture)
  - [1.2 Durable Rate Limiting](#12-durable-rate-limiting)
  - [1.3 Multi-Tenant Boundary Hardening](#13-multi-tenant-boundary-hardening)
  - [1.4 Auth & Session Hardening](#14-auth--session-hardening)
- [PHASE 2: Reliability Fixes](#phase-2-reliability-fixes)
  - [2.1 SQLite Lock Handling](#21-sqlite-lock-handling)
  - [2.2 Queue Failure Visibility](#22-queue-failure-visibility)
  - [2.3 Backup Discipline](#23-backup-discipline)
- [PHASE 3: Observability](#phase-3-observability)
  - [3.1 /metrics Endpoint](#31-metrics-endpoint)
  - [3.2 Structured Tracing Hooks](#32-structured-tracing-hooks)
- [PHASE 4: Commercial Multi-Tenant](#phase-4-commercial-multi-tenant)
  - [4.1 Tenant Lifecycle](#41-tenant-lifecycle)
  - [4.2 Quotas & Limits](#42-quotas--limits)
  - [4.3 Tenant Admin Tooling](#43-tenant-admin-tooling)
- [PHASE 5: Data Portability](#phase-5-data-portability)
  - [5.1 Export API](#51-export-api)
  - [5.2 Import API Improvements](#52-import-api-improvements)
- [PHASE 6: Migration Tooling](#phase-6-migration-tooling)
  - [6.1 Schema Drift Detection](#61-schema-drift-detection)
  - [6.2 Migration Preflight & Rollback](#62-migration-preflight--rollback)
- [PHASE 7: API Product Surface](#phase-7-api-product-surface)
  - [7.1 Pagination Consistency](#71-pagination-consistency)
  - [7.2 Stable Response Schemas](#72-stable-response-schemas)
- [PHASE 8: Scale Strategy](#phase-8-scale-strategy)
  - [8.1 Performance Guardrails](#81-performance-guardrails)
  - [8.2 Tiered Vector Search](#82-tiered-vector-search)
  - [8.3 Memory Archival & Cold Storage](#83-memory-archival--cold-storage)
  - [8.4 Search Index Partitioning](#84-search-index-partitioning)
- [PHASE 9: OpenAPI Spec & SDK Surface](#phase-9-openapi-spec--sdk-surface)
  - [9.1 OpenAPI Spec Generation](#91-openapi-spec-generation)
  - [9.2 SDK Example Responses](#92-sdk-example-responses)
- [PHASE 10: Admin Maintenance Tooling](#phase-10-admin-maintenance-tooling)
  - [10.1 Maintenance Mode](#101-maintenance-mode)
  - [10.2 Rebuild & Reindex Commands](#102-rebuild--reindex-commands)
  - [10.3 Garbage Collection](#103-garbage-collection)
- [PHASE 11: Commercial Product Path](#phase-11-commercial-product-path)
  - [11.1 Usage Metering](#111-usage-metering)
  - [11.2 Tenant Onboarding Flow](#112-tenant-onboarding-flow)
  - [11.3 SLA Monitoring](#113-sla-monitoring)

---

## PHASE 1: Security Fixes

### 1.1 Tighten OPEN_ACCESS Posture

**Problem:** When `ENGRAM_OPEN_ACCESS=1`, all requests get `user_id: 1` with `read,write` scopes.
There is no way to restrict which endpoints are available in open access mode. Mutation endpoints
(store, delete, correct, forget, reset) are all accessible. This is too permissive for any
deployment exposed to the internet.

**Files to modify:**
- `src/config/index.ts` (add new config)
- `src/routes/index.ts` (add endpoint filtering)

**Task 1.1.1: Add OPEN_ACCESS_SCOPES config**

In `src/config/index.ts`, after line 122 (`OPEN_ACCESS_RATE_LIMIT`), add:

```typescript
export const OPEN_ACCESS_SCOPES = (process.env.ENGRAM_OPEN_ACCESS_SCOPES || "read").split(",").map(s => s.trim()).filter(Boolean);
```

This defaults open access to read-only. Operators can opt into `read,write` explicitly.

**Task 1.1.2: Use OPEN_ACCESS_SCOPES in auth fallback**

In `src/auth/index.ts`, line 107, change the OPEN_ACCESS return to:

```typescript
// BEFORE (line 107):
return { user_id: 1, space_id: null, key_id: null, agent_id: null, scopes: ["read", "write"], is_admin: false };

// AFTER:
import { OPEN_ACCESS_SCOPES } from "../config/index.ts";
// ... then in the return:
return { user_id: 1, space_id: null, key_id: null, agent_id: null, scopes: OPEN_ACCESS_SCOPES, is_admin: false };
```

Add the import at the top of the file (line 7). The existing import line is:
```typescript
import { RATE_WINDOW_MS, OPEN_ACCESS } from "../config/index.ts";
```
Change it to:
```typescript
import { RATE_WINDOW_MS, OPEN_ACCESS, OPEN_ACCESS_SCOPES } from "../config/index.ts";
```

**Task 1.1.3: Block dangerous endpoints in OPEN_ACCESS**

In `src/routes/index.ts`, add a blocklist check right after the IP rate limit check (around line 199).
Find the line that says:
```typescript
setInterval(() => {
```
(line 200). BEFORE that setInterval, after the `checkIpRateLimit` function definition (line 199),
add a new function:

```typescript
const OPEN_ACCESS_BLOCKED_PATHS = new Set([
  "/reset", "/bootstrap", "/admin/reembed", "/admin/rebuild-cooccurrences",
  "/admin/detect-communities", "/admin/backfill-facts",
  "/users", "/keys", "/backup",
]);

function isBlockedInOpenAccess(path: string, method: string): boolean {
  if (!OPEN_ACCESS) return false;
  if (OPEN_ACCESS_BLOCKED_PATHS.has(path)) return true;
  // Block all /admin/* paths
  if (path.startsWith("/admin/")) return true;
  return false;
}
```

Then in the main fetchHandler, after the auth resolution (around line 530 where `maybeAuth` is
checked), add this check. Find the block that starts with:
```typescript
if (!maybeAuth && url.pathname !== "/health") {
```
Right BEFORE that block, add:
```typescript
if (isBlockedInOpenAccess(url.pathname, method)) {
  return errorResponse("Endpoint not available in open access mode", 403, requestId);
}
```

**Acceptance criteria:**
- `ENGRAM_OPEN_ACCESS=1` with no other config gives read-only access
- `ENGRAM_OPEN_ACCESS=1 ENGRAM_OPEN_ACCESS_SCOPES=read,write` restores current behavior
- Admin endpoints always blocked in open access regardless of scope config
- All existing tests pass

---

### 1.2 Durable Rate Limiting

**Problem:** Rate limiting is in-memory only (`rateLimitMap` in auth/index.ts line 24, `ipRateLimits`
in routes/index.ts line 185). Server restart resets all counters. A determined attacker can just
wait for a restart or trigger one. Also, there are no per-endpoint rate limits.

**Files to modify:**
- `src/db/index.ts` (add rate_limits table)
- `src/auth/index.ts` (switch to DB-backed limits)
- `src/routes/index.ts` (switch IP limiter to DB-backed)

**Task 1.2.1: Add rate_limits table**

In `src/db/index.ts`, find the migrations section (search for `migrate(` calls). Add after the
last migration:

```typescript
migrate(`
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL DEFAULT (datetime('now')),
    window_seconds INTEGER NOT NULL DEFAULT 60
  );
  CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
`);
```

Then add prepared statements near the other prepared statements (search for `export const` blocks
of prepared statements):

```typescript
export const upsertRateLimit = db.prepare(`
  INSERT INTO rate_limits (key, count, window_start, window_seconds)
  VALUES (?, 1, datetime('now'), ?)
  ON CONFLICT(key) DO UPDATE SET
    count = CASE
      WHEN datetime(rate_limits.window_start, '+' || rate_limits.window_seconds || ' seconds') < datetime('now')
      THEN 1
      ELSE rate_limits.count + 1
    END,
    window_start = CASE
      WHEN datetime(rate_limits.window_start, '+' || rate_limits.window_seconds || ' seconds') < datetime('now')
      THEN datetime('now')
      ELSE rate_limits.window_start
    END
  RETURNING count, window_start, window_seconds
`);

export const cleanupRateLimits = db.prepare(`
  DELETE FROM rate_limits
  WHERE datetime(window_start, '+' || (window_seconds * 2) || ' seconds') < datetime('now')
`);
```

**Task 1.2.2: Hybrid rate limiter (memory + DB)**

Keep the in-memory map as a fast path (hot path optimization), but persist to DB on every Nth
request and on shutdown. This avoids a DB write on every single request while still surviving
restarts.

In `src/auth/index.ts`, replace the rate limit check (lines 45-53) with:

```typescript
// Rate limiting -- hybrid: in-memory fast path + DB persistence
const now = Date.now();
let rl = rateLimitMap.get(row.id);
if (!rl || now > rl.reset) {
  // Check DB for surviving state from previous process
  const dbRl = upsertRateLimit.get(`key:${row.id}`, Math.ceil(RATE_WINDOW_MS / 1000)) as any;
  if (dbRl && dbRl.count > 1) {
    rl = { count: dbRl.count, reset: now + RATE_WINDOW_MS };
  } else {
    rl = { count: 0, reset: now + RATE_WINDOW_MS };
  }
  rateLimitMap.set(row.id, rl);
}
rl.count++;
// Persist to DB every 10 requests to reduce write pressure
if (rl.count % 10 === 0) {
  try { upsertRateLimit.get(`key:${row.id}`, Math.ceil(RATE_WINDOW_MS / 1000)); } catch {}
}
if (rl.count > row.rate_limit) {
  return { error: "Rate limit exceeded", status: 429, headers: { "Retry-After": String(Math.ceil((rl.reset - now) / 1000)) } };
}
```

Add the import for `upsertRateLimit` from `../db/index.ts`.

**Task 1.2.3: Add per-endpoint rate limits for expensive operations**

In `src/routes/index.ts`, add a simple per-endpoint limiter after the `checkIpRateLimit` function:

```typescript
// Per-endpoint rate limits for expensive operations (per user_id, per minute)
const endpointLimits: Record<string, number> = {
  "/store": 60,
  "/search": 120,
  "/recall": 120,
  "/context": 60,
  "/ingest": 20,
  "/add": 30,
  "/admin/reembed": 1,
  "/backup": 5,
  "/reset": 1,
  "/bootstrap": 3,
  "/consolidate": 5,
  "/reflect": 10,
};

const endpointRateLimits = new Map<string, { count: number; reset: number }>();

function checkEndpointRateLimit(path: string, userId: number): { allowed: boolean; retryAfter?: number } {
  const limit = endpointLimits[path];
  if (!limit) return { allowed: true };
  const key = `${userId}:${path}`;
  const now = Date.now();
  let rl = endpointRateLimits.get(key);
  if (!rl || now > rl.reset) {
    rl = { count: 0, reset: now + 60_000 };
    endpointRateLimits.set(key, rl);
  }
  rl.count++;
  if (rl.count > limit) {
    return { allowed: false, retryAfter: Math.ceil((rl.reset - now) / 1000) };
  }
  return { allowed: true };
}

// Cleanup stale endpoint rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, rl] of endpointRateLimits) {
    if (now > rl.reset) endpointRateLimits.delete(k);
  }
}, 5 * 60 * 1000);
```

Then in the main request handler, after auth is resolved and before the route matching begins,
add the check. Find the section after `const auth = ...` is finalized (where routes start
matching, around line 540+). Add:

```typescript
const epLimit = checkEndpointRateLimit(url.pathname, auth.user_id);
if (!epLimit.allowed) {
  return json({ error: "Endpoint rate limit exceeded", retry_after: epLimit.retryAfter }, 429, {
    "Retry-After": String(epLimit.retryAfter),
    "X-Request-Id": requestId,
  });
}
```

**Task 1.2.4: Rate limit cleanup on interval**

In `src/db/index.ts`, export `cleanupRateLimits`. Then in `server-split.ts`, add to the hourly
job cleanup interval (search for `cleanupCompletedJobs` -- it runs in a setInterval). Add
`cleanupRateLimits.run()` in the same interval callback.

**Acceptance criteria:**
- Rate limits survive server restarts (DB-backed)
- Per-endpoint limits prevent abuse of expensive operations
- No measurable latency impact on normal request flow (in-memory fast path)
- Stale rate limit entries cleaned up automatically

---

### 1.3 Multi-Tenant Boundary Hardening

**Problem:** Tenant isolation relies on `WHERE user_id = ?` in queries. This is good but there
are edge cases that need hardening:
1. Memory links could theoretically reference memories across users if created via admin
2. Bulk operations (conversations/bulk) don't verify each message belongs to the user
3. The embedding cache serves all users from a single array with runtime filtering, which
   means a bug in the filter could leak data

**Files to modify:**
- `src/db/index.ts` (add cross-tenant FK checks)
- `src/routes/index.ts` (add ownership assertions)

**Task 1.3.1: Add DB-level cross-tenant link prevention trigger**

In `src/db/index.ts`, after the memory_links table creation, add a trigger:

```typescript
migrate(`
  CREATE TRIGGER IF NOT EXISTS prevent_cross_tenant_links
  BEFORE INSERT ON memory_links
  BEGIN
    SELECT CASE
      WHEN (SELECT user_id FROM memories WHERE id = NEW.source_id) !=
           (SELECT user_id FROM memories WHERE id = NEW.target_id)
      THEN RAISE(ABORT, 'Cross-tenant memory link rejected')
    END;
  END;
`);
```

**Task 1.3.2: Add ownership assertion helper**

In `src/routes/index.ts`, find the `canAccessOwnedRow` function (search for `canAccessOwnedRow`).
If it exists, verify it checks both `user_id` match and admin override. If it doesn't exist as
a named function, add one near the top of the route helpers section (around line 180):

```typescript
function assertOwnership(row: any, auth: AuthContext, label: string): Response | null {
  if (!row) return errorResponse("Not found", 404);
  if (row.user_id !== auth.user_id && !auth.is_admin) {
    log.warn({ msg: "ownership_violation", label, row_user: row.user_id, auth_user: auth.user_id });
    return errorResponse("Not found", 404); // 404 not 403 to avoid leaking existence
  }
  return null;
}
```

Then find all memory access points where ownership is checked inline (search for patterns like
`if (mem.user_id !== auth.user_id`) and replace them with `assertOwnership()` calls. This
centralizes the check and ensures the warning log fires on every violation.

**Task 1.3.3: Validate conversation bulk insert user isolation**

In `src/routes/index.ts`, find the `/conversations/bulk` handler (search for `"/conversations/bulk"`
or `"conversations/bulk"`). In the bulk insert, verify that the conversation being created is
assigned to `auth.user_id` and that `user_id` cannot be overridden from the request body.

Find the line where the conversation is inserted in the bulk handler. Ensure `user_id` is
always `auth.user_id`, not from the request body. It should look like:
```typescript
bulkInsertConvo(agent, sessionId, title, metadata, auth.user_id, msgs);
```
NOT:
```typescript
bulkInsertConvo(agent, sessionId, title, metadata, body.user_id || auth.user_id, msgs);
```

**Task 1.3.4: Add tenant isolation assertions to embedding cache**

In `src/embeddings/index.ts`, find the `getCachedEmbeddings` function. Add a hard assertion
that userId is always provided for non-admin callers:

```typescript
export function getCachedEmbeddings(latestOnly: boolean, userId?: number): CachedMem[] {
  // SECURITY: userId must always be provided in multi-tenant mode
  // Only omit for admin operations (reembed, etc.)
  const source = latestOnly ? embeddingCacheLatest : embeddingCache;
  if (userId != null) {
    return source.filter(m => m.user_id === userId);
  }
  return source;
}
```

Verify that every call to `getCachedEmbeddings` in `src/memory/search.ts` passes `userId`.
Search for all calls and confirm `userId` is always the second argument.

**Acceptance criteria:**
- SQLite trigger prevents cross-tenant memory links at the DB level
- All ownership checks go through a centralized function that logs violations
- Bulk inserts cannot override user_id from request body
- Embedding cache always filters by userId for non-admin paths

---

### 1.4 Auth & Session Hardening

**Problem:** Several auth gaps for commercial deployment:
1. API keys never expire (no `expires_at` column)
2. No key rotation mechanism (create new, migrate, revoke old)
3. GUI cookie has no CSRF protection beyond Content-Type check
4. No account lockout after repeated failed API key attempts
5. `last_used_at` updates on every request (write pressure)

**Files to modify:**
- `src/db/index.ts` (add expires_at column)
- `src/auth/index.ts` (add expiry check, batch last_used_at)

**Task 1.4.1: Add API key expiration**

In `src/db/index.ts`, add a migration:

```typescript
migrate(`ALTER TABLE api_keys ADD COLUMN expires_at TEXT`);
migrate(`CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at) WHERE expires_at IS NOT NULL`);
```

**Task 1.4.2: Check expiry during authentication**

In `src/auth/index.ts`, after the key lookup (line 38, after `if (!row) return null;`), add:

```typescript
// Check key expiration
if (row.expires_at) {
  const expiresAt = new Date(row.expires_at + "Z").getTime();
  if (Date.now() > expiresAt) {
    return { error: "API key expired", status: 401 };
  }
}
```

**Task 1.4.3: Batch last_used_at updates**

The current code (line 43) does a DB write on every authenticated request. Replace with a
batched approach:

```typescript
// REMOVE line 43:
// db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);

// REPLACE with batched updates:
const lastUsedBatch = new Set<number>();

// Add after the rate limit check (around line 53, before the return):
lastUsedBatch.add(row.id);

// Then add a flush function at module level:
const flushLastUsed = db.prepare(
  `UPDATE api_keys SET last_used_at = datetime('now') WHERE id IN (SELECT value FROM json_each(?))`
);

setInterval(() => {
  if (lastUsedBatch.size === 0) return;
  const ids = Array.from(lastUsedBatch);
  lastUsedBatch.clear();
  try { flushLastUsed.run(JSON.stringify(ids)); } catch {}
}, 30_000); // Flush every 30 seconds
```

**Task 1.4.4: Support expires_at in key creation**

In `src/routes/index.ts`, find the POST /keys handler (search for the key creation route).
Add `expires_at` as an optional body parameter:

```typescript
const expires_at = body.expires_at ? String(body.expires_at) : null;
```

And pass it to the INSERT statement. Find the existing INSERT INTO api_keys and add the
`expires_at` column. The prepared statement for key creation should become:

```sql
INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit, agent_id, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```

**Task 1.4.5: Add key rotation endpoint**

In `src/routes/index.ts`, add a new endpoint near the existing `/keys` routes:

```typescript
if (url.pathname === "/keys/rotate" && method === "POST") {
  if (!hasScope(auth, "admin")) return errorResponse("Admin required", 403, requestId);
  const body = await req.json().catch(() => ({})) as any;
  const oldKeyId = Number(body.key_id);
  if (!oldKeyId) return errorResponse("key_id is required", 400, requestId);

  // Verify old key exists and belongs to this user
  const oldKey = db.prepare("SELECT * FROM api_keys WHERE id = ? AND user_id = ?").get(oldKeyId, auth.user_id) as any;
  if (!oldKey) return errorResponse("Key not found", 404, requestId);

  // Generate new key with same scopes/settings
  const { key, prefix, hash } = generateApiKey();
  const newKeyResult = db.prepare(
    `INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit, agent_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`
  ).get(auth.user_id, prefix, hash, `${oldKey.name} (rotated)`, oldKey.scopes, oldKey.rate_limit, oldKey.agent_id, body.expires_at || null) as any;

  // Mark old key with a grace period (24 hours) before deactivation
  const graceExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  db.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run(graceExpiry, oldKeyId);

  audit(auth.user_id, "key.rotated", "api_key", oldKeyId, `new_key_id=${newKeyResult.id}`, clientIp, requestId);

  return json({
    new_key: key,
    new_key_id: newKeyResult.id,
    old_key_id: oldKeyId,
    old_key_expires: graceExpiry,
    message: "Old key will expire in 24 hours. Update your clients to use the new key.",
  });
}
```

**Acceptance criteria:**
- API keys can have optional expiration dates
- Expired keys return 401 immediately
- last_used_at is batched (max 1 write per 30 seconds per key, not per request)
- Key rotation creates new key and sets 24h grace period on old key
- All existing tests pass

---

## PHASE 2: Reliability Fixes

### 2.1 SQLite Lock Handling

**Problem:** The busy_timeout is 5s (line ~20 of db/index.ts) which is fine for normal load,
but there is no instrumentation to know WHEN lock contention happens, no retry logic for
specific operations that are more likely to contend, and no circuit breaker for runaway
write pressure.

**Files to modify:**
- `src/db/index.ts` (add lock monitoring)
- `src/config/logger.ts` (add lock counter)

**Task 2.1.1: Add lock contention counter**

In `src/config/logger.ts`, find the `opsCounters` object (search for `opsCounters`). Add:

```typescript
db_lock_waits: 0,
db_lock_timeouts: 0,
db_write_queue_depth: 0,
```

**Task 2.1.2: Add write serialization wrapper**

In `src/db/index.ts`, add a write queue wrapper that tracks contention:

```typescript
import { opsCounters } from "../config/logger.ts";

let activeWrites = 0;

export function withWriteLock<T>(label: string, fn: () => T): T {
  activeWrites++;
  opsCounters.db_write_queue_depth = Math.max(opsCounters.db_write_queue_depth, activeWrites);
  if (activeWrites > 1) {
    opsCounters.db_lock_waits++;
    log.debug({ msg: "db_write_contention", label, depth: activeWrites });
  }
  try {
    return fn();
  } catch (e: any) {
    if (String(e).includes("database is locked") || String(e).includes("SQLITE_BUSY")) {
      opsCounters.db_lock_timeouts++;
      log.error({ msg: "db_lock_timeout", label, depth: activeWrites });
    }
    throw e;
  } finally {
    activeWrites--;
  }
}
```

You do NOT need to wrap every write in this. Only wrap the operations that are most likely to
contend:
1. `insertMemory` calls in the /store route
2. Job processing in `processNextJob`
3. The `drainJobs` loop
4. Backup (VACUUM INTO)

For each of these, wrap the DB write call:
```typescript
// BEFORE:
insertMemory.run(...args);
// AFTER:
withWriteLock("store_memory", () => insertMemory.run(...args));
```

**Task 2.1.3: Add WAL checkpoint monitoring**

In `server-split.ts`, find the WAL checkpoint interval (search for `wal_checkpoint` or
`PRAGMA wal_checkpoint`). Add timing and logging:

```typescript
const cpStart = performance.now();
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const cpMs = (performance.now() - cpStart).toFixed(1);
log.info({ msg: "wal_checkpoint", ms: cpMs });
if (Number(cpMs) > 1000) {
  log.warn({ msg: "wal_checkpoint_slow", ms: cpMs });
}
```

**Acceptance criteria:**
- `opsCounters` tracks db_lock_waits, db_lock_timeouts, db_write_queue_depth
- Lock contention is visible in /health response (already includes opsCounters for admins, line 1057)
- WAL checkpoint duration is logged
- No behavior change for normal operations

---

### 2.2 Queue Failure Visibility

**Problem:** Failed jobs log errors but there is no way to query them via API. The /health
endpoint shows job counts by status but not the actual errors. Operators have no way to see
what is failing, why, or how often.

**Files to modify:**
- `src/jobs/index.ts` (add query functions)
- `src/routes/index.ts` (add /jobs endpoints)

**Task 2.2.1: Add job query prepared statements**

In `src/jobs/index.ts`, add after the existing prepared statements (around line 66):

```typescript
const listFailedStmt = db.prepare(
  `SELECT id, type, payload, attempts, max_attempts, error, created_at, completed_at
   FROM jobs WHERE status = 'failed'
   ORDER BY completed_at DESC LIMIT ? OFFSET ?`
);

const countFailedStmt = db.prepare(
  `SELECT COUNT(*) as count FROM jobs WHERE status = 'failed'`
);

const listPendingJobsStmt = db.prepare(
  `SELECT id, type, payload, attempts, created_at, next_retry_at
   FROM jobs WHERE status = 'pending'
   ORDER BY created_at ASC LIMIT ? OFFSET ?`
);

const listRunningJobsStmt = db.prepare(
  `SELECT id, type, payload, attempts, claimed_at
   FROM jobs WHERE status = 'running'
   ORDER BY claimed_at ASC`
);

const retryFailedStmt = db.prepare(
  `UPDATE jobs SET status = 'pending', error = NULL, attempts = 0, next_retry_at = NULL
   WHERE id = ? AND status = 'failed'
   RETURNING id`
);

const purgeFailedStmt = db.prepare(
  `DELETE FROM jobs WHERE status = 'failed' AND completed_at < datetime('now', '-' || ? || ' days')`
);

export function listFailedJobs(limit: number = 50, offset: number = 0) {
  return listFailedStmt.all(limit, offset);
}

export function countFailedJobs(): number {
  return (countFailedStmt.get() as { count: number }).count;
}

export function listPendingJobs(limit: number = 50, offset: number = 0) {
  return listPendingJobsStmt.all(limit, offset);
}

export function listRunningJobs() {
  return listRunningJobsStmt.all();
}

export function retryFailedJob(id: number): boolean {
  const result = retryFailedStmt.get(id) as any;
  return !!result;
}

export function purgeFailedJobs(olderThanDays: number = 7): number {
  return (purgeFailedStmt.run(olderThanDays) as any).changes || 0;
}
```

**Task 2.2.2: Add /jobs API endpoints**

In `src/routes/index.ts`, add these routes near the other admin endpoints. Find the section
with `/admin/reembed` (around line 6312) and add BEFORE it:

```typescript
// ── Job Queue Management ─────────────────────────────────────────
if (url.pathname === "/jobs" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const status = url.searchParams.get("status") || "failed";
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
  const offset = Number(url.searchParams.get("offset") || 0);

  let jobs: any[];
  let total: number;
  if (status === "failed") {
    jobs = listFailedJobs(limit, offset);
    total = countFailedJobs();
  } else if (status === "pending") {
    jobs = listPendingJobs(limit, offset);
    total = jobs.length; // approximate
  } else if (status === "running") {
    jobs = listRunningJobs();
    total = jobs.length;
  } else {
    return errorResponse("Invalid status. Use: failed, pending, running", 400, requestId);
  }

  // Parse payload JSON for readability
  for (const j of jobs) {
    try { j.payload = JSON.parse(j.payload); } catch {}
  }

  return json({ jobs, total, limit, offset, status });
}

if (url.pathname === "/jobs/retry" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const body = await req.json().catch(() => ({})) as any;
  const id = Number(body.id);
  if (!id) return errorResponse("id is required", 400, requestId);
  const retried = retryFailedJob(id);
  if (!retried) return errorResponse("Job not found or not in failed state", 404, requestId);
  audit(auth.user_id, "job.retry", "job", id, null, clientIp, requestId);
  return json({ retried: true, id });
}

if (url.pathname === "/jobs/purge" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const body = await req.json().catch(() => ({})) as any;
  const days = Number(body.older_than_days || 7);
  const purged = purgeFailedJobs(days);
  audit(auth.user_id, "job.purge", null, null, `purged=${purged} older_than=${days}d`, clientIp, requestId);
  return json({ purged, older_than_days: days });
}
```

Add the imports at the top of routes/index.ts:
```typescript
import { listFailedJobs, countFailedJobs, listPendingJobs, listRunningJobs, retryFailedJob, purgeFailedJobs } from "../jobs/index.ts";
```

**Acceptance criteria:**
- `GET /jobs?status=failed` returns failed jobs with errors, payload, timestamps
- `GET /jobs?status=pending` returns pending jobs with retry timing
- `GET /jobs?status=running` returns currently running jobs
- `POST /jobs/retry` re-queues a specific failed job
- `POST /jobs/purge` cleans up old failures
- All endpoints are admin-only

---

### 2.3 Backup Discipline

**Problem:**
1. Backup endpoint does VACUUM INTO which blocks writers during the entire copy
2. No automatic backup scheduling
3. Backup script (scripts/backup-restore-drill.sh) is good but not integrated into the server
4. No backup integrity verification via API
5. Temp backup file cleanup uses setTimeout (line 6719) which is fragile

**Files to modify:**
- `src/routes/index.ts` (improve backup endpoint)
- `server-split.ts` (add automatic backup scheduling)
- `src/config/index.ts` (add backup config)

**Task 2.3.1: Add backup configuration**

In `src/config/index.ts`, after the logging config (around line 129), add:

```typescript
// Backup config
export const BACKUP_DIR = process.env.ENGRAM_BACKUP_DIR || resolve(DATA_DIR, "backups");
export const BACKUP_RETENTION_DAYS = Number(process.env.ENGRAM_BACKUP_RETENTION_DAYS || 7);
export const BACKUP_SCHEDULE_HOURS = Number(process.env.ENGRAM_BACKUP_SCHEDULE_HOURS || 0); // 0 = disabled
```

Add `mkdirSync(BACKUP_DIR, { recursive: true });` after the DATA_DIR mkdir on line 140.

**Task 2.3.2: Add backup verification endpoint**

In `src/routes/index.ts`, add after the existing /backup GET endpoint (around line 6724):

```typescript
if (url.pathname === "/backup/verify" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  try {
    // Run integrity check on live database
    const integrity = db.prepare("PRAGMA integrity_check").get() as any;
    const fkCheck = db.prepare("PRAGMA foreign_key_check").all();
    const walPages = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as any;
    const memCount = db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };
    const tableCount = db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'").get() as { count: number };

    return json({
      integrity: integrity?.integrity_check || "unknown",
      foreign_key_violations: fkCheck.length,
      foreign_key_details: fkCheck.length > 0 ? fkCheck.slice(0, 10) : undefined,
      wal_pages: walPages,
      memories: memCount.count,
      tables: tableCount.count,
      db_size_mb: Math.round(statSync(DB_PATH).size / 1048576 * 100) / 100,
    });
  } catch (e: any) {
    return safeError("Backup verify", e, 500, requestId);
  }
}
```

**Task 2.3.3: Improve backup endpoint cleanup**

In the existing /backup handler (line 6704-6724), replace the setTimeout cleanup with
immediate cleanup after response is constructed:

```typescript
// BEFORE (line 6719):
setTimeout(() => { try { unlinkSync(backupPath); } catch {} }, 30_000);

// AFTER:
// Read file into memory first, then delete immediately
try { unlinkSync(backupPath); } catch {}
```

Move the `unlinkSync` to right after `readFileSync` on line 6710, BEFORE constructing the
Response. The file is already fully read into `fileBuffer` at that point:

```typescript
const fileBuffer = readFileSync(backupPath);
try { unlinkSync(backupPath); } catch {} // Clean up immediately, data is in memory
```

**Task 2.3.4: Add automatic backup scheduling**

In `server-split.ts`, add a backup interval if configured. Find the section where other
intervals are set up (search for `setInterval` blocks). Add:

```typescript
import { BACKUP_DIR, BACKUP_RETENTION_DAYS, BACKUP_SCHEDULE_HOURS } from "./src/config/index.ts";

if (BACKUP_SCHEDULE_HOURS > 0) {
  const backupIntervalMs = BACKUP_SCHEDULE_HOURS * 60 * 60 * 1000;
  setInterval(withLease("auto_backup", async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = resolve(BACKUP_DIR, `engram-auto-${timestamp}.db`);
    try {
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      const size = statSync(backupPath).size;
      log.info({ msg: "auto_backup_created", path: backupPath, size_mb: Math.round(size / 1048576 * 100) / 100 });

      // Cleanup old backups
      const files = readdirSync(BACKUP_DIR).filter(f => f.startsWith("engram-auto-") && f.endsWith(".db"));
      const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      for (const f of files) {
        const fPath = resolve(BACKUP_DIR, f);
        try {
          if (statSync(fPath).mtimeMs < cutoff) {
            unlinkSync(fPath);
            log.info({ msg: "auto_backup_pruned", path: fPath });
          }
        } catch {}
      }
    } catch (e: any) {
      log.error({ msg: "auto_backup_failed", error: e.message });
    }
  }), backupIntervalMs);
  log.info({ msg: "auto_backup_enabled", interval_hours: BACKUP_SCHEDULE_HOURS, retention_days: BACKUP_RETENTION_DAYS });
}
```

Add `readdirSync` to the existing `fs` import at the top of server-split.ts.

**Acceptance criteria:**
- `POST /backup/verify` returns integrity check results
- Backup temp files cleaned up immediately (not via setTimeout)
- Automatic backups run on configured interval with retention cleanup
- `ENGRAM_BACKUP_SCHEDULE_HOURS=6` creates a backup every 6 hours
- Old backups older than ENGRAM_BACKUP_RETENTION_DAYS are deleted

---

## PHASE 3: Observability

### 3.1 /metrics Endpoint

**Problem:** No Prometheus-compatible metrics endpoint. The /health endpoint has good data but
in a JSON structure that isn't scrapeable. Operators need time-series data for: request latency,
queue depth, embedding latency, error rates, DB lock contention, memory counts.

**Files to modify:**
- `src/routes/index.ts` (add /metrics endpoint)
- `src/config/logger.ts` (add histogram tracking)

**Task 3.1.1: Add request metrics tracking**

In `src/config/logger.ts`, find the `opsCounters` object and add:

```typescript
request_count: 0,
request_errors: 0,
request_latency_sum_ms: 0,
embedding_latency_sum_ms: 0,
embedding_count: 0,
search_count: 0,
search_latency_sum_ms: 0,
store_count: 0,
store_latency_sum_ms: 0,
```

**Task 3.1.2: Instrument request lifecycle**

In `src/routes/index.ts`, the `fetchHandler` function already tracks `requestStart` via
`performance.now()`. At the end of every successful response path, the elapsed time is
already computed in many places. Add counters at the response return points.

Find the catch-all 404 block at the end of fetchHandler (around line 6761). BEFORE it, the
function should have a place where `opsCounters.request_count++` is incremented. The best
place is right at the top of fetchHandler, after `const requestStart`:

```typescript
opsCounters.request_count++;
```

For error responses, in the outer try/catch of fetchHandler (search for the catch block that
returns 500), add:
```typescript
opsCounters.request_errors++;
```

**Task 3.1.3: Instrument embedding and search**

In `src/embeddings/index.ts`, find the `embed()` function. Wrap its body with timing:

```typescript
import { opsCounters } from "../config/logger.ts";

// Inside embed():
const embedStart = performance.now();
// ... existing embed logic ...
const embedMs = performance.now() - embedStart;
opsCounters.embedding_count++;
opsCounters.embedding_latency_sum_ms += embedMs;
```

In `src/memory/search.ts`, find the `hybridSearch()` function. Add timing:

```typescript
import { opsCounters } from "../config/logger.ts";

// At the start of hybridSearch():
const searchStart = performance.now();
// ... existing search logic ...
// At the end, before return:
opsCounters.search_count++;
opsCounters.search_latency_sum_ms += (performance.now() - searchStart);
```

**Task 3.1.4: Add /metrics endpoint (Prometheus text format)**

In `src/routes/index.ts`, add after the /health endpoint (around line 1060). This should be
BEFORE the auth requirement so it can be scraped without auth (like /health unauthenticated):

Find the section that handles unauthenticated routes (where /health, /live, /ready are).
Add the /metrics handler in the same unauthenticated section:

```typescript
if (url.pathname === "/metrics" && method === "GET") {
  const stats = getJobStats();
  const memCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE is_forgotten = 0").get() as any;
  const embCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL AND is_forgotten = 0").get() as any;
  const dbSize = statSync(DB_PATH).size;

  const lines: string[] = [
    "# HELP engram_memories_total Total non-forgotten memories",
    "# TYPE engram_memories_total gauge",
    `engram_memories_total ${memCount.c}`,
    "",
    "# HELP engram_embedded_total Memories with embeddings",
    "# TYPE engram_embedded_total gauge",
    `engram_embedded_total ${embCount.c}`,
    "",
    "# HELP engram_db_size_bytes Database file size",
    "# TYPE engram_db_size_bytes gauge",
    `engram_db_size_bytes ${dbSize}`,
    "",
    "# HELP engram_jobs_total Jobs by status",
    "# TYPE engram_jobs_total gauge",
    `engram_jobs_total{status="pending"} ${stats.pending || 0}`,
    `engram_jobs_total{status="running"} ${stats.running || 0}`,
    `engram_jobs_total{status="completed"} ${stats.completed || 0}`,
    `engram_jobs_total{status="failed"} ${stats.failed || 0}`,
    "",
    "# HELP engram_requests_total Total HTTP requests",
    "# TYPE engram_requests_total counter",
    `engram_requests_total ${opsCounters.request_count}`,
    "",
    "# HELP engram_request_errors_total Total HTTP 5xx errors",
    "# TYPE engram_request_errors_total counter",
    `engram_request_errors_total ${opsCounters.request_errors}`,
    "",
    "# HELP engram_embedding_latency_avg_ms Average embedding latency",
    "# TYPE engram_embedding_latency_avg_ms gauge",
    `engram_embedding_latency_avg_ms ${opsCounters.embedding_count > 0 ? (opsCounters.embedding_latency_sum_ms / opsCounters.embedding_count).toFixed(1) : 0}`,
    "",
    "# HELP engram_search_latency_avg_ms Average search latency",
    "# TYPE engram_search_latency_avg_ms gauge",
    `engram_search_latency_avg_ms ${opsCounters.search_count > 0 ? (opsCounters.search_latency_sum_ms / opsCounters.search_count).toFixed(1) : 0}`,
    "",
    "# HELP engram_db_lock_waits_total Write lock contention events",
    "# TYPE engram_db_lock_waits_total counter",
    `engram_db_lock_waits_total ${opsCounters.db_lock_waits || 0}`,
    "",
    "# HELP engram_db_lock_timeouts_total SQLite BUSY timeout events",
    "# TYPE engram_db_lock_timeouts_total counter",
    `engram_db_lock_timeouts_total ${opsCounters.db_lock_timeouts || 0}`,
    "",
    "# HELP engram_uptime_seconds Server uptime",
    "# TYPE engram_uptime_seconds gauge",
    `engram_uptime_seconds ${Math.floor(process.uptime())}`,
    "",
  ];

  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
```

**Acceptance criteria:**
- `GET /metrics` returns Prometheus text format
- Includes: memory count, embedded count, DB size, job stats, request count, error count,
  embedding latency, search latency, lock contention, uptime
- Endpoint is unauthenticated (like /health without auth)
- No significant overhead (counters are cheap in-memory increments)

---

### 3.2 Structured Tracing Hooks

**Problem:** There is no way for operators to hook into the request lifecycle for custom
tracing (e.g., sending spans to Jaeger/Datadog). The request ID is generated but not exposed
consistently.

**Files to modify:**
- `src/routes/index.ts` (add X-Request-Id response header consistently)

**Task 3.2.1: Add X-Request-Id to all responses**

The `securityHeaders()` function in `src/helpers/index.ts` is applied to many but not all
responses. Search for `securityHeaders` usage. The function should include X-Request-Id.

In the `fetchHandler`, the `requestId` is generated early. Add it to the `securityHeaders`
function call by passing it through. The simplest approach: at the top of fetchHandler, after
`requestId` is generated, store it in a variable that `securityHeaders` can access.

Actually, the simpler approach: find the `json()` helper function in routes/index.ts. It likely
creates Response objects. Ensure every call includes `"X-Request-Id": requestId` in headers.

Search for `function json(` in routes/index.ts. Find its signature. If it accepts extra headers,
modify the function to always include X-Request-Id. If not, add a `requestId` parameter.

The json helper likely looks like:
```typescript
function json(data: any, status: number = 200, extraHeaders?: Record<string, string>): Response
```

Modify it or its callers to always pass requestId. The least invasive approach: in the main
request handler, after building the final Response, set the header:

Actually, the best approach for consistency is to add a wrapper at the end of fetchHandler that
adds X-Request-Id to every response. Find the outer try block that wraps the entire handler.
Before returning any response, pass through a function:

```typescript
// At the end of fetchHandler, wrap the response:
function addRequestId(resp: Response): Response {
  resp.headers.set("X-Request-Id", requestId);
  return resp;
}
```

Then wrap the final return of fetchHandler. OR, simpler: in each major return path, add the
header to the `securityHeaders()` call.

This task is lower priority than the others. If it's too invasive to touch every return path,
skip it. The X-Request-Id is already included in most error responses.

**Acceptance criteria:**
- X-Request-Id header present in all API responses
- If too invasive, at minimum ensure it's on all error responses and the top 10 most-used
  endpoints (/store, /search, /recall, /context, /health, /list, /memory/:id, /conversations,
  /scratch, /stats)

---

## PHASE 4: Commercial Multi-Tenant

### 4.1 Tenant Lifecycle

**Problem:** Users can be created via `POST /users` but there's no onboarding flow, no
tenant provisioning (space creation, default key generation), and no tenant deprovisioning
that cleans up all data.

**Files to modify:**
- `src/routes/index.ts` (add tenant management endpoints)
- `src/db/index.ts` (add cascade delete support)

**Task 4.1.1: Add tenant provisioning endpoint**

In `src/routes/index.ts`, add near the existing `/users` POST handler:

```typescript
if (url.pathname === "/tenants/provision" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const body = await req.json().catch(() => ({})) as any;
  const { username, email, role } = body;
  if (!username) return errorResponse("username is required", 400, requestId);

  try {
    // Create user
    const userResult = db.prepare(
      "INSERT INTO users (username, email, role, is_admin) VALUES (?, ?, ?, ?) RETURNING id"
    ).get(username, email || null, role || "writer", role === "admin" ? 1 : 0) as any;
    const userId = userResult.id;

    // Create default space
    db.prepare(
      "INSERT INTO spaces (user_id, name, description) VALUES (?, ?, ?)"
    ).run(userId, "default", "Default memory space");

    // Generate initial API key
    const { key, prefix, hash } = generateApiKey();
    const keyResult = db.prepare(
      "INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
    ).get(userId, prefix, hash, "initial", role === "admin" ? "read,write,admin" : "read,write", DEFAULT_RATE_LIMIT) as any;

    audit(auth.user_id, "tenant.provision", "user", userId, `key_id=${keyResult.id}`, clientIp, requestId);

    return json({
      user_id: userId,
      username,
      api_key: key,
      api_key_id: keyResult.id,
      space: "default",
    }, 201);
  } catch (e: any) {
    if (String(e).includes("UNIQUE constraint")) {
      return errorResponse(`Username '${username}' already exists`, 409, requestId);
    }
    return safeError("Tenant provision", e, 500, requestId);
  }
}
```

**Task 4.1.2: Add tenant deprovisioning endpoint**

```typescript
if (url.pathname === "/tenants/deprovision" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const body = await req.json().catch(() => ({})) as any;
  const userId = Number(body.user_id);
  const confirm = body.confirm;
  if (!userId) return errorResponse("user_id is required", 400, requestId);
  if (userId === 1) return errorResponse("Cannot deprovision the primary user", 400, requestId);
  if (confirm !== `delete-user-${userId}`) {
    return errorResponse(`Set confirm to 'delete-user-${userId}' to proceed`, 400, requestId);
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
  if (!user) return errorResponse("User not found", 404, requestId);

  // Count data for audit
  const memCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE user_id = ?").get(userId) as any;
  const convCount = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE user_id = ?").get(userId) as any;

  // Delete all user data (order matters for FK constraints)
  const tables = [
    "scratchpad", "personality_signals", "personality_profiles",
    "structured_facts", "memory_entities", "memory_links", "memory_projects",
    "consolidations", "reflections", "temporal_patterns", "reconsolidations",
    "causal_links", "causal_chains", "current_state", "user_preferences",
    "webhooks", "digests", "episodes", "messages", "conversations",
    "entity_relationships", "entity_cooccurrences", "entities",
    "projects", "spaces", "api_keys", "agents",
  ];

  let totalDeleted = 0;
  for (const table of tables) {
    try {
      const result = db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
      totalDeleted += (result as any).changes || 0;
    } catch {}
  }

  // Delete memories last (other tables may FK to it)
  const memResult = db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
  totalDeleted += (memResult as any).changes || 0;

  // Delete user record
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);

  // Refresh embedding cache since we deleted memories
  refreshEmbeddingCache();

  audit(auth.user_id, "tenant.deprovision", "user", userId,
    `memories=${memCount.c} conversations=${convCount.c} total_rows=${totalDeleted}`,
    clientIp, requestId);

  return json({
    deprovisioned: true,
    user_id: userId,
    username: user.username,
    rows_deleted: totalDeleted,
  });
}
```

**Acceptance criteria:**
- `POST /tenants/provision` creates user + default space + initial API key in one call
- `POST /tenants/deprovision` deletes ALL user data with confirmation token
- Both endpoints are admin-only
- Deprovisioning refreshes the embedding cache
- Audit trail records both operations

---

### 4.2 Quotas & Limits

**Problem:** No per-tenant resource limits. A single tenant can store unlimited memories,
use unlimited embeddings, and consume all server resources.

**Files to modify:**
- `src/db/index.ts` (add quotas table)
- `src/routes/index.ts` (enforce quotas on /store)

**Task 4.2.1: Add quotas table**

In `src/db/index.ts`, add migration:

```typescript
migrate(`
  CREATE TABLE IF NOT EXISTS tenant_quotas (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_memories INTEGER DEFAULT 10000,
    max_conversations INTEGER DEFAULT 1000,
    max_api_keys INTEGER DEFAULT 10,
    max_spaces INTEGER DEFAULT 5,
    max_memory_size_bytes INTEGER DEFAULT 102400,
    rate_limit_override INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
```

Add prepared statements:

```typescript
export const getQuota = db.prepare(
  `SELECT * FROM tenant_quotas WHERE user_id = ?`
);

export const upsertQuota = db.prepare(`
  INSERT INTO tenant_quotas (user_id, max_memories, max_conversations, max_api_keys, max_spaces, max_memory_size_bytes, rate_limit_override)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    max_memories = excluded.max_memories,
    max_conversations = excluded.max_conversations,
    max_api_keys = excluded.max_api_keys,
    max_spaces = excluded.max_spaces,
    max_memory_size_bytes = excluded.max_memory_size_bytes,
    rate_limit_override = excluded.rate_limit_override,
    updated_at = datetime('now')
`);

export const getUserMemoryCount = db.prepare(
  `SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_forgotten = 0`
);
```

**Task 4.2.2: Enforce memory quota on /store**

In `src/routes/index.ts`, find the /store POST handler (search for the memory creation logic,
around the content validation). After the content validation but before the INSERT, add:

```typescript
// Check tenant quota
const quota = getQuota.get(auth.user_id) as any;
if (quota) {
  const currentCount = (getUserMemoryCount.get(auth.user_id) as any).count;
  if (currentCount >= quota.max_memories) {
    return errorResponse(`Memory quota exceeded (${currentCount}/${quota.max_memories}). Contact admin to increase limit.`, 429, requestId);
  }
  if (content.length > quota.max_memory_size_bytes) {
    return errorResponse(`Content too large for your quota (${content.length}/${quota.max_memory_size_bytes} bytes)`, 413, requestId);
  }
}
```

Import `getQuota` and `getUserMemoryCount` from `../db/index.ts`.

**Task 4.2.3: Add quota management endpoints**

```typescript
if (url.pathname === "/admin/quotas" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const userId = Number(url.searchParams.get("user_id"));
  if (userId) {
    const quota = getQuota.get(userId);
    return json({ quota: quota || null });
  }
  const all = db.prepare("SELECT tq.*, u.username FROM tenant_quotas tq JOIN users u ON tq.user_id = u.id").all();
  return json({ quotas: all });
}

if (url.pathname === "/admin/quotas" && method === "PUT") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const body = await req.json().catch(() => ({})) as any;
  const userId = Number(body.user_id);
  if (!userId) return errorResponse("user_id is required", 400, requestId);
  upsertQuota.run(
    userId,
    body.max_memories ?? 10000,
    body.max_conversations ?? 1000,
    body.max_api_keys ?? 10,
    body.max_spaces ?? 5,
    body.max_memory_size_bytes ?? 102400,
    body.rate_limit_override ?? null,
  );
  audit(auth.user_id, "quota.update", "user", userId, JSON.stringify(body), clientIp, requestId);
  return json({ updated: true, user_id: userId });
}
```

**Acceptance criteria:**
- Quotas are optional (no quota row = unlimited, preserving current behavior)
- /store checks memory count quota before insert
- /store checks content size quota before insert
- Admin can view and set quotas per tenant
- Quota exceeded returns 429 with clear message

---

### 4.3 Tenant Admin Tooling

**Problem:** No way for operators to see tenant usage, active tenants, or manage tenants
in aggregate.

**Files to modify:**
- `src/routes/index.ts` (add admin dashboard endpoints)

**Task 4.3.1: Add tenant overview endpoint**

```typescript
if (url.pathname === "/admin/tenants" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const tenants = db.prepare(`
    SELECT
      u.id as user_id,
      u.username,
      u.role,
      u.created_at,
      (SELECT COUNT(*) FROM memories WHERE user_id = u.id AND is_forgotten = 0) as memory_count,
      (SELECT COUNT(*) FROM conversations WHERE user_id = u.id) as conversation_count,
      (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id AND is_active = 1) as active_keys,
      (SELECT COUNT(*) FROM spaces WHERE user_id = u.id) as space_count,
      (SELECT MAX(ak.last_used_at) FROM api_keys ak WHERE ak.user_id = u.id) as last_active,
      tq.max_memories
    FROM users u
    LEFT JOIN tenant_quotas tq ON tq.user_id = u.id
    ORDER BY u.id
  `).all();
  return json({ tenants });
}
```

**Task 4.3.2: Add provider visibility endpoint**

```typescript
if (url.pathname === "/admin/providers" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const providers = LLM_PROVIDERS.map((p, i) => ({
    index: i,
    name: p.name,
    model: p.model,
    url: p.url.replace(/\/\/.*@/, "//***@"), // Mask credentials in URL
    has_key: !!p.key,
    available: isProviderAvailable(p),
  }));

  return json({
    embedding: {
      provider: EMBEDDING_PROVIDER,
      model: EMBEDDING_MODEL,
      dimension: EMBEDDING_DIM,
    },
    llm_providers: providers,
    llm_strategy: LLM_STRATEGY,
    reranker: {
      enabled: RERANKER_ENABLED,
      cross_encoder: isRerankerReady(),
      top_k: RERANKER_TOP_K,
    },
  });
}
```

**Acceptance criteria:**
- `GET /admin/tenants` shows all tenants with usage stats
- `GET /admin/providers` shows LLM/embedding provider config (keys masked)
- Both are admin-only

---

## PHASE 5: Data Portability

### 5.1 Export API

**Problem:** The only export is `GET /backup` which dumps the entire SQLite DB. There is no
way to export a single tenant's data as portable JSON, and no way to export specific
conversations or memory subsets.

**Files to modify:**
- `src/routes/index.ts` (add export endpoints)

**Task 5.1.1: Add tenant data export**

```typescript
if (url.pathname === "/export" && method === "GET") {
  if (!hasScope(auth, "read")) return errorResponse("Read scope required", 403, requestId);
  const format = url.searchParams.get("format") || "json";
  const since = url.searchParams.get("since"); // ISO date filter

  let memories: any[];
  if (since) {
    memories = db.prepare(
      `SELECT id, content, category, source, session_id, importance, tags, confidence,
       is_static, version, is_latest, created_at, updated_at
       FROM memories WHERE user_id = ? AND is_forgotten = 0 AND created_at > ?
       ORDER BY created_at ASC`
    ).all(auth.user_id, since);
  } else {
    memories = db.prepare(
      `SELECT id, content, category, source, session_id, importance, tags, confidence,
       is_static, version, is_latest, created_at, updated_at
       FROM memories WHERE user_id = ? AND is_forgotten = 0
       ORDER BY created_at ASC`
    ).all(auth.user_id);
  }

  // Parse tags JSON
  for (const m of memories) {
    try { if (m.tags) m.tags = JSON.parse(m.tags); } catch { m.tags = []; }
  }

  const conversations = db.prepare(
    `SELECT c.id, c.agent, c.session_id, c.title, c.metadata, c.started_at, c.updated_at,
     (SELECT json_group_array(json_object(
       'role', m.role, 'content', m.content, 'created_at', m.created_at
     )) FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at) as messages
     FROM conversations c WHERE c.user_id = ?
     ORDER BY c.started_at ASC`
  ).all(auth.user_id);

  for (const c of conversations) {
    try { if (c.messages) c.messages = JSON.parse(c.messages); } catch { c.messages = []; }
    try { if (c.metadata) c.metadata = JSON.parse(c.metadata); } catch {}
  }

  const entities = db.prepare(
    `SELECT id, name, type, description, created_at FROM entities WHERE user_id = ?`
  ).all(auth.user_id);

  const projects = db.prepare(
    `SELECT id, title, description, status, created_at FROM projects WHERE user_id = ?`
  ).all(auth.user_id);

  const exportData = {
    version: "1.0",
    exported_at: new Date().toISOString(),
    engram_version: PKG_VERSION,
    user_id: auth.user_id,
    counts: {
      memories: memories.length,
      conversations: conversations.length,
      entities: entities.length,
      projects: projects.length,
    },
    memories,
    conversations,
    entities,
    projects,
  };

  audit(auth.user_id, "export", null, null,
    `memories=${memories.length} conversations=${conversations.length}`, clientIp, requestId);

  return new Response(JSON.stringify(exportData, null, 2), {
    headers: securityHeaders({
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="engram-export-${new Date().toISOString().slice(0,10)}.json"`,
    }),
  });
}
```

**Acceptance criteria:**
- `GET /export` returns all user data as structured JSON
- `GET /export?since=2026-01-01` filters to memories created after that date
- Conversations include their messages inline
- Tags are parsed from JSON strings to arrays
- Export format has version field for forward compatibility
- Audit trail records export

---

### 5.2 Import API Improvements

**Problem:** The existing `/import` endpoint exists but only handles SQLite DB restore.
Need a JSON import that matches the export format.

**Files to modify:**
- `src/routes/index.ts` (add /import/json endpoint)

**Task 5.2.1: Add JSON import endpoint**

```typescript
if (url.pathname === "/import/json" && method === "POST") {
  if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403, requestId);
  const body = await req.json().catch(() => null);
  if (!body || !body.version) return errorResponse("Invalid export format: missing version field", 400, requestId);
  if (!body.memories || !Array.isArray(body.memories)) return errorResponse("Invalid export format: missing memories array", 400, requestId);

  let imported = { memories: 0, conversations: 0, entities: 0, skipped: 0 };

  // Import memories
  const insertImported = db.prepare(`
    INSERT INTO memories (content, category, source, session_id, importance, tags, confidence, is_static, user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `);

  for (const m of body.memories) {
    if (!m.content || typeof m.content !== "string") { imported.skipped++; continue; }
    try {
      const tags = Array.isArray(m.tags) ? JSON.stringify(m.tags) : m.tags || null;
      const result = insertImported.get(
        m.content, m.category || "general", m.source || "import", m.session_id || null,
        m.importance || DEFAULT_IMPORTANCE, tags, m.confidence || 1.0, m.is_static ? 1 : 0,
        auth.user_id, m.created_at || new Date().toISOString(), m.updated_at || new Date().toISOString()
      ) as any;

      // Enqueue embedding job
      enqueueJob("post_store", { memory_id: result.id, user_id: auth.user_id }, 3);
      imported.memories++;
    } catch (e: any) {
      log.warn({ msg: "import_memory_failed", error: e.message });
      imported.skipped++;
    }
  }

  // Import conversations
  if (body.conversations && Array.isArray(body.conversations)) {
    for (const c of body.conversations) {
      try {
        const msgs = Array.isArray(c.messages) ? c.messages : [];
        bulkInsertConvo(
          c.agent || "import", c.session_id || null, c.title || null,
          c.metadata ? JSON.stringify(c.metadata) : null,
          auth.user_id, msgs
        );
        imported.conversations++;
      } catch (e: any) {
        log.warn({ msg: "import_conversation_failed", error: e.message });
      }
    }
  }

  audit(auth.user_id, "import.json", null, null,
    `memories=${imported.memories} conversations=${imported.conversations} skipped=${imported.skipped}`,
    clientIp, requestId);

  return json({ imported });
}
```

**Acceptance criteria:**
- `POST /import/json` accepts the same format that `GET /export` produces
- Imported memories get embedding jobs enqueued
- user_id is always auth.user_id (never from import data)
- Invalid memories are skipped with a count
- Audit trail records import

---

## PHASE 6: Migration Tooling

### 6.1 Schema Drift Detection

**Problem:** Migrations use `migrate()` which silently ignores "already exists" errors. If a
migration partially fails, the schema can drift. There is no way to detect or report drift.

**Files to modify:**
- `src/db/index.ts` (add schema snapshot and drift detection)
- `src/routes/index.ts` (add /admin/schema endpoint)

**Task 6.1.1: Add schema snapshot function**

In `src/db/index.ts`, add:

```typescript
export function getSchemaSnapshot(): Record<string, string> {
  const tables = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as Array<{ name: string; sql: string }>;
  const result: Record<string, string> = {};
  for (const t of tables) {
    result[t.name] = t.sql;
  }
  return result;
}

export function getSchemaVersion(): number {
  try {
    const row = db.prepare("SELECT MAX(version) as v FROM schema_versions").get() as any;
    return row?.v || 0;
  } catch {
    return 0;
  }
}

export function getExpectedTables(): string[] {
  return [
    "memories", "memories_fts", "memory_links", "memory_entities",
    "entities", "entity_relationships", "entity_cooccurrences",
    "episodes", "episodes_fts", "consolidations",
    "conversations", "messages", "messages_fts",
    "projects", "memory_projects", "scratchpad",
    "users", "api_keys", "spaces", "agents",
    "structured_facts", "current_state", "user_preferences",
    "webhooks", "digests", "audit_log",
    "personality_signals", "personality_profiles",
    "causal_chains", "causal_links", "reconsolidations", "temporal_patterns",
    "jobs", "scheduler_leases", "schema_versions",
    "rate_limits", "tenant_quotas",
  ];
}

export function detectSchemaDrift(): { missing: string[]; extra: string[] } {
  const actual = new Set(Object.keys(getSchemaSnapshot()));
  const expected = new Set(getExpectedTables());
  const missing = [...expected].filter(t => !actual.has(t));
  const extra = [...actual].filter(t => !expected.has(t) && !t.endsWith("_fts") && !t.includes("_config") && !t.includes("_content") && !t.includes("_data") && !t.includes("_idx") && !t.includes("_docsize") && t !== "sqlite_sequence");
  return { missing, extra };
}
```

**Task 6.1.2: Add /admin/schema endpoint**

In `src/routes/index.ts`:

```typescript
if (url.pathname === "/admin/schema" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const snapshot = getSchemaSnapshot();
  const drift = detectSchemaDrift();
  const version = getSchemaVersion();

  const indexes = db.prepare(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name`
  ).all();

  return json({
    schema_version: version,
    tables: Object.keys(snapshot).length,
    indexes: indexes.length,
    drift: {
      has_drift: drift.missing.length > 0 || drift.extra.length > 0,
      missing_tables: drift.missing,
      unexpected_tables: drift.extra,
    },
    table_details: snapshot,
  });
}
```

**Acceptance criteria:**
- `GET /admin/schema` returns full schema snapshot with drift detection
- Missing tables and unexpected tables are flagged
- Schema version is reported
- Index count is included

---

### 6.2 Migration Preflight & Rollback

**Problem:** Migrations run on startup with no way to preview them, and no rollback strategy
if a migration breaks something.

**Files to modify:**
- `src/db/index.ts` (add preflight check)
- `src/routes/index.ts` (add migration status endpoint)

**Task 6.2.1: Add migration status to /admin/schema**

Extend the `/admin/schema` endpoint from Task 6.1.2 to include migration history:

```typescript
// Add inside the /admin/schema handler:
const migrations = db.prepare(
  "SELECT * FROM schema_versions ORDER BY version DESC LIMIT 20"
).all();

// Add to the response:
return json({
  // ... existing fields ...
  migrations,
});
```

**Task 6.2.2: Add startup schema backup**

In `server-split.ts`, BEFORE the database initialization (before `initDatabase()` or wherever
the DB is opened), add:

```typescript
// Pre-migration schema backup
import { existsSync, copyFileSync } from "fs";
if (existsSync(DB_PATH)) {
  const preBackupPath = resolve(DATA_DIR, `pre-migration-${Date.now()}.db`);
  try {
    copyFileSync(DB_PATH, preBackupPath);
    log.info({ msg: "pre_migration_backup", path: preBackupPath });
    // Keep only the last 3 pre-migration backups
    const files = readdirSync(DATA_DIR).filter(f => f.startsWith("pre-migration-")).sort().reverse();
    for (const f of files.slice(3)) {
      try { unlinkSync(resolve(DATA_DIR, f)); } catch {}
    }
  } catch (e: any) {
    log.warn({ msg: "pre_migration_backup_failed", error: e.message });
  }
}
```

**Acceptance criteria:**
- Schema backup taken before migrations run on every startup
- Only last 3 pre-migration backups retained
- Migration history visible in /admin/schema

---

## PHASE 7: API Product Surface

### 7.1 Pagination Consistency

**Problem:** Pagination is inconsistent across endpoints. Some use `limit/offset`, some
default to different limits, some don't support pagination at all. Response format varies
(some include `total`, some don't).

**Files to modify:**
- `src/routes/index.ts` (standardize pagination across endpoints)

**Task 7.1.1: Add pagination helper**

Near the top of `src/routes/index.ts` (in the helper functions section, around line 180), add:

```typescript
function parsePagination(url: URL, defaults: { limit: number; maxLimit: number } = { limit: 50, maxLimit: 200 }) {
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") || defaults.limit)), defaults.maxLimit);
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  return { limit, offset };
}
```

**Task 7.1.2: Standardize existing endpoints**

Search for all endpoints that use `limit` and `offset` parameters (use grep for
`searchParams.get("limit")`) and replace the inline parsing with `parsePagination()`.

Key endpoints to standardize:
- `/list` (GET) - list recent memories
- `/conversations` (GET) - list conversations
- `/episodes` (GET) - list episodes
- `/entities` (GET) - list entities
- `/projects` (GET) - list projects
- `/webhooks` (GET) - list webhooks
- `/keys` (GET) - list API keys
- `/inbox` (GET) - list pending memories
- `/audit` (GET) - list audit entries
- `/jobs` (GET) - list jobs (from Phase 2)

For each, replace:
```typescript
// BEFORE:
const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
const offset = Number(url.searchParams.get("offset") || 0);

// AFTER:
const { limit, offset } = parsePagination(url);
```

**Task 7.1.3: Ensure all paginated responses include pagination metadata**

Every paginated endpoint response should include:
```typescript
{
  data: [...],      // The actual items
  total: number,    // Total count (if feasible)
  limit: number,    // Applied limit
  offset: number,   // Applied offset
  has_more: boolean // Whether there are more results
}
```

For endpoints that already return a different shape (e.g., `{ memories: [...] }`), add
`limit`, `offset`, and `has_more` as top-level fields alongside the existing array.
Do NOT change the existing array field name (that would break clients).

Example for `/list`:
```typescript
// Current return might be:
return json({ memories, count: memories.length });

// Change to:
return json({ memories, count: memories.length, total, limit, offset, has_more: offset + limit < total });
```

**Acceptance criteria:**
- All list endpoints use `parsePagination()` for consistent parameter handling
- All list endpoints include `limit`, `offset`, `has_more` in response
- Maximum limit is capped at 200 across all endpoints
- Default limit is 50 across all endpoints
- No breaking changes to existing response field names

---

### 7.2 Stable Response Schemas

**Problem:** Some endpoints return different shapes depending on auth level or data presence.
Error responses are not consistent (some use `{ error: "..." }`, some use `{ message: "..." }`).

**Files to modify:**
- `src/routes/index.ts` (standardize error responses)

**Task 7.2.1: Standardize error response format**

Search for all `errorResponse` calls and verify they all use the same signature. The existing
`errorResponse` function should return:

```typescript
{ error: string, status: number, request_id?: string }
```

Find the `errorResponse` function definition. Ensure it always includes `request_id` if available.
If it currently doesn't, modify it:

```typescript
function errorResponse(message: string, status: number = 400, requestId?: string): Response {
  return json({ error: message, request_id: requestId || undefined }, status, {
    ...(requestId ? { "X-Request-Id": requestId } : {}),
  });
}
```

Search for any places that return errors without using `errorResponse` (e.g., raw `json({ error: ... })`
or `json({ message: ... })`) and replace them with `errorResponse()` calls.

**Task 7.2.2: Add API version header**

In `src/helpers/index.ts`, add to the `securityHeaders` default headers:

```typescript
"X-Engram-Version": PKG_VERSION,
```

Import PKG_VERSION from `../config/index.ts`.

**Acceptance criteria:**
- All error responses use `{ error: string, request_id?: string }` format
- No `{ message: "..." }` error format exists
- X-Engram-Version header present on all responses

---

## PHASE 8: Scale Strategy

### 8.1 Performance Guardrails

**Problem:** The in-memory embedding cache loads ALL memories on startup. At 10K memories
with 1024-dim embeddings, that's ~40MB RAM. At 100K, it's ~400MB. At 1M, it's ~4GB. The
linear cosine scan in hybridSearch becomes the bottleneck well before that.

**Files to modify:**
- `src/routes/index.ts` (add scale warnings to /health)
- `src/config/index.ts` (add scale config)
- `src/embeddings/index.ts` (add cache size tracking)

**Task 8.1.1: Add cache size tracking**

In `src/embeddings/index.ts`, add after the cache refresh function:

```typescript
export function getEmbeddingCacheStats(): {
  total: number; latest: number; size_mb: number; episodes: number;
  avg_search_ms: number; estimated_max_memories: number;
} {
  const dimBytes = EMBEDDING_DIM * 4; // Float32 = 4 bytes per dimension
  const totalSize = embeddingCache.length * dimBytes;
  // Estimate: linear scan does ~500K cosine ops/sec on a single core
  // At 1024-dim, each cosine op takes ~2us. Budget 50ms for search portion.
  const estimatedMax = Math.floor(50_000 / (EMBEDDING_DIM / 512));
  return {
    total: embeddingCache.length,
    latest: embeddingCacheLatest.length,
    size_mb: Math.round(totalSize / 1048576 * 100) / 100,
    episodes: episodeCache.length,
    avg_search_ms: opsCounters.search_count > 0
      ? Math.round(opsCounters.search_latency_sum_ms / opsCounters.search_count * 10) / 10
      : 0,
    estimated_max_memories: estimatedMax,
  };
}
```

Import `opsCounters` from `../config/logger.ts`.

**Task 8.1.2: Add scale warnings to /health**

In the /health handler (around line 1038, in the warnings section), add:

```typescript
const cacheStats = getEmbeddingCacheStats();
if (cacheStats.total > 50000) {
  w.push(`Embedding cache contains ${cacheStats.total} vectors (${cacheStats.size_mb}MB). Linear scan will degrade. Enable tiered search (Phase 8.2) or external vector DB.`);
} else if (cacheStats.total > 10000) {
  w.push(`Embedding cache: ${cacheStats.total} vectors (${cacheStats.size_mb}MB). Approaching linear scan limits. Monitor search latency via /metrics.`);
}
if (cacheStats.avg_search_ms > 200) {
  w.push(`Average search latency is ${cacheStats.avg_search_ms}ms. Consider enabling ANN index or reducing candidate pool.`);
}
```

Import `getEmbeddingCacheStats` from the embeddings module.

**Task 8.1.3: Add embedding_cache stats to /health and /metrics**

In the /health response object (around line 975), add:

```typescript
embedding_cache: getEmbeddingCacheStats(),
```

In the /metrics handler (from Phase 3), add:

```typescript
"# HELP engram_embedding_cache_count Vectors in embedding cache",
"# TYPE engram_embedding_cache_count gauge",
`engram_embedding_cache_count ${getEmbeddingCacheStats().total}`,
"",
"# HELP engram_embedding_cache_bytes Embedding cache memory usage",
"# TYPE engram_embedding_cache_bytes gauge",
`engram_embedding_cache_bytes ${getEmbeddingCacheStats().total * EMBEDDING_DIM * 4}`,
"",
"# HELP engram_search_p50_ms Estimated search latency (average as proxy)",
"# TYPE engram_search_p50_ms gauge",
`engram_search_p50_ms ${getEmbeddingCacheStats().avg_search_ms}`,
```

**Task 8.1.4: Add /admin/scale-report endpoint**

This gives operators a single view of where they are on the scale curve and what to do next.

In `src/routes/index.ts`, add:

```typescript
if (url.pathname === "/admin/scale-report" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);

  const cache = getEmbeddingCacheStats();
  const dbSize = statSync(DB_PATH).size;
  const memCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE is_forgotten = 0").get() as any;
  const convCount = db.prepare("SELECT COUNT(*) as c FROM conversations").get() as any;
  const msgCount = db.prepare("SELECT COUNT(*) as c FROM messages").get() as any;
  const jobStats = getJobStats();
  const userCount = db.prepare("SELECT COUNT(*) as c FROM users").get() as any;

  // Determine scale tier
  let tier: string;
  let recommendations: string[] = [];
  const total = memCount.c;

  if (total < 1000) {
    tier = "small";
    recommendations.push("Current architecture is well-suited. No changes needed.");
  } else if (total < 10000) {
    tier = "medium";
    recommendations.push("Monitor search latency. If avg exceeds 100ms, consider enabling ANN pre-filter.");
    recommendations.push("Ensure WAL checkpoint runs regularly (currently every 5 min).");
    recommendations.push("Consider enabling auto-backups if not already configured.");
  } else if (total < 100000) {
    tier = "large";
    recommendations.push("CRITICAL: Enable ANN pre-filter (Phase 8.2) to avoid linear scan degradation.");
    recommendations.push("Consider splitting embedding cache into per-user segments for multi-tenant isolation.");
    recommendations.push("Enable auto-consolidation to reduce memory volume via summarization.");
    recommendations.push("Consider archiving memories older than 1 year to cold storage (Phase 8.3).");
    if (userCount.c > 10) {
      recommendations.push("With " + userCount.c + " tenants, consider per-tenant SQLite databases for isolation.");
    }
  } else {
    tier = "very-large";
    recommendations.push("CRITICAL: SQLite in-memory vector search will not scale to " + total + " memories.");
    recommendations.push("Migrate vector search to external ANN index (libsql vector columns already exist).");
    recommendations.push("Consider read replicas for search traffic.");
    recommendations.push("Implement memory TTL policies to cap active memory count.");
    recommendations.push("Shard by user_id if multi-tenant.");
  }

  return json({
    scale_tier: tier,
    counts: {
      memories: total,
      conversations: convCount.c,
      messages: msgCount.c,
      users: userCount.c,
    },
    storage: {
      db_size_mb: Math.round(dbSize / 1048576 * 100) / 100,
      embedding_cache_mb: cache.size_mb,
      estimated_row_size_bytes: total > 0 ? Math.round(dbSize / total) : 0,
    },
    performance: {
      avg_search_ms: cache.avg_search_ms,
      estimated_max_memories: cache.estimated_max_memories,
      headroom_pct: total > 0 ? Math.round((1 - total / cache.estimated_max_memories) * 100) : 100,
      jobs_pending: jobStats.pending || 0,
      jobs_failed: jobStats.failed || 0,
    },
    recommendations,
  });
}
```

**Acceptance criteria:**
- /health includes embedding_cache stats with search latency
- Warnings fire at 10K and 50K cached vectors, and when search > 200ms
- /metrics includes cache size and search latency gauges
- /admin/scale-report gives tier classification, headroom %, and actionable recommendations
- Recommendations change based on actual memory count and tenant count

---

### 8.2 Tiered Vector Search

**Problem:** `hybridSearch` does a full linear cosine scan over ALL cached embeddings for
the user. This is O(n) per query. At 50K+ memories per user, this dominates latency.
libsql already has a `libsql_vector_idx` on the `embedding_vec_*` columns, but hybridSearch
doesn't use it because the in-memory cache was faster at small scale.

**Goal:** Add an ANN (approximate nearest neighbor) pre-filter path that uses the native
libsql vector index for the top-K candidates, then re-scores with exact cosine for precision.
Keep the existing linear scan as a fallback for small datasets.

**Files to modify:**
- `src/memory/search.ts` (add ANN pre-filter path)
- `src/config/index.ts` (add threshold config)
- `src/embeddings/index.ts` (add ANN query function)

**Task 8.2.1: Add ANN search config**

In `src/config/index.ts`, add after the search config section (around line 106):

```typescript
// Scale: ANN pre-filter threshold. Below this count, use full linear scan.
// Above it, use libsql vector index for approximate top-K, then re-rank with exact cosine.
export const ANN_PREFILTER_THRESHOLD = Number(process.env.ENGRAM_ANN_THRESHOLD || 5000);
export const ANN_CANDIDATE_MULTIPLIER = Number(process.env.ENGRAM_ANN_CANDIDATES || 5); // fetch 5x limit from ANN, then re-rank
```

**Task 8.2.2: Add ANN query function**

In `src/embeddings/index.ts`, add:

```typescript
import { ANN_PREFILTER_THRESHOLD, ANN_CANDIDATE_MULTIPLIER } from "../config/index.ts";

const VECTOR_COL = `embedding_vec_${EMBEDDING_DIM}`;

/**
 * ANN pre-filter using libsql native vector index.
 * Returns candidate IDs with approximate distances, to be re-ranked with exact cosine.
 */
export function annSearch(queryEmbedding: Float32Array, userId: number, topK: number): number[] {
  const vecJson = embeddingToVectorJSON(queryEmbedding);
  const candidates = topK * ANN_CANDIDATE_MULTIPLIER;
  try {
    const rows = db.prepare(`
      SELECT id FROM memories
      WHERE ${VECTOR_COL} MATCH vector(?)
        AND k = ?
        AND user_id = ?
        AND is_forgotten = 0
        AND is_latest = 1
      ORDER BY distance
    `).all(vecJson, candidates, userId) as Array<{ id: number }>;
    return rows.map(r => r.id);
  } catch (e: any) {
    // Fallback: if the vector index isn't available, return empty (caller uses linear scan)
    log.warn({ msg: "ann_search_failed", error: e.message, fallback: "linear_scan" });
    return [];
  }
}

export function shouldUseANN(userId: number): boolean {
  const userCount = embeddingCacheLatest.filter(m => m.user_id === userId).length;
  return userCount >= ANN_PREFILTER_THRESHOLD;
}
```

NOTE: The exact SQL syntax for libsql vector search depends on the libsql version.
Check the actual syntax by looking at existing vector queries in the codebase. If the
codebase already has a vector search query pattern, follow that exact pattern. The
`MATCH vector(?) AND k = ?` syntax above is the libsql 0.4+ pattern. If the installed
version uses a different syntax, adapt accordingly.

**Task 8.2.3: Integrate ANN pre-filter into hybridSearch**

In `src/memory/search.ts`, find the vector search section of `hybridSearch()`. This is where
it iterates over `getCachedEmbeddings()` and computes cosine similarity. The current code
looks approximately like:

```typescript
const cached = getCachedEmbeddings(latestOnly, userId);
for (const mem of cached) {
  const sim = cosineSimilarity(queryEmb, mem.embedding);
  if (sim > vectorFloor) vectorRanked.push({ ...mem, score: sim });
}
```

Add the ANN path before the linear scan:

```typescript
import { shouldUseANN, annSearch } from "../embeddings/index.ts";

// In hybridSearch, before the linear scan:
let vectorRanked: ScoredMem[] = [];

if (shouldUseANN(userId)) {
  // ANN pre-filter: get approximate top-K from native vector index
  const annIds = annSearch(queryEmb, userId, candidateTarget);
  if (annIds.length > 0) {
    const annIdSet = new Set(annIds);
    const cached = getCachedEmbeddings(latestOnly, userId);
    // Re-rank ANN candidates with exact cosine similarity
    for (const mem of cached) {
      if (!annIdSet.has(mem.id)) continue;
      const sim = cosineSimilarity(queryEmb, mem.embedding);
      if (sim > vectorFloor) vectorRanked.push({ ...mem, score: sim });
    }
    log.debug({ msg: "ann_prefilter", candidates: annIds.length, passed: vectorRanked.length });
  }
}

// Fallback to linear scan if ANN didn't run or returned nothing
if (vectorRanked.length === 0) {
  const cached = getCachedEmbeddings(latestOnly, userId);
  for (const mem of cached) {
    const sim = cosineSimilarity(queryEmb, mem.embedding);
    if (sim > vectorFloor) vectorRanked.push({ ...mem, score: sim });
  }
}
```

**Acceptance criteria:**
- Below ANN_PREFILTER_THRESHOLD: existing linear scan behavior, zero change
- Above threshold: ANN pre-filter narrows candidates before exact cosine re-ranking
- If ANN index query fails (wrong libsql version, missing index), falls back to linear scan
- Search results are identical quality (ANN only affects candidate selection, final ranking is exact)
- Configurable via ENGRAM_ANN_THRESHOLD env var

---

### 8.3 Memory Archival & Cold Storage

**Problem:** All memories live in a single table regardless of age or access frequency.
Old, rarely-accessed memories still consume embedding cache RAM and slow down searches.

**Goal:** Add an archival tier where old, low-importance, rarely-accessed memories are
excluded from the active embedding cache but still searchable via FTS and ANN index.

**Files to modify:**
- `src/db/index.ts` (add archival status tracking)
- `src/embeddings/index.ts` (exclude cold memories from cache)
- `src/routes/index.ts` (add cold storage management endpoints)

**Task 8.3.1: Add cold storage config**

In `src/config/index.ts`:

```typescript
// Cold storage: memories not accessed in this many days are excluded from in-memory cache
// They remain in the DB and are searchable via FTS and ANN index, just not in the hot cache
export const COLD_STORAGE_DAYS = Number(process.env.ENGRAM_COLD_STORAGE_DAYS || 0); // 0 = disabled
export const COLD_STORAGE_MIN_MEMORIES = Number(process.env.ENGRAM_COLD_MIN || 5000); // Only activate if total > this
```

**Task 8.3.2: Modify embedding cache to respect cold storage**

In `src/embeddings/index.ts`, modify the `refreshEmbeddingCache()` function. Find where it
loads all memories with embeddings. Add a filter:

```typescript
import { COLD_STORAGE_DAYS, COLD_STORAGE_MIN_MEMORIES } from "../config/index.ts";

// In refreshEmbeddingCache():
let query = `SELECT * FROM memories WHERE embedding IS NOT NULL AND is_forgotten = 0`;

// If cold storage is enabled and we have enough memories, exclude cold ones from hot cache
if (COLD_STORAGE_DAYS > 0) {
  const totalCount = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE is_forgotten = 0").get() as any).c;
  if (totalCount >= COLD_STORAGE_MIN_MEMORIES) {
    query += ` AND (last_accessed_at > datetime('now', '-${COLD_STORAGE_DAYS} days') OR last_accessed_at IS NULL AND created_at > datetime('now', '-${COLD_STORAGE_DAYS} days'))`;
    log.info({ msg: "cold_storage_active", total: totalCount, threshold_days: COLD_STORAGE_DAYS });
  }
}
```

IMPORTANT: This changes which memories are in the hot cache, but cold memories are STILL
searchable via FTS (memories_fts doesn't filter by access time) and via ANN index (the
libsql vector index includes all rows). The impact is that cold memories won't appear in
the linear cosine scan, but will appear in FTS and ANN results.

**Task 8.3.3: Add cold storage stats**

Extend the `getEmbeddingCacheStats()` function:

```typescript
export function getEmbeddingCacheStats(): { ... cold_count: number; cold_size_mb: number } {
  // ... existing stats ...
  let coldCount = 0;
  if (COLD_STORAGE_DAYS > 0) {
    const result = db.prepare(
      `SELECT COUNT(*) as c FROM memories
       WHERE is_forgotten = 0 AND embedding IS NOT NULL
       AND last_accessed_at < datetime('now', '-' || ? || ' days')`
    ).get(COLD_STORAGE_DAYS) as any;
    coldCount = result?.c || 0;
  }
  return {
    // ... existing fields ...
    cold_count: coldCount,
    cold_size_mb: Math.round(coldCount * dimBytes / 1048576 * 100) / 100,
  };
}
```

**Task 8.3.4: Add /admin/cold-storage endpoint**

```typescript
if (url.pathname === "/admin/cold-storage" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);

  const total = db.prepare("SELECT COUNT(*) as c FROM memories WHERE is_forgotten = 0").get() as any;
  const withEmbedding = db.prepare("SELECT COUNT(*) as c FROM memories WHERE is_forgotten = 0 AND embedding IS NOT NULL").get() as any;

  // Access distribution (how many memories haven't been accessed in X days)
  const distribution = db.prepare(`
    SELECT
      CASE
        WHEN last_accessed_at IS NULL AND created_at < datetime('now', '-90 days') THEN 'never_accessed_90d+'
        WHEN last_accessed_at IS NULL AND created_at < datetime('now', '-30 days') THEN 'never_accessed_30d+'
        WHEN last_accessed_at IS NULL THEN 'never_accessed_recent'
        WHEN last_accessed_at < datetime('now', '-365 days') THEN 'cold_365d+'
        WHEN last_accessed_at < datetime('now', '-90 days') THEN 'cold_90d+'
        WHEN last_accessed_at < datetime('now', '-30 days') THEN 'cool_30d+'
        ELSE 'hot'
      END as tier,
      COUNT(*) as count
    FROM memories WHERE is_forgotten = 0
    GROUP BY tier ORDER BY count DESC
  `).all();

  const cacheStats = getEmbeddingCacheStats();

  return json({
    config: {
      cold_storage_days: COLD_STORAGE_DAYS,
      cold_min_memories: COLD_STORAGE_MIN_MEMORIES,
      enabled: COLD_STORAGE_DAYS > 0 && total.c >= COLD_STORAGE_MIN_MEMORIES,
    },
    totals: {
      all_memories: total.c,
      with_embedding: withEmbedding.c,
      in_hot_cache: cacheStats.total,
      in_cold_storage: cacheStats.cold_count,
    },
    distribution,
    recommendation: total.c > 10000 && COLD_STORAGE_DAYS === 0
      ? "Consider setting ENGRAM_COLD_STORAGE_DAYS=180 to reduce cache size by ~" +
        Math.round((distribution.find((d: any) => d.tier.includes("90d"))?.count || 0) / total.c * 100) + "%"
      : null,
  });
}
```

**Acceptance criteria:**
- `ENGRAM_COLD_STORAGE_DAYS=0` (default): no behavior change, all memories in hot cache
- `ENGRAM_COLD_STORAGE_DAYS=180`: memories not accessed in 180 days excluded from hot cache
- Cold memories still findable via FTS search and ANN index
- /admin/cold-storage shows access distribution and cache impact
- Cold storage only activates when total memories exceed ENGRAM_COLD_MIN

---

### 8.4 Search Index Partitioning

**Problem:** At 100K+ memories in multi-tenant mode, the single embedding cache serves all
tenants. A large tenant's search impacts cache pressure for all tenants.

**Goal:** Add per-user cache segmentation so each tenant's search only iterates over their
own embeddings, and a tenant hitting scale limits doesn't impact others.

**Files to modify:**
- `src/embeddings/index.ts` (partition cache by user_id)

**Task 8.4.1: Partition embedding cache by user_id**

In `src/embeddings/index.ts`, replace the flat array cache with a Map:

```typescript
// BEFORE:
let embeddingCache: CachedMem[] = [];
let embeddingCacheLatest: CachedMem[] = [];

// AFTER:
let embeddingCacheByUser = new Map<number, CachedMem[]>();
let embeddingCacheLatestByUser = new Map<number, CachedMem[]>();
// Keep flat arrays for admin operations (reembed, etc.)
let embeddingCacheAll: CachedMem[] = [];
let embeddingCacheLatestAll: CachedMem[] = [];
```

Update `refreshEmbeddingCache()` to populate both structures:

```typescript
export function refreshEmbeddingCache(): void {
  // ... existing query logic ...
  const all: CachedMem[] = [];
  const latest: CachedMem[] = [];

  for (const row of rows) {
    const mem = hydrateCachedMem(row);
    all.push(mem);
    if (mem.is_latest && !mem.is_forgotten) latest.push(mem);
  }

  // Flat arrays for admin ops
  embeddingCacheAll = all;
  embeddingCacheLatestAll = latest;

  // Partitioned by user
  embeddingCacheByUser.clear();
  embeddingCacheLatestByUser.clear();
  for (const mem of all) {
    const arr = embeddingCacheByUser.get(mem.user_id) || [];
    arr.push(mem);
    embeddingCacheByUser.set(mem.user_id, arr);
  }
  for (const mem of latest) {
    const arr = embeddingCacheLatestByUser.get(mem.user_id) || [];
    arr.push(mem);
    embeddingCacheLatestByUser.set(mem.user_id, arr);
  }
}
```

Update `getCachedEmbeddings()`:

```typescript
export function getCachedEmbeddings(latestOnly: boolean, userId?: number): CachedMem[] {
  if (userId != null) {
    const map = latestOnly ? embeddingCacheLatestByUser : embeddingCacheByUser;
    return map.get(userId) || [];
  }
  // Admin path: return all
  return latestOnly ? embeddingCacheLatestAll : embeddingCacheAll;
}
```

This is a transparent change. All callers already pass userId, so they'll get the partitioned
array. The Map lookup is O(1) instead of filtering the full array, which is a performance win
at any scale.

**Acceptance criteria:**
- getCachedEmbeddings with userId does O(1) Map lookup instead of O(n) array filter
- getCachedEmbeddings without userId (admin) still returns all embeddings
- refreshEmbeddingCache builds both flat and partitioned structures
- All existing search behavior unchanged
- Memory overhead is minimal (same data, just organized differently)

---

## PHASE 9: OpenAPI Spec & SDK Surface

### 9.1 OpenAPI Spec Generation

**Problem:** No machine-readable API documentation. SDK authors, third-party integrators, and
documentation tools have nothing to work with. The 100+ endpoints are only documented in code.

**Goal:** Generate an OpenAPI 3.1 spec from the existing route definitions. Serve it at
`GET /openapi.json`. This is NOT auto-generated from code analysis -- it's a hand-maintained
spec file that lives in the repo and is served by the server.

**Files to create:**
- `src/openapi.ts` (the spec object)

**Files to modify:**
- `src/routes/index.ts` (serve it)

**Task 9.1.1: Create the OpenAPI spec file**

Create `src/openapi.ts`. This is a NEW FILE (exception to the "no new files" rule because
the spec is too large to inline in routes).

The spec should cover the top 20 most important endpoints with full request/response schemas.
Do NOT try to document all 100+ endpoints at once. Start with the core memory API:

```typescript
import { PKG_VERSION } from "./config/index.ts";

export function getOpenAPISpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Engram Memory API",
      version: PKG_VERSION,
      description: "Cognitive memory server with semantic search, multi-tenant isolation, and intelligent features.",
      license: { name: "Source Available", url: "https://github.com/syntheos/engram" },
    },
    servers: [
      { url: "/", description: "Current instance" },
    ],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          description: "Returns server health. Unauthenticated: minimal response. Authenticated: full diagnostics.",
          tags: ["System"],
          responses: {
            "200": {
              description: "Server is healthy",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["ok"] },
                  version: { type: "string" },
                  memories: { type: "integer" },
                  embedded: { type: "integer" },
                  embedding_model: { type: "string" },
                  embedding_provider: { type: "string", enum: ["local", "google", "vertex"] },
                  llm_configured: { type: "boolean" },
                },
                required: ["status", "version"],
              }}},
            },
          },
        },
      },
      "/store": {
        post: {
          summary: "Store a memory",
          description: "Store a new memory. Automatically generates embedding, extracts facts, and creates similarity links.",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                content: { type: "string", description: "The memory content text", maxLength: 102400 },
                category: { type: "string", default: "general", description: "Memory category" },
                source: { type: "string", default: "unknown", description: "Origin agent or system" },
                importance: { type: "integer", minimum: 1, maximum: 10, default: 5 },
                tags: { type: "array", items: { type: "string" }, description: "Categorization tags" },
                session_id: { type: "string", description: "Group related memories by session" },
                confidence: { type: "number", minimum: 0, maximum: 1, default: 1.0 },
              },
              required: ["content"],
            }}},
          },
          responses: {
            "201": {
              description: "Memory stored successfully",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  created_at: { type: "string", format: "date-time" },
                  job_id: { type: "integer", description: "Background embedding job ID" },
                },
              }}},
            },
            "413": { description: "Content too large" },
            "429": { description: "Rate limit or quota exceeded" },
          },
        },
      },
      "/search": {
        post: {
          summary: "Search memories",
          description: "Hybrid semantic + keyword search with optional cross-encoder reranking. Automatically classifies query type (fact_recall, preference, reasoning, temporal) and applies appropriate search strategy.",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Natural language search query" },
                limit: { type: "integer", default: 10, maximum: 100 },
                include_links: { type: "boolean", default: false },
                expand_relationships: { type: "boolean", default: false },
                source: { type: "string", description: "Filter by source agent" },
                category: { type: "string", description: "Filter by category" },
                question_type: { type: "string", enum: ["fact_recall", "preference", "reasoning", "generalization", "temporal"] },
              },
              required: ["query"],
            }}},
          },
          responses: {
            "200": {
              description: "Search results ranked by relevance",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        content: { type: "string" },
                        category: { type: "string" },
                        source: { type: "string" },
                        importance: { type: "integer" },
                        score: { type: "number", description: "Combined relevance score" },
                        semantic_score: { type: "number" },
                        fts_score: { type: "number" },
                        created_at: { type: "string", format: "date-time" },
                        tags: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                  count: { type: "integer" },
                  question_type: { type: "string" },
                  reranked: { type: "boolean" },
                },
              }}},
            },
          },
        },
      },
      "/recall": {
        post: {
          summary: "Contextual recall",
          description: "Budget-aware memory retrieval for LLM context injection. Returns relevant memories within a token budget.",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                query: { type: "string" },
                budget: { type: "integer", default: 2000, description: "Maximum token budget for returned context" },
              },
              required: ["query"],
            }}},
          },
          responses: {
            "200": { description: "Context blob within token budget" },
          },
        },
      },
      "/context": {
        post: {
          summary: "Get LLM context",
          description: "Retrieve relevant context for an LLM conversation. Like /recall but returns structured context with metadata.",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                query: { type: "string" },
                budget: { type: "integer", default: 3000 },
              },
              required: ["query"],
            }}},
          },
          responses: { "200": { description: "Structured context with memories and metadata" } },
        },
      },
      "/list": {
        get: {
          summary: "List recent memories",
          description: "Paginated list of recent memories, newest first.",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "category", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Paginated memory list",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  memories: { type: "array", items: { type: "object" } },
                  total: { type: "integer" },
                  limit: { type: "integer" },
                  offset: { type: "integer" },
                  has_more: { type: "boolean" },
                },
              }}},
            },
          },
        },
      },
      "/memory/{id}": {
        get: {
          summary: "Get memory by ID",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": { description: "Memory details with version chain" },
            "404": { description: "Memory not found or access denied" },
          },
        },
        delete: {
          summary: "Delete memory",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": { description: "Memory deleted" },
            "404": { description: "Memory not found" },
          },
        },
      },
      "/conversations": {
        post: {
          summary: "Create conversation",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                agent: { type: "string" },
                session_id: { type: "string" },
                title: { type: "string" },
                messages: { type: "array", items: {
                  type: "object",
                  properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } },
                  required: ["role", "content"],
                }},
              },
            }}},
          },
          responses: { "201": { description: "Conversation created" } },
        },
        get: {
          summary: "List conversations",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "agent", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Paginated conversation list" } },
        },
      },
      "/export": {
        get: {
          summary: "Export user data",
          description: "Download all user memories, conversations, entities, and projects as portable JSON.",
          tags: ["Data"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "since", in: "query", schema: { type: "string", format: "date" }, description: "Only export memories created after this date" },
          ],
          responses: { "200": { description: "JSON export file" } },
        },
      },
      "/import/json": {
        post: {
          summary: "Import user data",
          description: "Import memories and conversations from a JSON export file.",
          tags: ["Data"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                version: { type: "string" },
                memories: { type: "array", items: { type: "object" } },
                conversations: { type: "array", items: { type: "object" } },
              },
              required: ["version", "memories"],
            }}},
          },
          responses: { "200": { description: "Import results with counts" } },
        },
      },
      "/backup": {
        get: {
          summary: "Download database backup",
          description: "Admin-only. Downloads a consistent SQLite snapshot of the entire database.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "SQLite database file", content: { "application/x-sqlite3": {} } },
            "403": { description: "Admin required" },
          },
        },
      },
      "/keys": {
        post: {
          summary: "Create API key",
          tags: ["Auth"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                scopes: { type: "string", default: "read,write", description: "Comma-separated: read,write,admin" },
                rate_limit: { type: "integer", default: 120 },
                user_id: { type: "integer", description: "Admin: create key for another user" },
                expires_at: { type: "string", format: "date-time", description: "Optional expiration" },
              },
            }}},
          },
          responses: {
            "201": {
              description: "API key created. The key value is only shown once.",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  key: { type: "string", description: "The API key (eg_...). Store securely, shown only once." },
                  id: { type: "integer" },
                },
              }}},
            },
          },
        },
      },
      "/metrics": {
        get: {
          summary: "Prometheus metrics",
          description: "Prometheus-compatible metrics endpoint. No auth required.",
          tags: ["System"],
          responses: { "200": { description: "Prometheus text format", content: { "text/plain": {} } } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Key (eg_...)",
          description: "API key from POST /keys or POST /bootstrap. Format: Bearer eg_xxxx...",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            request_id: { type: "string" },
          },
          required: ["error"],
        },
        Memory: {
          type: "object",
          properties: {
            id: { type: "integer" },
            content: { type: "string" },
            category: { type: "string" },
            source: { type: "string" },
            importance: { type: "integer", minimum: 1, maximum: 10 },
            tags: { type: "array", items: { type: "string" } },
            confidence: { type: "number" },
            version: { type: "integer" },
            is_latest: { type: "boolean" },
            is_static: { type: "boolean" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        PaginatedResponse: {
          type: "object",
          properties: {
            total: { type: "integer" },
            limit: { type: "integer" },
            offset: { type: "integer" },
            has_more: { type: "boolean" },
          },
        },
      },
    },
    tags: [
      { name: "System", description: "Health, metrics, and server status" },
      { name: "Memory", description: "Store, search, and manage memories" },
      { name: "Conversations", description: "Multi-turn conversation tracking" },
      { name: "Data", description: "Import, export, and data portability" },
      { name: "Auth", description: "API keys, users, and authentication" },
      { name: "Admin", description: "Backup, schema, tenant management" },
    ],
  };
}
```

**Task 9.1.2: Serve OpenAPI spec**

In `src/routes/index.ts`, add in the unauthenticated section (near /health, /live, /ready):

```typescript
import { getOpenAPISpec } from "../openapi.ts";

if (url.pathname === "/openapi.json" && method === "GET") {
  return new Response(JSON.stringify(getOpenAPISpec(), null, 2), {
    headers: securityHeaders({ "Content-Type": "application/json" }),
  });
}
```

**Acceptance criteria:**
- `GET /openapi.json` returns valid OpenAPI 3.1 spec
- Spec covers the 15+ most important endpoints with request/response schemas
- Spec includes security scheme (Bearer auth)
- Spec includes component schemas for Memory, Error, PaginatedResponse
- No auth required to fetch the spec
- Spec version matches PKG_VERSION dynamically

---

### 9.2 SDK Example Responses

**Problem:** New integrators don't know what the API returns without trial and error. The
OpenAPI spec helps, but concrete examples are more useful for SDK development.

**Goal:** Add example responses to the /health endpoint output so developers can see the
shape of data returned by key endpoints.

**Files to modify:**
- `src/routes/index.ts` (add /examples endpoint)

**Task 9.2.1: Add /api/examples endpoint**

```typescript
if (url.pathname === "/api/examples" && method === "GET") {
  return json({
    description: "Example request/response pairs for Engram API endpoints",
    examples: {
      "POST /store": {
        request: {
          content: "TypeScript is our primary language for all Syntheos products",
          category: "decision",
          source: "claude-code",
          importance: 8,
          tags: ["tech-stack", "typescript"],
        },
        response: {
          id: 1234,
          created_at: "2026-03-21T12:00:00Z",
          job_id: 567,
        },
      },
      "POST /search": {
        request: {
          query: "What programming language do we use?",
          limit: 5,
        },
        response: {
          results: [{
            id: 1234,
            content: "TypeScript is our primary language for all Syntheos products",
            category: "decision",
            source: "claude-code",
            importance: 8,
            score: 0.89,
            semantic_score: 0.92,
            fts_score: 0.85,
            created_at: "2026-03-21T12:00:00Z",
            tags: ["tech-stack", "typescript"],
          }],
          count: 1,
          question_type: "fact_recall",
          reranked: true,
        },
      },
      "POST /recall": {
        request: { query: "our tech stack", budget: 2000 },
        response: {
          context: "Based on 3 memories:\n- TypeScript is our primary language...",
          memories_used: 3,
          tokens_used: 450,
          budget: 2000,
        },
      },
      "POST /conversations": {
        request: {
          agent: "claude-code",
          title: "Debugging session",
          messages: [
            { role: "user", content: "Why is the build failing?" },
            { role: "assistant", content: "The TypeScript compiler found 3 errors..." },
          ],
        },
        response: {
          id: 89,
          agent: "claude-code",
          title: "Debugging session",
          started_at: "2026-03-21T12:00:00Z",
        },
      },
      "Authorization": {
        header: "Authorization: Bearer eg_a1b2c3d4e5f6...",
        note: "Get your key from POST /bootstrap (first setup) or POST /keys (admin creates more)",
      },
    },
  });
}
```

**Acceptance criteria:**
- `GET /api/examples` returns concrete request/response pairs
- Examples cover: store, search, recall, conversations, auth
- No auth required to fetch examples
- All example data is clearly synthetic (not real user data)

---

## PHASE 10: Admin Maintenance Tooling

### 10.1 Maintenance Mode

**Problem:** No way to put the server into a maintenance state where it rejects new writes
but allows reads and admin operations. Needed for: re-embedding, database compaction,
backup windows, and schema migrations on live systems.

**Files to modify:**
- `src/config/index.ts` (add maintenance state)
- `src/routes/index.ts` (add maintenance mode check)

**Task 10.1.1: Add maintenance mode state**

In `src/config/index.ts`:

```typescript
// Runtime state (not env vars -- toggled via API)
export let maintenanceMode = false;
export let maintenanceReason = "";

export function setMaintenanceMode(enabled: boolean, reason: string = "") {
  maintenanceMode = enabled;
  maintenanceReason = reason;
}
```

**Task 10.1.2: Add maintenance mode API**

In `src/routes/index.ts`:

```typescript
import { maintenanceMode, maintenanceReason, setMaintenanceMode } from "../config/index.ts";

if (url.pathname === "/admin/maintenance" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const body = await req.json().catch(() => ({})) as any;
  const enabled = !!body.enabled;
  const reason = String(body.reason || "").trim();
  setMaintenanceMode(enabled, reason);
  audit(auth.user_id, enabled ? "maintenance.start" : "maintenance.end", null, null, reason, clientIp, requestId);
  log.info({ msg: enabled ? "maintenance_mode_on" : "maintenance_mode_off", reason });
  return json({ maintenance: enabled, reason });
}

if (url.pathname === "/admin/maintenance" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  return json({ maintenance: maintenanceMode, reason: maintenanceReason });
}
```

**Task 10.1.3: Reject writes during maintenance**

In `src/routes/index.ts`, after auth is resolved and the OPEN_ACCESS check, add:

```typescript
if (maintenanceMode && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
  // Allow admin endpoints during maintenance
  if (!auth.is_admin) {
    return json({
      error: "Server is in maintenance mode" + (maintenanceReason ? `: ${maintenanceReason}` : ""),
      maintenance: true,
      retry_after: 300,
    }, 503, { "Retry-After": "300", "X-Request-Id": requestId });
  }
}
```

Also add maintenance status to /health response:

```typescript
// In the /health handler, add to the response object:
maintenance: maintenanceMode ? { active: true, reason: maintenanceReason } : undefined,
```

**Acceptance criteria:**
- `POST /admin/maintenance` with `{ enabled: true, reason: "re-embedding" }` activates maintenance
- During maintenance: all non-GET requests from non-admins get 503 with Retry-After
- During maintenance: admin endpoints still work (for running maintenance tasks)
- During maintenance: read endpoints still work for all users
- /health includes maintenance status
- Audit log records maintenance start/end

---

### 10.2 Rebuild & Reindex Commands

**Problem:** Several maintenance operations exist (/admin/reembed, /admin/rebuild-cooccurrences)
but there's no unified maintenance command center and missing operations like FTS rebuild,
embedding cache forced refresh, and database compaction.

**Files to modify:**
- `src/routes/index.ts` (add missing maintenance endpoints)

**Task 10.2.1: Add FTS rebuild endpoint**

```typescript
if (url.pathname === "/admin/rebuild-fts" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  try {
    const startMs = performance.now();
    // Drop and rebuild FTS index
    db.exec("DROP TABLE IF EXISTS memories_fts");
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content, category, source,
        content_rowid='id', tokenize='porter unicode61'
      )
    `);
    // Rebuild triggers
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category, source) VALUES (NEW.id, NEW.content, NEW.category, NEW.source);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category, source) VALUES('delete', OLD.id, OLD.content, OLD.category, OLD.source);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category, source) VALUES('delete', OLD.id, OLD.content, OLD.category, OLD.source);
        INSERT INTO memories_fts(rowid, content, category, source) VALUES (NEW.id, NEW.content, NEW.category, NEW.source);
      END
    `);
    // Populate from existing data
    db.exec("INSERT INTO memories_fts(rowid, content, category, source) SELECT id, content, category, source FROM memories WHERE is_forgotten = 0");
    const elapsedMs = Math.round(performance.now() - startMs);
    const count = (db.prepare("SELECT COUNT(*) as c FROM memories_fts").get() as any).c;
    audit(auth.user_id, "admin.rebuild_fts", null, null, `${count} rows in ${elapsedMs}ms`, clientIp, requestId);
    return json({ rebuilt: true, rows: count, elapsed_ms: elapsedMs });
  } catch (e: any) {
    return safeError("Rebuild FTS", e, 500, requestId);
  }
}
```

NOTE: Check the existing FTS trigger names in the codebase first. The trigger names above
(memories_ai, memories_ad, memories_au) come from the exploration. If they're different in
the actual code, use the actual names.

**Task 10.2.2: Add cache refresh endpoint**

```typescript
if (url.pathname === "/admin/refresh-cache" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const startMs = performance.now();
  refreshEmbeddingCache();
  const stats = getEmbeddingCacheStats();
  const elapsedMs = Math.round(performance.now() - startMs);
  audit(auth.user_id, "admin.refresh_cache", null, null, `${stats.total} vectors in ${elapsedMs}ms`, clientIp, requestId);
  return json({ refreshed: true, ...stats, elapsed_ms: elapsedMs });
}
```

**Task 10.2.3: Add database compact endpoint**

```typescript
if (url.pathname === "/admin/compact" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  try {
    const beforeSize = statSync(DB_PATH).size;
    const startMs = performance.now();

    // WAL checkpoint first
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // VACUUM to reclaim space and defragment
    db.exec("VACUUM");
    // Analyze to update query planner statistics
    db.exec("ANALYZE");

    const afterSize = statSync(DB_PATH).size;
    const elapsedMs = Math.round(performance.now() - startMs);
    const savedBytes = beforeSize - afterSize;

    audit(auth.user_id, "admin.compact", null, null,
      `before=${beforeSize} after=${afterSize} saved=${savedBytes} ms=${elapsedMs}`, clientIp, requestId);

    return json({
      compacted: true,
      before_size_mb: Math.round(beforeSize / 1048576 * 100) / 100,
      after_size_mb: Math.round(afterSize / 1048576 * 100) / 100,
      saved_mb: Math.round(savedBytes / 1048576 * 100) / 100,
      elapsed_ms: elapsedMs,
    });
  } catch (e: any) {
    return safeError("Compact", e, 500, requestId);
  }
}
```

**Task 10.2.4: Add maintenance tasks listing**

```typescript
if (url.pathname === "/admin/tasks" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  return json({
    available_tasks: [
      { endpoint: "POST /admin/reembed", description: "Re-embed all memories with current provider", destructive: false, slow: true },
      { endpoint: "POST /admin/rebuild-fts", description: "Drop and rebuild full-text search index", destructive: false, slow: true },
      { endpoint: "POST /admin/rebuild-cooccurrences", description: "Rebuild entity co-occurrence graph", destructive: false, slow: true },
      { endpoint: "POST /admin/detect-communities", description: "Run Louvain community detection on entity graph", destructive: false, slow: true },
      { endpoint: "POST /admin/backfill-facts", description: "Extract facts from memories missing structured facts", destructive: false, slow: true },
      { endpoint: "POST /admin/refresh-cache", description: "Force reload embedding cache from DB", destructive: false, slow: false },
      { endpoint: "POST /admin/compact", description: "VACUUM + ANALYZE the database to reclaim space", destructive: false, slow: true },
      { endpoint: "POST /admin/maintenance", description: "Toggle maintenance mode (rejects writes from non-admins)", destructive: false, slow: false },
      { endpoint: "GET /admin/schema", description: "View schema, migrations, and drift detection", destructive: false, slow: false },
      { endpoint: "GET /admin/scale-report", description: "Scale tier assessment with recommendations", destructive: false, slow: false },
      { endpoint: "GET /admin/cold-storage", description: "View memory access distribution and cold storage config", destructive: false, slow: false },
      { endpoint: "GET /admin/tenants", description: "View all tenants with usage statistics", destructive: false, slow: false },
      { endpoint: "GET /admin/providers", description: "View LLM/embedding provider configuration", destructive: false, slow: false },
      { endpoint: "GET /admin/quotas", description: "View tenant quotas", destructive: false, slow: false },
      { endpoint: "GET /jobs?status=failed", description: "View failed background jobs", destructive: false, slow: false },
      { endpoint: "POST /jobs/retry", description: "Retry a failed background job", destructive: false, slow: false },
      { endpoint: "POST /jobs/purge", description: "Delete old failed jobs", destructive: true, slow: false },
      { endpoint: "GET /backup", description: "Download full database backup", destructive: false, slow: true },
      { endpoint: "POST /backup/verify", description: "Run integrity checks on live database", destructive: false, slow: false },
      { endpoint: "POST /tenants/provision", description: "Create new tenant with user, space, and API key", destructive: false, slow: false },
      { endpoint: "POST /tenants/deprovision", description: "Delete all tenant data permanently", destructive: true, slow: true },
    ],
    maintenance_mode: { active: maintenanceMode, reason: maintenanceReason },
  });
}
```

**Acceptance criteria:**
- `POST /admin/rebuild-fts` drops and rebuilds the FTS5 index
- `POST /admin/refresh-cache` reloads embedding cache from DB
- `POST /admin/compact` runs VACUUM + ANALYZE with before/after size reporting
- `GET /admin/tasks` lists all available admin operations with descriptions
- All endpoints are admin-only with audit trail
- Slow operations report elapsed time

---

### 10.3 Garbage Collection

**Problem:** Soft-deleted memories (is_forgotten=1) stay in the DB forever. Orphaned links,
expired scratchpad entries, and old audit logs accumulate. No automated cleanup.

**Files to modify:**
- `src/routes/index.ts` (add GC endpoint)
- `server-split.ts` (add scheduled GC)

**Task 10.3.1: Add garbage collection endpoint**

```typescript
if (url.pathname === "/admin/gc" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const body = await req.json().catch(() => ({})) as any;
  const dryRun = body.dry_run !== false; // Default to dry run for safety

  const results: Record<string, number> = {};

  // 1. Forgotten memories older than 30 days
  const forgottenStale = db.prepare(
    `SELECT COUNT(*) as c FROM memories WHERE is_forgotten = 1 AND updated_at < datetime('now', '-30 days')`
  ).get() as any;
  results.forgotten_stale = forgottenStale.c;

  // 2. Orphaned memory links (source or target memory is forgotten/deleted)
  const orphanedLinks = db.prepare(
    `SELECT COUNT(*) as c FROM memory_links ml
     WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = ml.source_id AND m.is_forgotten = 0)
        OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = ml.target_id AND m.is_forgotten = 0)`
  ).get() as any;
  results.orphaned_links = orphanedLinks.c;

  // 3. Expired scratchpad entries
  const expiredScratch = db.prepare(
    `SELECT COUNT(*) as c FROM scratchpad WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`
  ).get() as any;
  results.expired_scratchpad = expiredScratch.c;

  // 4. Old audit log entries (> 90 days)
  const oldAudit = db.prepare(
    `SELECT COUNT(*) as c FROM audit_log WHERE created_at < datetime('now', '-90 days')`
  ).get() as any;
  results.old_audit_entries = oldAudit.c;

  // 5. Completed jobs older than 7 days (already handled by cleanupCompletedJobs but be explicit)
  const oldJobs = db.prepare(
    `SELECT COUNT(*) as c FROM jobs WHERE status IN ('completed', 'failed') AND completed_at < datetime('now', '-7 days')`
  ).get() as any;
  results.old_jobs = oldJobs.c;

  // 6. Orphaned personality signals (memory deleted)
  const orphanedSignals = db.prepare(
    `SELECT COUNT(*) as c FROM personality_signals ps
     WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = ps.memory_id)`
  ).get() as any;
  results.orphaned_signals = orphanedSignals.c;

  const totalReclaimable = Object.values(results).reduce((a, b) => a + b, 0);

  if (!dryRun) {
    db.exec(`DELETE FROM memories WHERE is_forgotten = 1 AND updated_at < datetime('now', '-30 days')`);
    db.exec(`DELETE FROM memory_links WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.source_id AND m.is_forgotten = 0) OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.target_id AND m.is_forgotten = 0)`);
    db.exec(`DELETE FROM scratchpad WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`);
    db.exec(`DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')`);
    db.exec(`DELETE FROM jobs WHERE status IN ('completed', 'failed') AND completed_at < datetime('now', '-7 days')`);
    db.exec(`DELETE FROM personality_signals WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = personality_signals.memory_id)`);

    refreshEmbeddingCache();
    audit(auth.user_id, "admin.gc", null, null, `deleted=${totalReclaimable}`, clientIp, requestId);
  }

  return json({
    dry_run: dryRun,
    reclaimable_rows: totalReclaimable,
    breakdown: results,
    message: dryRun ? "Run with { dry_run: false } to execute cleanup" : `Deleted ${totalReclaimable} rows`,
  });
}
```

**Task 10.3.2: Add scheduled GC**

In `server-split.ts`, add a daily GC run:

```typescript
// Daily garbage collection (4 AM local time offset, lease-protected)
setInterval(withLease("garbage_collection", async () => {
  const hour = new Date().getHours();
  if (hour !== 4) return; // Only run at 4 AM

  const forgotten = db.prepare("DELETE FROM memories WHERE is_forgotten = 1 AND updated_at < datetime('now', '-30 days')").run();
  const links = db.prepare("DELETE FROM memory_links WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.source_id AND m.is_forgotten = 0) OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.target_id AND m.is_forgotten = 0)").run();
  const scratch = db.prepare("DELETE FROM scratchpad WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
  const audit_old = db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')").run();

  const total = ((forgotten as any).changes || 0) + ((links as any).changes || 0) +
    ((scratch as any).changes || 0) + ((audit_old as any).changes || 0);

  if (total > 0) {
    refreshEmbeddingCache();
    log.info({ msg: "gc_completed", deleted: total });
  }
}), 60 * 60 * 1000); // Check every hour, runs at 4 AM
```

**Acceptance criteria:**
- `POST /admin/gc` with default `dry_run: true` shows what would be deleted
- `POST /admin/gc` with `dry_run: false` actually deletes stale data
- Targets: forgotten memories > 30 days, orphaned links, expired scratchpad,
  old audit logs > 90 days, old jobs > 7 days, orphaned personality signals
- Automatic daily GC runs at 4 AM (lease-protected for multi-instance)
- Embedding cache refreshed after deletions

---

## PHASE 11: Commercial Product Path

### 11.1 Usage Metering

**Problem:** No way to track per-tenant resource consumption over time. Needed for:
billing, usage reports, quota enforcement, and capacity planning.

**Files to modify:**
- `src/db/index.ts` (add usage_events table)
- `src/routes/index.ts` (add metering hooks and query endpoints)

**Task 11.1.1: Add usage metering table**

In `src/db/index.ts`:

```typescript
migrate(`
  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_usage_user_type ON usage_events(user_id, event_type, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
`);

export const recordUsage = db.prepare(
  `INSERT INTO usage_events (user_id, event_type, quantity, metadata) VALUES (?, ?, ?, ?)`
);

export const getUsageSummary = db.prepare(`
  SELECT event_type, SUM(quantity) as total, COUNT(*) as event_count
  FROM usage_events
  WHERE user_id = ? AND created_at > ?
  GROUP BY event_type
`);

export const getUsageTimeline = db.prepare(`
  SELECT date(created_at) as day, event_type, SUM(quantity) as total
  FROM usage_events
  WHERE user_id = ? AND created_at > ?
  GROUP BY day, event_type
  ORDER BY day DESC
`);

export const cleanupOldUsage = db.prepare(
  `DELETE FROM usage_events WHERE created_at < datetime('now', '-' || ? || ' days')`
);
```

**Task 11.1.2: Instrument key operations with metering**

Add `recordUsage` calls in the route handlers for billable operations. These should be
lightweight (single INSERT, no blocking). Add them at the END of successful operations,
not before.

Meter these events:

1. **memory.store** -- in the /store handler, after successful insert:
```typescript
recordUsage.run(auth.user_id, "memory.store", 1, null);
```

2. **memory.search** -- in the /search handler, after returning results:
```typescript
recordUsage.run(auth.user_id, "memory.search", 1, null);
```

3. **memory.recall** -- in the /recall handler:
```typescript
recordUsage.run(auth.user_id, "memory.recall", 1, null);
```

4. **embedding.compute** -- in the post_store job handler, after embedding completes:
```typescript
recordUsage.run(userId, "embedding.compute", 1, null);
```

5. **conversation.create** -- in the /conversations POST handler:
```typescript
recordUsage.run(auth.user_id, "conversation.create", 1, null);
```

6. **export.download** -- in the /export handler:
```typescript
recordUsage.run(auth.user_id, "export.download", 1, JSON.stringify({ memories: memories.length }));
```

Import `recordUsage` from `../db/index.ts` in routes/index.ts.

**Task 11.1.3: Add usage query endpoints**

```typescript
if (url.pathname === "/usage" && method === "GET") {
  // Users can see their own usage; admins can see any user's
  const targetUserId = auth.is_admin && url.searchParams.get("user_id")
    ? Number(url.searchParams.get("user_id"))
    : auth.user_id;
  const since = url.searchParams.get("since") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const summary = getUsageSummary.all(targetUserId, since);
  const timeline = getUsageTimeline.all(targetUserId, since);

  // Group timeline by day
  const timelineByDay: Record<string, Record<string, number>> = {};
  for (const row of timeline as any[]) {
    if (!timelineByDay[row.day]) timelineByDay[row.day] = {};
    timelineByDay[row.day][row.event_type] = row.total;
  }

  return json({
    user_id: targetUserId,
    period_start: since,
    summary,
    timeline: timelineByDay,
  });
}

// Admin aggregate usage
if (url.pathname === "/admin/usage" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  const since = url.searchParams.get("since") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const byUser = db.prepare(`
    SELECT u.username, ue.user_id, ue.event_type, SUM(ue.quantity) as total
    FROM usage_events ue
    JOIN users u ON u.id = ue.user_id
    WHERE ue.created_at > ?
    GROUP BY ue.user_id, ue.event_type
    ORDER BY total DESC
  `).all(since);

  const totals = db.prepare(`
    SELECT event_type, SUM(quantity) as total, COUNT(DISTINCT user_id) as unique_users
    FROM usage_events WHERE created_at > ?
    GROUP BY event_type ORDER BY total DESC
  `).all(since);

  return json({ period_start: since, totals, by_user: byUser });
}
```

**Task 11.1.4: Add usage cleanup to scheduled GC**

In the GC section (Task 10.3.2), add usage cleanup:

```typescript
// Keep usage events for 180 days
const usageResult = cleanupOldUsage.run(180);
```

**Acceptance criteria:**
- Every /store, /search, /recall, embedding, conversation create, and export is metered
- `GET /usage` shows user's own usage summary and daily timeline
- `GET /admin/usage` shows aggregate usage across all tenants
- Usage data retained for 180 days, auto-cleaned
- No measurable latency impact (single async INSERT per operation)

---

### 11.2 Tenant Onboarding Flow

**Problem:** Provisioning (Phase 4.1) creates the tenant, but there's no guided setup:
no welcome prompt, no initial configuration, no health check that verifies the tenant
can store and search.

**Files to modify:**
- `src/routes/index.ts` (add onboarding endpoint)

**Task 11.2.1: Add tenant onboarding verification**

```typescript
if (url.pathname === "/onboard" && method === "POST") {
  if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403, requestId);

  const checks: Record<string, { passed: boolean; detail: string }> = {};

  // 1. Can we store?
  try {
    const testMem = insertMemory.get(
      "Engram onboarding test memory -- safe to delete",
      "system", "onboarding", null, 1, null, 1.0, 0, auth.user_id, null
    ) as any;
    checks.store = { passed: true, detail: `Created test memory id=${testMem.id}` };

    // 2. Can we search?
    try {
      const results = await hybridSearch("onboarding test", 1, false, false, true, auth.user_id);
      checks.search = { passed: true, detail: `Search returned ${results.length} results` };
    } catch (e: any) {
      checks.search = { passed: false, detail: e.message };
    }

    // 3. Clean up test memory
    db.prepare("DELETE FROM memories WHERE id = ?").run(testMem.id);
    checks.cleanup = { passed: true, detail: "Test memory deleted" };
  } catch (e: any) {
    checks.store = { passed: false, detail: e.message };
  }

  // 4. Embedding status
  const embeddingReady = embeddingCacheLatest.length >= 0; // Worker spawned
  checks.embedding = { passed: embeddingReady, detail: embeddingReady ? "Embedding worker ready" : "Embedding worker not initialized" };

  // 5. Space exists
  const spaces = db.prepare("SELECT COUNT(*) as c FROM spaces WHERE user_id = ?").get(auth.user_id) as any;
  checks.spaces = { passed: spaces.c > 0, detail: `${spaces.c} space(s) configured` };

  const allPassed = Object.values(checks).every(c => c.passed);

  return json({
    status: allPassed ? "ready" : "issues_found",
    checks,
    next_steps: allPassed ? [
      "Store your first real memory: POST /store { content: '...' }",
      "Search for it: POST /search { query: '...' }",
      "Set up a webhook for events: POST /webhooks { url: '...', events: ['*'] }",
    ] : [
      "Fix the failed checks above, then run POST /onboard again",
    ],
  });
}
```

**Acceptance criteria:**
- `POST /onboard` runs a smoke test (store, search, cleanup)
- Returns pass/fail for each check with details
- Suggests next steps based on results
- Non-destructive (test memory is created and immediately deleted)

---

### 11.3 SLA Monitoring

**Problem:** No way to track whether the system is meeting performance targets. Commercial
customers need latency guarantees and uptime tracking.

**Files to modify:**
- `src/config/logger.ts` (add SLA tracking)
- `src/routes/index.ts` (add SLA endpoint)

**Task 11.3.1: Add SLA tracking counters**

In `src/config/logger.ts`, add to `opsCounters`:

```typescript
sla_search_under_200ms: 0,
sla_search_total: 0,
sla_store_under_500ms: 0,
sla_store_total: 0,
sla_errors_5xx: 0,
sla_period_start: Date.now(),
```

**Task 11.3.2: Instrument SLA tracking**

In `src/routes/index.ts`, in the /search handler, after computing elapsed time:

```typescript
opsCounters.sla_search_total++;
if (elapsed < 200) opsCounters.sla_search_under_200ms++;
```

In the /store handler, similarly:

```typescript
opsCounters.sla_store_total++;
if (elapsed < 500) opsCounters.sla_store_under_500ms++;
```

In the 5xx error catch block:

```typescript
opsCounters.sla_errors_5xx++;
```

**Task 11.3.3: Add /admin/sla endpoint**

```typescript
if (url.pathname === "/admin/sla" && method === "GET") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);

  const uptimeMs = Date.now() - opsCounters.sla_period_start;
  const uptimeHours = Math.round(uptimeMs / 3600000 * 10) / 10;

  const searchP200 = opsCounters.sla_search_total > 0
    ? Math.round(opsCounters.sla_search_under_200ms / opsCounters.sla_search_total * 10000) / 100
    : 100;
  const storeP500 = opsCounters.sla_store_total > 0
    ? Math.round(opsCounters.sla_store_under_500ms / opsCounters.sla_store_total * 10000) / 100
    : 100;
  const errorRate = opsCounters.request_count > 0
    ? Math.round(opsCounters.sla_errors_5xx / opsCounters.request_count * 10000) / 100
    : 0;

  return json({
    period: {
      start: new Date(opsCounters.sla_period_start).toISOString(),
      duration_hours: uptimeHours,
    },
    targets: {
      search_p95_under_200ms: { target: 95, actual: searchP200, met: searchP200 >= 95 },
      store_p95_under_500ms: { target: 95, actual: storeP500, met: storeP500 >= 95 },
      error_rate_under_1pct: { target: 1, actual: errorRate, met: errorRate < 1 },
    },
    raw: {
      total_requests: opsCounters.request_count,
      total_errors_5xx: opsCounters.sla_errors_5xx,
      search_total: opsCounters.sla_search_total,
      search_under_200ms: opsCounters.sla_search_under_200ms,
      store_total: opsCounters.sla_store_total,
      store_under_500ms: opsCounters.sla_store_under_500ms,
    },
    overall_health: searchP200 >= 95 && storeP500 >= 95 && errorRate < 1 ? "healthy" : "degraded",
  });
}
```

Also add SLA metrics to /metrics (Prometheus):

```typescript
"# HELP engram_sla_search_p200_pct Percentage of searches under 200ms",
"# TYPE engram_sla_search_p200_pct gauge",
`engram_sla_search_p200_pct ${searchP200}`,
"",
"# HELP engram_sla_error_rate_pct 5xx error rate percentage",
"# TYPE engram_sla_error_rate_pct gauge",
`engram_sla_error_rate_pct ${errorRate}`,
```

(Compute these values at /metrics render time using the same opsCounters.)

**Task 11.3.4: Add /admin/sla/reset**

```typescript
if (url.pathname === "/admin/sla/reset" && method === "POST") {
  if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
  opsCounters.sla_search_under_200ms = 0;
  opsCounters.sla_search_total = 0;
  opsCounters.sla_store_under_500ms = 0;
  opsCounters.sla_store_total = 0;
  opsCounters.sla_errors_5xx = 0;
  opsCounters.sla_period_start = Date.now();
  return json({ reset: true, new_period_start: new Date().toISOString() });
}
```

**Acceptance criteria:**
- `GET /admin/sla` shows target vs actual for search latency, store latency, and error rate
- SLA targets: 95% of searches under 200ms, 95% of stores under 500ms, error rate under 1%
- `POST /admin/sla/reset` resets the measurement period
- SLA metrics included in /metrics endpoint
- overall_health field gives quick pass/fail for monitoring

---

## IMPLEMENTATION ORDER

Execute phases in this order. Each phase is independently deployable.

1. **Phase 1** (Security) -- Blocks commercial deployment. Do first.
2. **Phase 2** (Reliability) -- Reduces operational risk.
3. **Phase 3** (Observability) -- Required for monitoring Phases 1-2 in production.
4. **Phase 7** (API Surface) -- Low risk, improves DX immediately.
5. **Phase 9** (OpenAPI & SDK) -- Unblocks integrators and SDK authors.
6. **Phase 4** (Multi-Tenant) -- Depends on Phase 1 auth hardening.
7. **Phase 5** (Data Portability) -- Depends on Phase 7 pagination consistency.
8. **Phase 6** (Migration Tooling) -- Safety net for all future changes.
9. **Phase 10** (Admin Tooling) -- Depends on Phase 3 observability.
10. **Phase 11** (Commercial Path) -- Depends on Phase 4 multi-tenant + Phase 3 metrics.
11. **Phase 8** (Scale) -- Last. Benefits from all prior observability and admin tooling.

## TESTING STRATEGY

After each phase:
1. Run existing tests: `ENGRAM_URL=http://127.0.0.1:4201 npm test`
2. Verify `GET /health` still returns `{ status: "ok" }`
3. Verify `GET /ready` returns `{ status: "ready" }`
4. Verify a store/search cycle works (POST /store then POST /search)
5. For auth changes: verify both authenticated and OPEN_ACCESS paths
6. For rate limiting: verify 429 is returned when limits are hit
7. For admin endpoints: verify 403 for non-admin users
8. For new endpoints: manually hit each one and verify response shape
9. For scale changes: verify search results are identical before/after

Do NOT create new test files. Do NOT add test frameworks. Do NOT modify the existing test file
unless a test is broken by your changes. The existing test at `tests/api.test.mjs` covers the
critical path.

## RULES FOR THE IMPLEMENTING AGENT

1. Do NOT refactor code you aren't changing
2. Do NOT add TypeScript type annotations to existing functions
3. Do NOT add JSDoc comments
4. Do NOT rename variables
5. Do NOT reorganize imports
6. Do NOT move code between files unless instructed
7. Do NOT add dependencies to package.json
8. Do NOT use em dashes anywhere (use -- or "to" or rephrase)
9. Do NOT create README files or documentation files
10. Do NOT add try/catch blocks that swallow errors silently (always log)
11. Follow existing patterns exactly: if the codebase uses `const x = db.prepare(...)`, do the same
12. If a prepared statement uses `.get()`, your new ones should too (not `.run()`) when returning data
13. Keep all SQL in prepared statements, never string interpolation with user data
14. Test after each phase, not at the end
15. If TypeScript compilation fails, fix it before moving on
16. If any endpoint returns the wrong status code in testing, fix it before moving on
17. The ONLY new file you may create is `src/openapi.ts` (Phase 9). Everything else goes in existing files.
18. When adding to routes/index.ts, place new admin endpoints near the existing /admin/* block
19. When modifying opsCounters, do NOT change the type of existing fields
20. For database migrations, always use the `migrate()` wrapper, never raw `db.exec()` for schema changes
