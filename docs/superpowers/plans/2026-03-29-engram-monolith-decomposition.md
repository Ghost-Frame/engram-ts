# Engram Monolith Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose Engram's 105K-line monolith into domain modules following the ingestion pipeline template, with a lightweight router, distributed DB queries, and per-domain tests.

**Architecture:** Extract the 8,410-line route handler and 2,244-line DB monolith into ~22 domain modules. Each domain gets types, routes, business logic, DB queries, and tests. A lightweight custom router handles dispatch. Foundation layer (router, middleware, DB connection) is built first, then domains are extracted in parallel waves.

**Tech Stack:** TypeScript (Node 22, --experimental-strip-types), libsql, node:test, native HTTP server

---

## File Structure

### Foundation (new files)

```
src/db/connection.ts        - DB connection, pragmas, schema, migrations (extracted from src/db/index.ts)
src/router/index.ts         - Lightweight router with path params, middleware, grouping
src/router/types.ts         - Router type definitions
src/middleware/auth.ts       - Auth middleware (wraps existing src/auth/index.ts)
src/middleware/validate.ts   - Request body parsing and validation helpers
src/middleware/audit.ts      - Audit logging middleware
server.ts                   - New entry point wiring router + domains
```

### Domain modules (one per domain, extracted from src/routes/index.ts + src/db/index.ts)

Each domain follows this pattern:
```
src/<domain>/
  types.ts    - Interfaces, constants
  db.ts       - Prepared statements and query functions
  index.ts    - Business logic
  routes.ts   - Route registration (thin handlers)
```

Domains: memory, search, episodes, graph, projects, intelligence, tier4, context, pack, conversations, auth-keys, admin, fsrs, webhooks, agents, scratch, skills, inbox, health, prompts, guard, docs

### Tests

```
tests/router.test.ts              - Router unit tests
tests/middleware-auth.test.ts     - Auth middleware tests
tests/<domain>.test.ts            - Per-domain unit tests
tests/api.test.mjs                - Existing integration test (kept as-is)
```

---

## Foundation

### Task 1: Extract DB Connection

**Files:**
- Create: `src/db/connection.ts`
- Modify: `src/db/index.ts`
- Test: `tests/db-connection.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db-connection.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("db connection", () => {
  it("exports a working db instance", async () => {
    const { db } = await import("../src/db/connection.ts");
    assert.ok(db, "db should be exported");
    const row = db.prepare("SELECT 1 as val").get() as { val: number };
    assert.equal(row.val, 1);
  });

  it("exports getSchemaVersion function", async () => {
    const { getSchemaVersion } = await import("../src/db/connection.ts");
    assert.equal(typeof getSchemaVersion, "function");
    const version = getSchemaVersion();
    assert.equal(typeof version, "number");
    assert.ok(version >= 0);
  });

  it("exports migrate function", async () => {
    const { migrate } = await import("../src/db/connection.ts");
    assert.equal(typeof migrate, "function");
  });

  it("has WAL journal mode", async () => {
    const { db } = await import("../src/db/connection.ts");
    const row = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    assert.equal(row[0].journal_mode, "wal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/db-connection.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Create src/db/connection.ts**

Extract from `src/db/index.ts` lines 1-43 (imports, connection setup, pragmas, integrity check) plus the schema creation (lines 45-93) and migration system. The file should:

1. Import Database from libsql
2. Import config values (DB_PATH, DATA_DIR, EMBEDDING_DIM)
3. Import logger
4. Export `embeddingToVectorJSON` function (lines 13-23)
5. Create and export `db` instance with all pragmas (lines 27-32)
6. Run integrity check (lines 34-42)
7. Execute schema creation SQL (lines 45-93 and all subsequent CREATE TABLE/INDEX statements)
8. Export `getSchemaVersion()` and `migrate()` functions (the migration system)
9. Export the `withWriteLock` function

Read `src/db/index.ts` fully to identify all schema DDL and migration code. Everything that is NOT a prepared statement or query function goes into connection.ts.

- [ ] **Step 4: Update src/db/index.ts to import from connection.ts**

Change `src/db/index.ts` to import `db` from `./connection.ts` instead of creating it locally. Remove the duplicated connection setup, schema DDL, and migration code. Keep all prepared statements and query functions - they will be distributed to domains in later tasks.

```typescript
// src/db/index.ts -- top becomes:
import { db, embeddingToVectorJSON, getSchemaVersion, migrate, withWriteLock } from "./connection.ts";
export { db, embeddingToVectorJSON, getSchemaVersion, migrate, withWriteLock };

// ... all prepared statements and query functions remain here for now ...
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/db-connection.test.ts`
Expected: PASS

- [ ] **Step 6: Verify existing tests still pass**

Run: `node --experimental-strip-types --test tests/ingestion-*.test.ts`
Expected: 163 tests PASS (ingestion module imports from db/index.ts which now re-exports from connection.ts)

- [ ] **Step 7: Commit**

```bash
git add src/db/connection.ts src/db/index.ts tests/db-connection.test.ts
git commit -m "$(cat <<'EOF'
refactor(db): extract connection setup to src/db/connection.ts

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Build Lightweight Router

**Files:**
- Create: `src/router/types.ts`
- Create: `src/router/index.ts`
- Test: `tests/router.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/router.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Router", () => {
  it("exports createRouter function", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    assert.equal(typeof createRouter, "function");
  });

  it("matches GET route", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    let called = false;
    router.get("/health", async () => {
      called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const req = new Request("http://localhost/health", { method: "GET" });
    const res = await router.handle(req);
    assert.ok(called, "handler should have been called");
    assert.equal(res.status, 200);
  });

  it("matches POST route", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    router.post("/store", async () => {
      return new Response("stored", { status: 201 });
    });
    const req = new Request("http://localhost/store", { method: "POST" });
    const res = await router.handle(req);
    assert.equal(res.status, 201);
  });

  it("extracts path parameters", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    let capturedParams: Record<string, string> = {};
    router.get("/memory/:id", async (_req, params) => {
      capturedParams = params;
      return new Response("ok");
    });
    const req = new Request("http://localhost/memory/42", { method: "GET" });
    await router.handle(req);
    assert.equal(capturedParams.id, "42");
  });

  it("extracts multiple path parameters", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    let capturedParams: Record<string, string> = {};
    router.put("/entities/:eid/memories/:mid", async (_req, params) => {
      capturedParams = params;
      return new Response("ok");
    });
    const req = new Request("http://localhost/entities/5/memories/10", { method: "PUT" });
    await router.handle(req);
    assert.equal(capturedParams.eid, "5");
    assert.equal(capturedParams.mid, "10");
  });

  it("returns 404 for unmatched route", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    const req = new Request("http://localhost/nope", { method: "GET" });
    const res = await router.handle(req);
    assert.equal(res.status, 404);
  });

  it("runs middleware in order", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    const order: number[] = [];
    router.use(async (_req, _params, next) => {
      order.push(1);
      return next();
    });
    router.use(async (_req, _params, next) => {
      order.push(2);
      return next();
    });
    router.get("/test", async () => {
      order.push(3);
      return new Response("ok");
    });
    const req = new Request("http://localhost/test", { method: "GET" });
    await router.handle(req);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it("middleware can short-circuit", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    let handlerCalled = false;
    router.use(async () => {
      return new Response("blocked", { status: 403 });
    });
    router.get("/test", async () => {
      handlerCalled = true;
      return new Response("ok");
    });
    const req = new Request("http://localhost/test", { method: "GET" });
    const res = await router.handle(req);
    assert.equal(res.status, 403);
    assert.ok(!handlerCalled);
  });

  it("supports route grouping with prefix", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    router.group("/admin", (r) => {
      r.get("/stats", async () => new Response("stats"));
      r.post("/reembed", async () => new Response("reembed"));
    });
    const req1 = new Request("http://localhost/admin/stats", { method: "GET" });
    const res1 = await router.handle(req1);
    assert.equal(res1.status, 200);
    const body = await res1.text();
    assert.equal(body, "stats");
  });

  it("matches routes with query strings", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    router.get("/search", async () => new Response("found"));
    const req = new Request("http://localhost/search?q=test&limit=10", { method: "GET" });
    const res = await router.handle(req);
    assert.equal(res.status, 200);
  });

  it("supports DELETE and PATCH methods", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    router.delete("/memory/:id", async () => new Response("deleted"));
    router.patch("/memory/:id", async () => new Response("patched"));
    const req1 = new Request("http://localhost/memory/1", { method: "DELETE" });
    const res1 = await router.handle(req1);
    assert.equal(await res1.text(), "deleted");
    const req2 = new Request("http://localhost/memory/1", { method: "PATCH" });
    const res2 = await router.handle(req2);
    assert.equal(await res2.text(), "patched");
  });

  it("handles OPTIONS for CORS preflight", async () => {
    const { createRouter } = await import("../src/router/index.ts");
    const router = createRouter();
    router.get("/test", async () => new Response("ok"));
    const req = new Request("http://localhost/test", { method: "OPTIONS" });
    const res = await router.handle(req);
    assert.equal(res.status, 204);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/router.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Create src/router/types.ts**

```typescript
// src/router/types.ts
export type Params = Record<string, string>;

export type Handler = (
  req: Request,
  params: Params,
) => Promise<Response>;

export type Middleware = (
  req: Request,
  params: Params,
  next: () => Promise<Response>,
) => Promise<Response>;

export interface Route {
  method: string;
  pattern: string;
  segments: string[];
  paramNames: string[];
  handler: Handler;
}

export interface Router {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  put(path: string, handler: Handler): void;
  patch(path: string, handler: Handler): void;
  delete(path: string, handler: Handler): void;
  use(middleware: Middleware): void;
  group(prefix: string, fn: (router: Router) => void): void;
  handle(req: Request): Promise<Response>;
}
```

- [ ] **Step 4: Create src/router/index.ts**

```typescript
// src/router/index.ts
import type { Handler, Middleware, Params, Route, Router } from "./types.ts";
export type { Handler, Middleware, Params, Router } from "./types.ts";

import { securityHeaders } from "../helpers/index.ts";

function compilePath(pattern: string): { segments: string[]; paramNames: string[] } {
  const segments = pattern.split("/").filter(Boolean);
  const paramNames: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith(":")) paramNames.push(seg.slice(1));
  }
  return { segments, paramNames };
}

function matchRoute(route: Route, method: string, pathSegments: string[]): Params | null {
  if (route.method !== method) return null;
  if (route.segments.length !== pathSegments.length) return null;
  const params: Params = {};
  for (let i = 0; i < route.segments.length; i++) {
    const routeSeg = route.segments[i];
    const pathSeg = pathSegments[i];
    if (routeSeg.startsWith(":")) {
      params[routeSeg.slice(1)] = decodeURIComponent(pathSeg);
    } else if (routeSeg !== pathSeg) {
      return null;
    }
  }
  return params;
}

export function createRouter(): Router {
  const routes: Route[] = [];
  const middlewares: Middleware[] = [];

  function addRoute(method: string, pattern: string, handler: Handler, prefix = ""): void {
    const fullPattern = prefix + pattern;
    const { segments, paramNames } = compilePath(fullPattern);
    routes.push({ method, pattern: fullPattern, segments, paramNames, handler });
  }

  const router: Router = {
    get: (path, handler) => addRoute("GET", path, handler),
    post: (path, handler) => addRoute("POST", path, handler),
    put: (path, handler) => addRoute("PUT", path, handler),
    patch: (path, handler) => addRoute("PATCH", path, handler),
    delete: (path, handler) => addRoute("DELETE", path, handler),

    use: (mw) => middlewares.push(mw),

    group: (prefix, fn) => {
      const grouped: Router = {
        get: (path, handler) => addRoute("GET", path, handler, prefix),
        post: (path, handler) => addRoute("POST", path, handler, prefix),
        put: (path, handler) => addRoute("PUT", path, handler, prefix),
        patch: (path, handler) => addRoute("PATCH", path, handler, prefix),
        delete: (path, handler) => addRoute("DELETE", path, handler, prefix),
        use: router.use,
        group: (subPrefix, subFn) => router.group(prefix + subPrefix, subFn),
        handle: router.handle,
      };
      fn(grouped);
    },

    handle: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();

      // CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: securityHeaders() });
      }

      const pathSegments = url.pathname.split("/").filter(Boolean);

      // Find matching route
      let matched: { route: Route; params: Params } | null = null;
      for (const route of routes) {
        const params = matchRoute(route, method, pathSegments);
        if (params !== null) {
          matched = { route, params };
          break;
        }
      }

      if (!matched) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const { route, params } = matched;

      // Build middleware chain
      let idx = 0;
      const next = async (): Promise<Response> => {
        if (idx < middlewares.length) {
          const mw = middlewares[idx++];
          return mw(req, params, next);
        }
        return route.handler(req, params);
      };

      return next();
    },
  };

  return router;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/router.test.ts`
Expected: 12 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/router/types.ts src/router/index.ts tests/router.test.ts
git commit -m "$(cat <<'EOF'
feat(router): add lightweight router with path params and middleware

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Auth Middleware

**Files:**
- Create: `src/middleware/auth.ts`
- Test: `tests/middleware-auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/middleware-auth.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("auth middleware", () => {
  it("exports createAuthMiddleware function", async () => {
    const mod = await import("../src/middleware/auth.ts");
    assert.equal(typeof mod.createAuthMiddleware, "function");
  });

  it("exports parseBody helper", async () => {
    const mod = await import("../src/middleware/auth.ts");
    assert.equal(typeof mod.parseBody, "function");
  });

  it("exports getClientIp helper", async () => {
    const mod = await import("../src/middleware/auth.ts");
    assert.equal(typeof mod.getClientIp, "function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/middleware-auth.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Create src/middleware/auth.ts**

This middleware wraps the existing `src/auth/index.ts` functions. It:
1. Parses the request body (JSON, respects MAX_BODY_SIZE)
2. Extracts client IP from X-Forwarded-For or socket
3. Generates a request ID (X-Request-Id header or UUID)
4. Runs authentication (authenticate or getAuthOrDefault)
5. Attaches auth context, body, URL, clientIp, requestId to the request via a WeakMap
6. Returns 401/429 for auth errors

```typescript
// src/middleware/auth.ts
import { randomUUID } from "crypto";
import { MAX_BODY_SIZE, ALLOWED_IPS, maintenanceMode, maintenanceReason } from "../config/index.ts";
import { getAuthOrDefault, isAuthError, type AuthContext, type AuthError } from "../auth/index.ts";
import { json, errorResponse, securityHeaders } from "../helpers/index.ts";
import { opsCounters } from "../config/logger.ts";
import type { Middleware, Params } from "../router/types.ts";

// WeakMap to attach parsed context to requests without modifying the Request object
export interface RequestContext {
  auth: AuthContext;
  body: unknown;
  url: URL;
  method: string;
  clientIp: string;
  requestId: string;
  requestStart: number;
}

const contextMap = new WeakMap<Request, RequestContext>();

export function getContext(req: Request): RequestContext {
  const ctx = contextMap.get(req);
  if (!ctx) throw new Error("Request context not initialized -- auth middleware not applied");
  return ctx;
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "127.0.0.1";
}

export async function parseBody(req: Request): Promise<unknown> {
  if (req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS") return {};
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_SIZE) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function hasScope(auth: AuthContext, scope: string): boolean {
  return auth.scopes.includes("all") || auth.scopes.includes(scope) || auth.scopes.includes("admin");
}

export function canAccessOwnedRow(row: { user_id?: number } | null | undefined, auth: AuthContext): boolean {
  return !!row && (row.user_id === auth.user_id || auth.is_admin);
}

export function createAuthMiddleware(
  guiAuthed: (req: Request) => boolean,
): Middleware {
  return async (req: Request, _params: Params, next: () => Promise<Response>): Promise<Response> => {
    const requestStart = Date.now();
    opsCounters.request_count++;

    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const clientIp = getClientIp(req);
    const requestId = req.headers.get("x-request-id") || randomUUID();

    // IP allowlist check
    if (ALLOWED_IPS.length > 0 && !ALLOWED_IPS.includes(clientIp)) {
      return errorResponse("Forbidden", 403, requestId);
    }

    // Maintenance mode
    if (maintenanceMode && url.pathname !== "/health" && url.pathname !== "/live") {
      return json({ error: "Service in maintenance", reason: maintenanceReason }, 503);
    }

    // Parse body
    const body = await parseBody(req);

    // Authenticate
    const authResult = getAuthOrDefault(req, guiAuthed);
    if (isAuthError(authResult)) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if ((authResult as AuthError).headers) Object.assign(headers, (authResult as AuthError).headers);
      return new Response(JSON.stringify({ error: authResult.error }), {
        status: authResult.status,
        headers: securityHeaders(headers),
      });
    }
    if (!authResult) {
      return errorResponse("Unauthorized", 401, requestId);
    }

    // Attach context
    contextMap.set(req, {
      auth: authResult,
      body,
      url,
      method,
      clientIp,
      requestId,
      requestStart,
    });

    const response = await next();

    // Track latency
    const duration = Date.now() - requestStart;
    opsCounters.request_latency_sum_ms += duration;

    return response;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/middleware-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/middleware/auth.ts tests/middleware-auth.test.ts
git commit -m "$(cat <<'EOF'
feat(middleware): add auth middleware with request context

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Validation Helpers

**Files:**
- Create: `src/middleware/validate.ts`
- Test: `tests/middleware-validate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/middleware-validate.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("validation helpers", () => {
  it("exports requireString", async () => {
    const { requireString } = await import("../src/middleware/validate.ts");
    assert.equal(typeof requireString, "function");
  });

  it("requireString returns value for valid string", async () => {
    const { requireString } = await import("../src/middleware/validate.ts");
    assert.equal(requireString("hello", "field"), "hello");
  });

  it("requireString throws for empty string", async () => {
    const { requireString } = await import("../src/middleware/validate.ts");
    assert.throws(() => requireString("", "field"), { message: /field is required/ });
  });

  it("requireString throws for non-string", async () => {
    const { requireString } = await import("../src/middleware/validate.ts");
    assert.throws(() => requireString(123 as any, "field"), { message: /field must be a string/ });
  });

  it("optionalInt returns parsed int or default", async () => {
    const { optionalInt } = await import("../src/middleware/validate.ts");
    assert.equal(optionalInt("42", 10), 42);
    assert.equal(optionalInt(undefined, 10), 10);
    assert.equal(optionalInt("abc", 10), 10);
  });

  it("clampInt clamps to range", async () => {
    const { clampInt } = await import("../src/middleware/validate.ts");
    assert.equal(clampInt(5, 1, 10), 5);
    assert.equal(clampInt(0, 1, 10), 1);
    assert.equal(clampInt(100, 1, 10), 10);
  });

  it("requireBody returns validated body fields", async () => {
    const { requireBody } = await import("../src/middleware/validate.ts");
    const body = { name: "test", count: 5 };
    const result = requireBody(body, ["name"]);
    assert.equal(result.name, "test");
  });

  it("requireBody throws for missing required fields", async () => {
    const { requireBody } = await import("../src/middleware/validate.ts");
    assert.throws(() => requireBody({}, ["name"]), { message: /name is required/ });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/middleware-validate.test.ts`
Expected: FAIL

- [ ] **Step 3: Create src/middleware/validate.ts**

```typescript
// src/middleware/validate.ts

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") throw new ValidationError(`${fieldName} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ValidationError(`${fieldName} is required`);
  return trimmed;
}

export function optionalString(value: unknown, fallback: string = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim() || fallback;
}

export function optionalInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function requireBody(body: unknown, requiredFields: string[]): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body is required");
  }
  const obj = body as Record<string, unknown>;
  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new ValidationError(`${field} is required`);
    }
  }
  return obj;
}

export function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string").map(t => t.trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map(t => t.trim()).filter(Boolean);
  return [];
}

export function parseIdFromPath(pathname: string, position: number): number | null {
  const segments = pathname.split("/").filter(Boolean);
  const raw = segments[position];
  if (!raw) return null;
  const id = parseInt(raw, 10);
  return Number.isInteger(id) ? id : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/middleware-validate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/middleware/validate.ts tests/middleware-validate.test.ts
git commit -m "$(cat <<'EOF'
feat(middleware): add request validation helpers

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Audit Middleware

**Files:**
- Create: `src/middleware/audit.ts`
- Test: `tests/middleware-audit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/middleware-audit.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("audit middleware", () => {
  it("exports auditLog function", async () => {
    const mod = await import("../src/middleware/audit.ts");
    assert.equal(typeof mod.auditLog, "function");
  });

  it("exports emitEvent function", async () => {
    const mod = await import("../src/middleware/audit.ts");
    assert.equal(typeof mod.emitEvent, "function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/middleware-audit.test.ts`
Expected: FAIL

- [ ] **Step 3: Create src/middleware/audit.ts**

Extract the `audit()` function from `src/db/index.ts` and the `emitWebhookEvent` wrapper. This centralizes the two cross-cutting concerns that are scattered across 30+ routes.

```typescript
// src/middleware/audit.ts
import { db } from "../db/connection.ts";
import { log } from "../config/logger.ts";

const insertAudit = db.prepare(
  `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details, ip_address)
   VALUES (?, ?, ?, ?, ?, ?)`
);

export function auditLog(
  userId: number,
  action: string,
  resourceType: string,
  resourceId: number | string | null,
  details: string | null,
  ip: string,
): void {
  try {
    insertAudit.run(userId, action, resourceType, resourceId, details, ip);
  } catch (e: any) {
    log.warn({ msg: "audit_log_failed", action, error: e?.message });
  }
}

// Lightweight event emitter for webhook triggers
// Delegates to platform/webhooks.ts but provides a simpler interface for domain modules
type EventPayload = Record<string, unknown>;
let webhookEmitter: ((userId: number, event: string, payload: EventPayload) => void) | null = null;

export function setWebhookEmitter(fn: (userId: number, event: string, payload: EventPayload) => void): void {
  webhookEmitter = fn;
}

export function emitEvent(userId: number, event: string, payload: EventPayload): void {
  if (webhookEmitter) {
    try { webhookEmitter(userId, event, payload); } catch {}
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/middleware-audit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/middleware/audit.ts tests/middleware-audit.test.ts
git commit -m "$(cat <<'EOF'
feat(middleware): add audit logging and event emission

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: New Server Entry Point

**Files:**
- Create: `server.ts` (new entry point)
- Test: manual verification

This task creates the new server entry point that wires the router, middleware, and domain routes together. Initially it mounts NO domain routes - those are added as each domain is extracted in subsequent tasks. For now, it only handles health/live/ready so we can verify the server boots.

- [ ] **Step 1: Create server.ts**

```typescript
#!/usr/bin/env -S node --experimental-strip-types
// ============================================================================
// ENGRAM SERVER v6 -- Modular entry point
// ============================================================================

import "./src/tracing.ts";
import { createServer } from "http";

import { PORT, HOST, PKG_VERSION, CORS_ORIGIN, OPEN_ACCESS } from "./src/config/index.ts";
import { log } from "./src/config/logger.ts";
import { createRouter } from "./src/router/index.ts";
import { createAuthMiddleware } from "./src/middleware/auth.ts";
import { setWebhookEmitter } from "./src/middleware/audit.ts";
import { securityHeaders, json } from "./src/helpers/index.ts";

// Database (importing triggers schema creation + migrations)
import { db } from "./src/db/connection.ts";

// Embeddings
import { initEmbedder, embed, isEmbedderReady, refreshEmbeddingCache, embeddingCacheLatest } from "./src/embeddings/index.ts";
import { initReranker } from "./src/reranker/index.ts";
import { isLLMAvailable } from "./src/llm/index.ts";

// GUI
import { reloadGuiHtml, guiAuthed } from "./src/gui/index.ts";

// Webhooks
import { emitWebhookEvent } from "./src/platform/webhooks.ts";

// Wire webhook emitter into middleware
setWebhookEmitter((userId, event, payload) => emitWebhookEvent(userId, event, payload));

// ============================================================================
// INITIALIZATION
// ============================================================================

await initEmbedder();
await initReranker();

// WAL checkpoint at startup
try {
  const result = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
  const r = result[0] || {};
  log.info({ msg: "wal_checkpoint", busy: r.busy, log: r.log, checkpointed: r.checkpointed });
} catch (e: any) {
  log.warn({ msg: "wal_checkpoint_failed", error: e.message });
}

// Pre-warm embeddings
{
  refreshEmbeddingCache();
  await embed("warmup");
  log.info({ msg: "warmup_complete", cache_size: embeddingCacheLatest.length });
}

// ============================================================================
// ROUTER
// ============================================================================

const router = createRouter();

// Auth middleware (skipped for health probes below)
router.use(createAuthMiddleware(guiAuthed));

// --- Health routes (no auth needed, registered before auth middleware applies) ---
// NOTE: These are registered first. The auth middleware runs for all routes,
// but health/live endpoints should work without auth. We handle this by
// checking the path in the auth middleware and skipping auth for these paths.
// TODO: Add pre-auth route support to router in a future iteration.

// --- Domain routes will be registered here as each domain is extracted ---
// Example (after Task 7):
//   import { registerRoutes as memoryRoutes } from "./src/memory/routes.ts";
//   memoryRoutes(router);

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = createServer(async (req, res) => {
  try {
    const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const host = req.headers.host || `${HOST}:${PORT}`;
    const url = `${protocol}://${host}${req.url || "/"}`;
    const request = new Request(url, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v!])
      ),
      body: req.method !== "GET" && req.method !== "HEAD"
        ? await new Promise<Buffer>((resolve) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => resolve(Buffer.concat(chunks)));
          })
        : undefined,
      duplex: "half",
    } as any);

    const response = await router.handle(request);

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const body = await response.arrayBuffer();
    res.end(Buffer.from(body));
  } catch (e: any) {
    log.error({ msg: "unhandled_error", error: e.message, stack: e.stack?.split("\n")[1]?.trim() });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, HOST, () => {
  log.info({
    msg: "server_started",
    version: PKG_VERSION,
    host: HOST,
    port: PORT,
    open_access: OPEN_ACCESS,
    cors: CORS_ORIGIN,
  });
});
```

- [ ] **Step 2: Verify server boots**

Run: `node --experimental-strip-types server.ts`
Expected: Server starts, logs `server_started` with version and port. Ctrl+C to stop.

Note: The server won't serve domain routes yet - those are added in subsequent tasks. Health/live/ready will return 404 until the health domain is extracted (Task 26) or we add them as pre-auth routes.

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "$(cat <<'EOF'
feat: add new modular server entry point

Wires router + auth middleware. Domain routes added incrementally
as each domain is extracted from the monolith.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Domain Extraction Pattern

Every domain extraction task (Tasks 7-27) follows this pattern. Each subagent should:

1. **Read the source**: Open `src/routes/index.ts` at the specified line ranges. Open `src/db/index.ts` and find the prepared statements referenced by those routes.

2. **Create the domain directory**: `src/<domain>/`

3. **Extract types** (`types.ts`): Any interfaces, type aliases, or constants specific to this domain.

4. **Extract DB queries** (`db.ts`): Move prepared statements from `src/db/index.ts` to the domain's `db.ts`. Import `db` from `../db/connection.ts`. Update `src/db/index.ts` to re-export from the domain's `db.ts` (temporary, so other code that still imports from db/index.ts keeps working).

5. **Extract business logic** (`index.ts`): Move algorithmic code out of route handlers into pure functions. These functions take typed inputs and return typed outputs - no Request/Response objects.

6. **Create thin route handlers** (`routes.ts`): Import `getContext` from middleware/auth.ts, call business logic, return Response via `json()` helper. Register with `router.get/post/etc`.

7. **Write tests**: Test the business logic functions directly (unit tests). Test route handlers with the router (integration-lite).

8. **Wire into server.ts**: Add the import and `registerRoutes(router)` call.

9. **Update src/db/index.ts**: Remove moved prepared statements (or re-export from domain db.ts for backward compat during migration).

10. **Verify**: Run domain tests + existing api.test.mjs + ingestion tests.

11. **Commit**: One commit per domain.

---

## Wave 1: Core

These three domains form the heart of Engram. Extract sequentially or in parallel (they don't depend on each other, only on Foundation).

### Task 7: Memory Domain

**Source lines:** `src/routes/index.ts` lines 3231-3600 (store, CRUD, health, tags, forget, archive, correct, feedback)
**DB statements to extract:** insertMemory, getMemory, listRecent, listByCategory, markForgotten, markArchived, markUnarchived, markSuperseded, getVersionChain, getVersionChainForUser, updateMemoryEmbedding, updateMemoryVec, getAllTags, getByTag, countNoEmbedding, countNoEmbeddingForUser, getNoEmbeddingForUser, getMemoryWithoutEmbedding, deleteMemory, getQuota, upsertQuota, getUserMemoryCount, recordUsage

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/db.ts`
- Create: `src/memory/store.ts` (the store pipeline: validate, quota, dedup, embed, insert, link, cache, enqueue)
- Create: `src/memory/routes.ts`
- Existing: `src/memory/search.ts` (already extracted, keep as-is)
- Existing: `src/memory/simhash.ts` (already extracted, keep as-is)
- Existing: `src/memory/profile.ts` (already extracted, keep as-is)
- Test: `tests/memory.test.ts`

**Routes to register:**
```
POST   /store, /memory, /memories     -> storeMemory
GET    /list                          -> listMemories
GET    /memory/:id                    -> getMemoryById
DELETE /memory/:id                    -> deleteMemoryById
POST   /memory/:id/update            -> updateMemory
POST   /memory/:id/forget            -> forgetMemory
POST   /memory/:id/archive           -> archiveMemory
POST   /memory/:id/unarchive         -> unarchiveMemory
PUT    /memory/:id/tags              -> updateTags
POST   /correct                      -> correctMemory
POST   /feedback                     -> submitFeedback
GET    /feedback/stats               -> feedbackStats
GET    /memory-health                -> memoryHealth
GET    /duplicates                   -> listDuplicates
POST   /deduplicate                  -> deduplicateMemories
POST   /backfill                     -> backfillEmbeddings
```

**Key business logic to extract into store.ts:**
- SimHash deduplication check (before embedding)
- Embedding generation with chunking fallback
- Episode auto-creation if session_id + source present
- Quota enforcement (memory count + size limits)
- Tag normalization (array or CSV -> JSON)
- Importance clamping (1-10)
- Entity/project linking with ownership validation
- Cooccurrence graph update
- FSRS initialization + decay score
- SimHash storage
- Embedding cache population
- Post-store job enqueueing

**Test expectations:**
```typescript
// tests/memory.test.ts
describe("memory types", () => {
  it("exports StoreOptions interface check via runtime enum/const");
});
describe("memory store pipeline", () => {
  it("normalizes tags from CSV string to array");
  it("clamps importance to 1-10 range");
  it("rejects empty content");
  it("rejects content exceeding MAX_CONTENT_SIZE");
});
describe("memory routes", () => {
  it("exports registerRoutes function");
});
```

- [ ] Read source lines, extract types, DB queries, business logic, routes
- [ ] Write tests for extracted business logic
- [ ] Run tests: `node --experimental-strip-types --test tests/memory.test.ts`
- [ ] Wire into server.ts: `import { registerRoutes as memoryRoutes } from "./src/memory/routes.ts"; memoryRoutes(router);`
- [ ] Verify existing tests pass: `node --experimental-strip-types --test tests/ingestion-*.test.ts`
- [ ] Commit: `git commit -m "refactor(memory): extract memory domain from monolith"`

---

### Task 8: Search Domain

**Source lines:** `src/routes/index.ts` lines 3830-4012 (search), 4304-4450 (recall), 5433-5510 (decay)
**DB statements to extract:** updateDecayScores, updateFSRS, getFSRS, getFSRSForUser, trackAccessWithFSRS
**Existing module:** `src/memory/search.ts` (hybridSearch, autoLink - already extracted)

**Files:**
- Create: `src/search/types.ts`
- Create: `src/search/db.ts`
- Create: `src/search/index.ts` (search mode presets, recall layer stacking, result dedup)
- Create: `src/search/routes.ts`
- Test: `tests/search.test.ts`

**Routes to register:**
```
POST   /search, /memories/search     -> searchMemories
POST   /recall                       -> recallMemories
POST   /decay/refresh                -> refreshDecay
GET    /decay/scores                 -> decayScores
```

**Key business logic to extract:**
- Search mode presets (fact/timeline/preference/decision/recent) with different vector_floor, limits, temporal sort
- Cross-encoder reranking integration + LLM fallback reranking
- Recall 5-layer stacking: static (capped 25%) + semantic + important + recent + tags
- Cosine similarity dedup at response time
- Decay score multiplier for semantic results
- Episode expansion on recalled results
- FSRS access tracking (deferred to setTimeout)

**Test expectations:**
```typescript
describe("search mode presets", () => {
  it("exports SEARCH_MODES with fact/timeline/preference/decision/recent");
  it("each mode has vector_floor, limit, and temporal_sort");
});
describe("recall layer builder", () => {
  it("exports buildRecallLayers function");
  it("caps static memories at 25% of limit");
});
describe("search routes", () => {
  it("exports registerRoutes function");
});
```

- [ ] Read source lines, extract types, DB queries, business logic, routes
- [ ] Write tests
- [ ] Run tests
- [ ] Wire into server.ts
- [ ] Verify existing tests pass
- [ ] Commit: `git commit -m "refactor(search): extract search and recall domain from monolith"`

---

### Task 9: Episodes Domain

**Source lines:** `src/routes/index.ts` lines 4948-5165 (episodes CRUD + finalize)
**DB statements to extract:** insertEpisode, getEpisode, getEpisodeForUser, getEpisodeBySession, getEpisodeMemories, listEpisodes, assignToEpisode, updateEpisode, updateEpisodeEmbedding, updateEpisodeVec, searchEpisodesFTS, listEpisodesByTimeRange, updateEpisodeForUser, assignToEpisodeForUser

**Files:**
- Create: `src/episodes/types.ts`
- Create: `src/episodes/db.ts`
- Create: `src/episodes/index.ts` (episode lifecycle, auto-create, finalize with LLM summary)
- Create: `src/episodes/routes.ts`
- Test: `tests/episodes.test.ts`

**Routes to register:**
```
POST   /episodes                     -> createEpisode
GET    /episodes                     -> listEpisodes
GET    /episodes/:id                 -> getEpisodeById
PATCH  /episodes/:id                 -> updateEpisode
POST   /episodes/:id/memories/:mid   -> assignMemoryToEpisode
POST   /episodes/:id/finalize        -> finalizeEpisode
```

**Key business logic to extract:**
- Episode auto-creation when session_id + source provided during memory store
- Finalization: LLM summary generation from conversation/memories
- Temporal bounds calculation (started_at, ended_at, duration_seconds)
- Episode embedding generation (from summary/title/conversation)

**Test expectations:**
```typescript
describe("episodes", () => {
  it("exports calculateDuration that computes seconds between timestamps");
  it("exports registerRoutes function");
});
```

- [ ] Read source lines, extract types, DB queries, business logic, routes
- [ ] Write tests
- [ ] Run tests
- [ ] Wire into server.ts
- [ ] Verify existing tests pass
- [ ] Commit: `git commit -m "refactor(episodes): extract episodes domain from monolith"`

---

## Wave 2: Knowledge

Depends on Wave 1 (graph references memories, intelligence references search/episodes).

### Task 10: Graph and Entities Domain

**Source lines:** `src/routes/index.ts` lines 6219-6420 (graph), 6425-6760 (entities + relationships + facts)
**DB statements to extract:** insertEntity, listEntities, listEntitiesByType, getEntity, getEntityForUser, getEntityMemories, getEntityRelationships, updateEntity, deleteEntity, linkMemoryEntity, unlinkMemoryEntity, searchEntities, insertEntityRelationship, deleteEntityRelationship, getAllMemoriesForGraph, getAllLinksForGraph
**Existing modules:** `src/graph/structural.ts`, `src/graph/cooccurrence.ts`, `src/graph/communities.ts`, `src/graph/pagerank.ts` (keep as-is)

**Files:**
- Create: `src/graph/types.ts`
- Create: `src/graph/db.ts`
- Create: `src/graph/routes.ts`
- Create: `src/graph/builder.ts` (BFS traversal, batch fetch, node/edge building, cache)
- Existing: `src/graph/structural.ts`, `cooccurrence.ts`, `communities.ts`, `pagerank.ts` (already separate)
- Test: `tests/graph.test.ts`

**Routes to register:**
```
GET    /graph                        -> getGraph
GET    /graph/raw                    -> getGraphRaw
GET    /graph/view                   -> getGraphView
POST   /entities                     -> createEntity
GET    /entities                     -> listEntities
GET    /entities/:id                 -> getEntityById
PUT    /entities/:id                 -> updateEntity
DELETE /entities/:id                 -> deleteEntity
PUT    /entities/:eid/memories/:mid  -> linkEntityMemory
DELETE /entities/:eid/memories/:mid  -> unlinkEntityMemory
POST   /entities/:id/relationships   -> createRelationship
DELETE /entities/:id/relationships   -> deleteRelationship
POST   /entities/:id/search          -> searchEntityMemories
GET    /entities/:id/cooccurrences   -> getCooccurrences
GET    /facts                        -> listFacts
```

**Key business logic to extract into builder.ts:**
- BFS frontier expansion with visited tracking
- Batch link fetching (900-id chunks for SQLite bind limit)
- Node sizing by importance + pagerank_score
- 30-second response cache
- Graph JSON construction (vis.js compatible)

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(graph): extract graph and entities domain from monolith"`

---

### Task 11: Projects Domain

**Source lines:** `src/routes/index.ts` lines 6568-6700
**DB statements to extract:** insertProject, listProjects, listProjectsByStatus, getProject, getProjectForUser, getProjectMemories, updateProject, deleteProject, linkMemoryProject, unlinkMemoryProject

**Files:**
- Create: `src/projects/types.ts`
- Create: `src/projects/db.ts`
- Create: `src/projects/index.ts`
- Create: `src/projects/routes.ts`
- Test: `tests/projects.test.ts`

**Routes to register:**
```
POST   /projects                     -> createProject
GET    /projects                     -> listProjects
GET    /projects/:id                 -> getProjectById
PUT    /projects/:id                 -> updateProject
DELETE /projects/:id                 -> deleteProject
PUT    /projects/:id/memories/:mid   -> linkProjectMemory
DELETE /projects/:id/memories/:mid   -> unlinkProjectMemory
POST   /projects/:id/search          -> searchProjectMemories
```

Simple CRUD domain. Minimal business logic.

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(projects): extract projects domain from monolith"`

---

### Task 12: Intelligence Domain

**Source lines:** `src/routes/index.ts` lines 2980-3230 (reflect, reflections, digests), 2104-2340 (contradictions, timetravel), 5396-5430 (consolidate)
**Existing modules:** `src/intelligence/temporal.ts`, `personality.ts`, `extraction.ts`, `consolidation.ts` (keep as-is)

**Files:**
- Create: `src/intelligence/types.ts`
- Create: `src/intelligence/db.ts`
- Create: `src/intelligence/routes.ts`
- Create: `src/intelligence/reflect.ts` (reflection generation logic)
- Create: `src/intelligence/contradictions.ts` (detection + resolution)
- Existing: `temporal.ts`, `personality.ts`, `extraction.ts`, `consolidation.ts` (keep)
- Test: `tests/intelligence.test.ts`

**Routes to register:**
```
POST   /reflect                      -> generateReflection
GET    /reflections                   -> listReflections
GET    /contradictions                -> detectContradictions
POST   /contradictions/resolve       -> resolveContradiction
POST   /timetravel                   -> timeTravel
POST   /consolidate                  -> consolidateMemories
GET    /consolidations               -> listConsolidations
POST   /digests                      -> createDigest
GET    /digests                      -> listDigests
```

**Key business logic to extract:**
- Reflection generation: period parsing, LLM prompt, theme extraction
- Contradiction detection: find opposed claims on same topic
- Contradiction resolution: LLM arbiter, mark loser as superseded
- Version chain traversal for time travel

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(intelligence): extract intelligence domain from monolith"`

---

### Task 13: Tier4 Wiring

**Source lines:** No routes in routes/index.ts (tier4 is called internally). Just wire existing `src/tier4/` modules into the router if any routes need exposure.
**Existing modules:** `src/tier4/causal.ts`, `reconsolidation.ts`, `predictive.ts`, `valence.ts`

**Files:**
- Create: `src/tier4/routes.ts` (only if there are routes to expose)
- Modify: `src/tier4/` as needed
- Test: `tests/tier4.test.ts`

Check `src/routes/index.ts` for any routes that call tier4 functions. If none exist as standalone routes (they're triggered by post_store jobs), this task is just verifying the existing tier4 modules work with the new db/connection.ts import path.

- [ ] Verify tier4 modules import db correctly (may need to update imports)
- [ ] Write minimal test that tier4 exports are available
- [ ] Commit: `git commit -m "refactor(tier4): verify tier4 modules with new db connection"`

---

## Wave 3: Integration

These domains compose from Wave 1+2 domains.

### Task 14: Context Assembly Domain

**Source lines:** `src/routes/index.ts` lines 2456-2980 (context endpoint - the most complex single route)

**Files:**
- Create: `src/context/types.ts`
- Create: `src/context/index.ts` (progressive disclosure algorithm, token budget, layer assembly)
- Create: `src/context/routes.ts`
- Test: `tests/context.test.ts`

**Routes to register:**
```
POST   /context                      -> assembleContext
```

**Key business logic to extract:**
- Progressive disclosure: 8 layers (static, recent, semantic, episodes, linked, working memory, personality, inference)
- Token budget management per layer
- Cosine similarity dedup (O(N^2) worst case)
- Sentence boundary truncation
- Per-layer token accounting
- Depth parameter (1-3) controls how many layers are included

This is 150+ lines of algorithmic logic. Extract it ALL into `src/context/index.ts` as a pure function `assembleContext(query, auth, options) -> ContextResult`.

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(context): extract context assembly domain from monolith"`

---

### Task 15: Pack Domain

**Source lines:** `src/routes/index.ts` lines 5510-5600 (pack endpoint)

**Files:**
- Create: `src/pack/index.ts` (greedy knapsack packing algorithm)
- Create: `src/pack/routes.ts`
- Test: `tests/pack.test.ts`

**Routes to register:**
```
POST   /pack                         -> packMemories
```

**Key business logic:** Greedy token budget packing. Select from static + semantic + important memories. Format choices: text/json/xml.

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(pack): extract pack domain from monolith"`

---

### Task 16: Conversations Domain

**Source lines:** `src/routes/index.ts` lines 4616-4945
**DB statements to extract:** insertConversation, getConversation, getConversationForUser, getConversationBySession, listConversations, listConversationsByAgent, touchConversation, updateConversation, deleteConversation, insertMessage, getMessages, searchMessages, bulkInsertConvo

**Files:**
- Create: `src/conversations/types.ts`
- Create: `src/conversations/db.ts`
- Create: `src/conversations/index.ts`
- Create: `src/conversations/routes.ts`
- Test: `tests/conversations.test.ts`

**Routes to register:**
```
POST   /conversations                -> createConversation
GET    /conversations                -> listConversations
GET    /conversations/:id            -> getConversation
PATCH  /conversations/:id            -> updateConversation
DELETE /conversations/:id            -> deleteConversation
POST   /conversations/:id/messages   -> addMessage
POST   /conversations/bulk           -> bulkInsert
POST   /conversations/upsert         -> upsertConversations
POST   /messages/search              -> searchMessages
```

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(conversations): extract conversations domain from monolith"`

---

### Task 17: Ingestion Wiring

**Source lines:** `src/routes/index.ts` lines 1703-2100 (/add, /ingest), 5884-6130 (/derive, imports), 6132-6200 (/import/bulk)
**Existing module:** `src/ingestion/` (already extracted in v5.12.0)

This task moves the remaining ingestion-related route handlers into the existing `src/ingestion/` module. The `/add`, `/ingest`, `/derive`, `/import/mem0`, `/import/supermemory`, `/import/json` routes currently live in the monolith.

**Files:**
- Modify: `src/ingestion/routes.ts` (create if not exists, add all ingestion route handlers)
- Test: existing ingestion tests + new route tests

**Routes to register:**
```
POST   /add                          -> addFromConversation
POST   /ingest                       -> ingestUrl
POST   /derive                       -> deriveEntities
POST   /import/mem0                  -> importMem0
POST   /import/supermemory           -> importSupermemory
POST   /import/bulk                  -> importBulk
POST   /import/json                  -> importJson
```

- [ ] Read source, extract route handlers, wire, verify existing 163 ingestion tests still pass
- [ ] Commit: `git commit -m "refactor(ingestion): move remaining ingestion routes from monolith"`

---

## Wave 4: Platform

Mostly independent CRUD domains. Can be extracted in parallel batches.

### Task 18: Auth and Keys Domain

**Source lines:** `src/routes/index.ts` lines 483-570 (gui auth), 572-770 (bootstrap, users, keys, spaces)
**Existing module:** `src/auth/index.ts` (keep as-is, it handles the auth logic)

**Files:**
- Create: `src/auth-keys/types.ts`
- Create: `src/auth-keys/db.ts`
- Create: `src/auth-keys/routes.ts`
- Test: `tests/auth-keys.test.ts`

**Routes to register:**
```
POST   /gui/auth                     -> guiLogin
GET    /gui/logout                   -> guiLogout
POST   /bootstrap                    -> bootstrap
POST   /users                        -> createUser
GET    /users                        -> listUsers
POST   /keys                         -> createKey
GET    /keys                         -> listKeys
DELETE /keys/:id                     -> revokeKey
POST   /keys/rotate                  -> rotateKey
POST   /spaces                       -> createSpace
GET    /spaces                       -> listSpaces
DELETE /spaces/:id                   -> deleteSpace
```

Note: GUI auth and bootstrap are pre-auth routes (they work without an API key). The router needs to handle this - either skip auth middleware for these paths, or use a separate pre-auth route set.

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(auth-keys): extract auth, keys, and spaces from monolith"`

---

### Task 19: Admin Domain

**Source lines:** `src/routes/index.ts` lines 6823-7080 (reembed, backfill, rebuild), 7187-7810 (audit, backup, maintenance, admin ops, SLA, usage, tenants, state)
**Plus:** lines 807-933 (export, import, reset)

**Files:**
- Create: `src/admin/types.ts`
- Create: `src/admin/db.ts`
- Create: `src/admin/routes.ts`
- Create: `src/admin/operations.ts` (reembed, rebuild FTS, compact, GC, cold storage)
- Test: `tests/admin.test.ts`

**Routes to register:**
```
POST   /admin/reembed                -> reembed
GET    /admin/embedding-info         -> embeddingInfo
POST   /admin/backfill-facts         -> backfillFacts
POST   /admin/rebuild-cooccurrences  -> rebuildCooccurrences
POST   /admin/detect-communities     -> detectCommunities
POST   /admin/rebuild-fts            -> rebuildFTS
POST   /admin/refresh-cache          -> refreshCache
POST   /admin/compact                -> compact
POST   /admin/maintenance            -> enterMaintenance
GET    /admin/maintenance            -> getMaintenanceStatus
GET    /admin/scale-report           -> scaleReport
GET    /admin/cold-storage           -> coldStorage
POST   /admin/gc                     -> garbageCollect
GET    /admin/schema                 -> schemaInfo
GET    /admin/sla                    -> slaMetrics
POST   /admin/sla/reset              -> resetSLA
GET    /admin/usage                  -> usageBreakdown
GET    /admin/quotas                 -> listQuotas
PUT    /admin/quotas                 -> setQuotas
GET    /admin/tenants                -> listTenants
POST   /tenants/provision            -> provisionTenant
POST   /tenants/deprovision          -> deprovisionTenant
POST   /checkpoint                   -> createCheckpoint
GET    /backup                       -> downloadBackup
POST   /backup/verify                -> verifyBackup
GET    /export                       -> exportData
POST   /import                       -> importData
POST   /reset                        -> resetData
GET    /state                        -> getState
DELETE /state                        -> clearState
GET    /audit                        -> getAuditLog
```

Largest route count. Most are admin-only (require admin scope). Group under `/admin` prefix where possible.

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(admin): extract admin operations from monolith"`

---

### Task 20: FSRS Domain

**Source lines:** `src/routes/index.ts` lines 5433-5510
**Existing module:** `src/fsrs/index.ts` (algorithm already extracted)

**Files:**
- Create: `src/fsrs/routes.ts`
- Create: `src/fsrs/db.ts` (move FSRS-related prepared statements)
- Test: `tests/fsrs.test.ts`

**Routes to register:**
```
POST   /fsrs/review                  -> fsrsReview
GET    /fsrs/state                   -> fsrsState
POST   /fsrs/init                    -> fsrsInit
```

Small domain. The algorithm is already in `src/fsrs/index.ts`. Just extract the route handlers and DB statements.

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(fsrs): extract FSRS routes from monolith"`

---

### Task 21: Webhooks and Sync Domain

**Source lines:** `src/routes/index.ts` lines 5761-5880
**DB statements to extract:** insertWebhook, listWebhooks, deleteWebhook, getChangesSince, getMemoryBySyncId

**Files:**
- Create: `src/webhooks/types.ts`
- Create: `src/webhooks/db.ts`
- Create: `src/webhooks/routes.ts`
- Test: `tests/webhooks.test.ts`

**Routes to register:**
```
POST   /webhooks                     -> createWebhook
GET    /webhooks                     -> listWebhooks
DELETE /webhooks/:id                 -> deleteWebhook
GET    /sync/changes                 -> getChanges
POST   /sync/receive                 -> receiveChanges
```

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(webhooks): extract webhooks and sync from monolith"`

---

### Task 22: Agents Domain

**Source lines:** `src/routes/index.ts` lines 5168-5315 (agents CRUD + passport + verify)
**DB statements to extract:** insertAgent, getAgentById, getAgentByName, listAgents, updateAgentTrust, revokeAgent, getAgentByKeyId, linkKeyToAgent, getAgentExecutions

**Files:**
- Create: `src/agents/types.ts`
- Create: `src/agents/db.ts`
- Create: `src/agents/index.ts` (passport generation, trust scoring)
- Create: `src/agents/routes.ts`
- Test: `tests/agents.test.ts`

**Routes to register:**
```
POST   /agents                       -> registerAgent
GET    /agents                       -> listAgents
GET    /agents/:id                   -> getAgent
POST   /agents/:id/revoke            -> revokeAgent
GET    /agents/:agent/passport       -> getPassport
POST   /agents/:agent/link-key       -> linkKey
GET    /agents/:id/executions        -> getExecutions
POST   /verify                       -> verifyCredentials
```

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(agents): extract agents domain from monolith"`

---

### Task 23: Scratch Pad Domain

**Source lines:** `src/routes/index.ts` lines 1395-1700
**DB statements to extract:** upsertScratchEntry, upsertScratchEntryWithTTL, listScratchEntries, listScratchEntriesForContext, deleteScratchSession, deleteScratchSessionKey, purgeExpiredScratchpad, getScratchSessionAll

**Files:**
- Create: `src/scratch/types.ts`
- Create: `src/scratch/db.ts`
- Create: `src/scratch/index.ts` (TTL management, promotion, working memory block builder)
- Create: `src/scratch/routes.ts`
- Test: `tests/scratch.test.ts`

**Routes to register:**
```
GET    /scratch                      -> listScratch
PUT    /scratch                      -> upsertScratch
DELETE /scratch/:session/:key        -> deleteScratchKey
DELETE /scratch/:session             -> deleteScratchSession
POST   /scratch/:session/promote     -> promoteScratch
POST   /scratch/:session/summarize   -> summarizeScratch
```

Move the `buildWorkingMemoryBlock` function from `src/routes/types.ts` into `src/scratch/index.ts` (it belongs with the scratch pad domain).

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(scratch): extract scratch pad domain from monolith"`

---

### Task 24: Skills Domain

**Source lines:** `src/routes/index.ts` lines 8153-8390
**Existing module:** `src/skills/` (registry, search, cloud, evolver, types already separated)

**Files:**
- Create: `src/skills/routes.ts`
- Modify: `src/skills/db.ts` (move prepared statements from db/index.ts)
- Test: `tests/skills.test.ts`

**Routes to register:**
```
POST   /skills/sync                  -> syncSkills
GET    /skills                       -> listSkills
POST   /skills/search                -> searchSkills
POST   /skills/upload                -> uploadSkill
POST   /skills/execute               -> executeSkill
GET    /skills/:name                 -> getSkill
DELETE /skills/:name                 -> deleteSkill
POST   /skills/:name/fix             -> fixSkill
```

- [ ] Read source, extract route handlers, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(skills): extract skills routes from monolith"`

---

### Task 25: Inbox Domain

**Source lines:** `src/routes/index.ts` lines 7079-7186
**DB statements to extract:** listPending, countPending, approveMemory, rejectMemory

**Files:**
- Create: `src/inbox/routes.ts`
- Create: `src/inbox/db.ts`
- Test: `tests/inbox.test.ts`

**Routes to register:**
```
GET    /inbox                        -> listInbox
POST   /inbox/:id/approve            -> approveItem
POST   /inbox/:id/reject             -> rejectItem
POST   /inbox/:id/edit               -> editAndApprove
POST   /inbox/bulk                   -> bulkAction
GET    /pending                      -> listAllPending
POST   /approve                      -> batchApprove
```

Simple moderation domain.

- [ ] Read source, extract, write tests, wire, verify, commit
- [ ] Commit: `git commit -m "refactor(inbox): extract inbox/moderation from monolith"`

---

### Task 26: Health and Monitoring Domain

**Source lines:** `src/routes/index.ts` lines 1071-1260 (live, ready, health, metrics, openapi, examples)

**Files:**
- Create: `src/health/routes.ts`
- Create: `src/health/index.ts` (health check aggregation, metrics collection)
- Test: `tests/health.test.ts`

**Routes to register:**
```
GET    /live                         -> liveness
GET    /ready                        -> readiness
GET    /health                       -> healthCheck
GET    /metrics                      -> prometheusMetrics
GET    /openapi.json                 -> openApiSpec
GET    /api/examples                 -> apiExamples
```

**Important:** These routes must work WITHOUT authentication. Either register them before the auth middleware, or add a path-based auth bypass in the middleware.

- [ ] Read source, extract, wire (pre-auth), verify, commit
- [ ] Commit: `git commit -m "refactor(health): extract health and monitoring from monolith"`

---

### Task 27: Small Domains (Prompts, Guard, Docs, Onboard)

**Source lines:**
- Prompts: lines 5598-5680 (/prompt, /header)
- Guard: lines 5316-5395 (/guard)
- Docs: lines 7956-8150 (/docs/resolve, /errors)
- Onboard: lines 7815-7890 (/onboard, /fetch)

These are small enough to combine into one task.

**Files:**
- Create: `src/prompts/routes.ts`
- Create: `src/guard/routes.ts`
- Create: `src/docs/routes.ts`
- Create: `src/onboard/routes.ts`
- Test: `tests/small-domains.test.ts`

**Routes to register:**
```
GET    /prompt                       -> getPrompt
POST   /header                       -> generateHeader
POST   /guard                        -> contentGuard
POST   /docs/resolve                 -> resolveDocs
POST   /errors                       -> reportError
GET    /errors                       -> listErrors
POST   /onboard                      -> onboard
POST   /fetch                        -> fetchUrl
```

- [ ] Read source, extract each small domain, wire, verify, commit
- [ ] Commit: `git commit -m "refactor: extract prompts, guard, docs, and onboard domains"`

---

## Cleanup and Verification

### Task 28: Remove Monolith and Verify

After all domains are extracted:

- [ ] **Step 1: Verify src/routes/index.ts is empty or only re-exports**

Every route handler should have been moved to a domain module. The file should be deletable or contain only backward-compat re-exports.

- [ ] **Step 2: Verify src/db/index.ts is thin**

Should only import `db` from `./connection.ts` and re-export prepared statements from domain `db.ts` files (for any remaining consumers). Goal: under 100 lines.

- [ ] **Step 3: Run full test suite**

```bash
node --experimental-strip-types --test tests/*.test.ts tests/*.test.mjs
```

ALL tests must pass: domain tests + ingestion tests + api integration test.

- [ ] **Step 4: Delete monolith files**

```bash
rm src/routes/index.ts  # or keep as empty barrel
```

Update any remaining imports that reference `src/routes/index.ts`.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: remove monolith route handler and DB file"
```

---

### Task 29: Deploy to Rocky Staging

- [ ] **Step 1: Copy refactored codebase to Rocky**

```bash
scp -r . rocky:/opt/engram-staging/
```

Or use git: push branch, pull on Rocky.

- [ ] **Step 2: Copy production database**

```bash
ssh rocky "cp /opt/engram/data/memory.db /opt/engram-staging/data/memory.db"
```

- [ ] **Step 3: Start staging instance**

```bash
ssh rocky "cd /opt/engram-staging && ENGRAM_PORT=4202 node --experimental-strip-types server.ts"
```

- [ ] **Step 4: Run integration tests against staging**

```bash
ENGRAM_URL=http://100.64.0.2:4202 node --test tests/api.test.mjs
```

- [ ] **Step 5: Compare key queries**

Run the same search/recall/context queries against both production (port 4200) and staging (port 4202). Results should be identical.

- [ ] **Step 6: Monitor logs**

```bash
ssh rocky "journalctl -u engram-staging -f"
```

Watch for errors, warnings, or unexpected behavior.

- [ ] **Step 7: Mark complete or iterate**

If staging passes, the refactored codebase is ready for production swap (separate task, requires Master's approval).

---

## Parallelization Strategy

| Phase | Tasks | Subagents | Depends On |
|-------|-------|-----------|------------|
| Foundation | 1-6 | Sequential (1 agent) | Nothing |
| Wave 1 | 7-9 | 3 parallel | Foundation |
| Wave 2 | 10-13 | 4 parallel | Wave 1 |
| Wave 3 | 14-17 | 4 parallel | Wave 2 |
| Wave 4a | 18-22 | 5 parallel | Foundation |
| Wave 4b | 23-27 | 5 parallel | Foundation |
| Cleanup | 28 | 1 agent | All waves |
| Deploy | 29 | 1 agent | Cleanup |

Wave 4 domains only depend on Foundation (router + middleware), not on Waves 1-3. They can run in parallel with Waves 1-3 to save time.

Total: 29 tasks, ~18 parallel subagent dispatches across 6 phases.
