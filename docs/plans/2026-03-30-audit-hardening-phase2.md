# Audit Hardening Phase 2 Implementation Plan

**Goal:** Harden vector health/rebuild behavior, repair the broken `services/brain` TypeScript surface, and consolidate auth policy checks with broader regression coverage.

**Architecture:** Keep the work split by subsystem so each slice is independently testable and safe to parallelize. Vector hardening stays in `src/db/index.ts` with focused DB tests, `services/brain` gets a local type contract plus command fixes, and auth consolidation centralizes write-scope enforcement in reusable helpers instead of duplicating inline checks across route layers.

**Tech Stack:** TypeScript, Node test runner, existing route/auth helpers, SQLite/libSQL prepared statements

---

### Task 1: Vector Health Probe Hardening

**Files:**
- Modify: `src/db/index.ts`
- Test: `tests/db-vector-health.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("probeVectorHealth exercises vector operations and reports corruption failures", async () => {
  const dbModule = await import("../src/db/index.ts");
  const originalPrepare = dbModule.db.prepare;
  let vectorSqlSeen = false;

  dbModule.db.prepare = ((sql: string) => {
    if (sql.includes("libsql_vector_distance_cos")) vectorSqlSeen = true;
    const stmt = originalPrepare.call(dbModule.db, sql);
    if (sql.includes("libsql_vector_distance_cos")) {
      return {
        get() {
          throw Object.assign(new Error("malformed vector index"), { code: "SQLITE_CORRUPT_VTAB" });
        },
      } as any;
    }
    return stmt;
  }) as typeof dbModule.db.prepare;

  try {
    assert.equal(dbModule.probeVectorHealth(), false);
    assert.equal(vectorSqlSeen, true);
  } finally {
    dbModule.db.prepare = originalPrepare;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-isolation=none --test-force-exit tests\db-vector-health.test.ts`
Expected: FAIL because `probeVectorHealth()` still uses a scalar `UPDATE` and never touches vector SQL.

- [ ] **Step 3: Write minimal implementation**

```ts
const row = db.prepare(`SELECT id, embedding FROM memories WHERE ${VECTOR_COL} IS NOT NULL LIMIT 1`).get();
const probeVector = new Float32Array(Buffer.from(row.embedding as Buffer).buffer, ...);
db.prepare(`
  SELECT id
  FROM memories
  WHERE ${VECTOR_COL} IS NOT NULL
  ORDER BY libsql_vector_distance_cos(${VECTOR_COL}, vector(?))
  LIMIT 1
`).get(embeddingToVectorJSON(probeVector));
```

Also replace the offset-based rebuild repopulation loops with cursor-based `WHERE id > ? ORDER BY id LIMIT ?` scans so row skips or concurrent changes do not silently miss data.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-isolation=none --test-force-exit tests\db-vector-health.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/index.ts tests/db-vector-health.test.ts
git commit -m "fix: harden vector health checks"
```

### Task 2: Repair Services Brain Type Surface

**Files:**
- Create: `src/services/brain/types.ts`
- Modify: `src/services/brain/manager.ts`
- Modify: `src/services/brain/oracle.ts`
- Test: `tests/brain-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("brain modules import successfully", async () => {
  const manager = await import("../src/services/brain/manager.ts");
  const oracle = await import("../src/services/brain/oracle.ts");
  assert.equal(typeof manager.queryBrain, "function");
  assert.equal(typeof oracle.queryOracle, "function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-isolation=none --test-force-exit tests\brain-types.test.ts`
Expected: FAIL because `./types.ts` is missing and `dream_cycle` / `feedback_signal` / `evolution_train` are undefined.

- [ ] **Step 3: Write minimal implementation**

```ts
export type BrainCommand =
  | { cmd: "init"; db_path: string; data_dir: string }
  | { cmd: "query"; embedding: number[]; top_k?: number; beta?: number; spread_hops?: number }
  | { cmd: "absorb"; id: number; content: string; category: string; source: string; importance: number; created_at: string; embedding: number[]; tags?: string[] }
  | { cmd: "decay_tick"; ticks: number }
  | { cmd: "get_stats" }
  | { cmd: "shutdown" }
  | { cmd: "dream_cycle" }
  | { cmd: "feedback_signal"; memory_ids: number[]; edge_pairs: [number, number][]; useful: boolean }
  | { cmd: "evolution_train" };
```

In `manager.ts`, replace the invalid bare identifiers with string literals:

```ts
return sendCommand({ cmd: "dream_cycle" });
return sendCommand({ cmd: "feedback_signal", memory_ids: memoryIds, edge_pairs: edgePairs, useful });
return sendCommand({ cmd: "evolution_train" });
```

Define the `BrainQueryResult`, `BrainStats`, `BrainResponse`, and `OracleResult` interfaces tightly enough for both modules and `tsc`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-isolation=none --test-force-exit tests\brain-types.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: `services/brain/*` errors removed.

- [ ] **Step 5: Commit**

```bash
git add src/services/brain/types.ts src/services/brain/manager.ts src/services/brain/oracle.ts tests/brain-types.test.ts
git commit -m "fix: restore brain module typings"
```

### Task 3: Consolidate Write-Scope Enforcement

**Files:**
- Modify: `src/middleware/auth.ts`
- Modify: `src/skills/routes.ts`
- Modify: `src/services/chiasm/routes.ts`
- Modify: `src/services/axon/routes.ts`
- Modify: `src/services/soma/routes.ts`
- Modify: `src/services/thymus/routes.ts`
- Modify: `src/routes/index.ts`
- Test: `tests/audit-regressions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("all audited mutating endpoints share the same write-scope policy", async () => {
  for (const path of ["/tasks", "/axon/publish", "/soma/agents", "/thymus/rubrics", "/skills/upload"]) {
    const res = await app.fetch(new Request(`http://engram.local${path}`, { method: "POST" }));
    assert.equal(res.status, 403, path);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-isolation=none --test-force-exit tests\audit-regressions.test.ts`
Expected: FAIL once helpers are switched but not yet wired everywhere.

- [ ] **Step 3: Write minimal implementation**

Add a shared helper in `src/middleware/auth.ts`:

```ts
export function requireWriteScope(auth: AuthResult | null): Response | null {
  if (!auth || !hasScope(auth, "write")) {
    return errorResponse("Write scope required", 403);
  }
  return null;
}
```

Use that helper from the modular service routes, skills routes, and the monolith route definitions so the same policy gate is applied in both route stacks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-isolation=none --test-force-exit tests\audit-regressions.test.ts tests\skills.test.ts tests\middleware-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/middleware/auth.ts src/skills/routes.ts src/services/chiasm/routes.ts src/services/axon/routes.ts src/services/soma/routes.ts src/services/thymus/routes.ts src/routes/index.ts tests/audit-regressions.test.ts
git commit -m "refactor: centralize write scope checks"
```

### Task 4: Final Verification

**Files:**
- Test: `tests/audit-regressions.test.ts`
- Test: `tests/db-vector-health.test.ts`
- Test: `tests/brain-types.test.ts`
- Test: `tests/db-connection.test.ts`

- [ ] **Step 1: Run targeted regression suite**

Run: `node --test --test-isolation=none --test-force-exit tests\audit-regressions.test.ts tests\db-vector-health.test.ts tests\brain-types.test.ts tests\db-connection.test.ts`
Expected: PASS

- [ ] **Step 2: Run broader verification**

Run: `node --test --test-isolation=none --test-force-exit tests\skills.test.ts tests\middleware-auth.test.ts tests\small-domains.test.ts`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 4: Review changed files**

Run: `git diff -- src/db/index.ts src/services/brain src/middleware/auth.ts src/routes/index.ts tests`
Expected: only the planned hardening, repair, and test changes

- [ ] **Step 5: Commit**

```bash
git add src/db/index.ts src/services/brain src/middleware/auth.ts src/routes/index.ts tests
git commit -m "test: verify audit hardening phase 2"
```
