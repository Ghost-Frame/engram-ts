// Tests for src/ingestion/routes.ts -- export/type tests only.
// Does NOT conflict with existing ingestion tests (ingestion-api.test.ts etc.)
// Run: node --experimental-strip-types --test tests/ingestion-routes.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ============================================================================
// src/ingestion/routes.ts -- exports
// ============================================================================

describe("registerIngestionRoutes", () => {
  it("is exported as a function from src/ingestion/routes.ts", async () => {
    const mod = await import("../src/ingestion/routes.ts");
    assert.strictEqual(typeof mod.registerIngestionRoutes, "function");
  });

  it("accepts a Router and returns void", async () => {
    const { registerIngestionRoutes } = await import("../src/ingestion/routes.ts");

    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (path: string, _h: unknown) => routes.push({ method: "GET", path }),
      post: (path: string, _h: unknown) => routes.push({ method: "POST", path }),
      put: (path: string, _h: unknown) => routes.push({ method: "PUT", path }),
      patch: (path: string, _h: unknown) => routes.push({ method: "PATCH", path }),
      delete: (path: string, _h: unknown) => routes.push({ method: "DELETE", path }),
      use: (_m: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };

    const result = registerIngestionRoutes(mockRouter as any);
    assert.strictEqual(result, undefined, "registerIngestionRoutes must return void");
  });

  it("registers POST /add", async () => {
    const { registerIngestionRoutes } = await import("../src/ingestion/routes.ts");
    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (p: string, _h: unknown) => routes.push({ method: "GET", path: p }),
      post: (p: string, _h: unknown) => routes.push({ method: "POST", path: p }),
      put: (p: string, _h: unknown) => routes.push({ method: "PUT", path: p }),
      patch: (p: string, _h: unknown) => routes.push({ method: "PATCH", path: p }),
      delete: (p: string, _h: unknown) => routes.push({ method: "DELETE", path: p }),
      use: (_m: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };
    registerIngestionRoutes(mockRouter as any);
    assert.ok(routes.find(r => r.method === "POST" && r.path === "/add"), "POST /add must be registered");
  });

  it("registers POST /ingest", async () => {
    const { registerIngestionRoutes } = await import("../src/ingestion/routes.ts");
    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (p: string, _h: unknown) => routes.push({ method: "GET", path: p }),
      post: (p: string, _h: unknown) => routes.push({ method: "POST", path: p }),
      put: (p: string, _h: unknown) => routes.push({ method: "PUT", path: p }),
      patch: (p: string, _h: unknown) => routes.push({ method: "PATCH", path: p }),
      delete: (p: string, _h: unknown) => routes.push({ method: "DELETE", path: p }),
      use: (_m: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };
    registerIngestionRoutes(mockRouter as any);
    assert.ok(routes.find(r => r.method === "POST" && r.path === "/ingest"), "POST /ingest must be registered");
  });

  it("registers POST /derive", async () => {
    const { registerIngestionRoutes } = await import("../src/ingestion/routes.ts");
    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (p: string, _h: unknown) => routes.push({ method: "GET", path: p }),
      post: (p: string, _h: unknown) => routes.push({ method: "POST", path: p }),
      put: (p: string, _h: unknown) => routes.push({ method: "PUT", path: p }),
      patch: (p: string, _h: unknown) => routes.push({ method: "PATCH", path: p }),
      delete: (p: string, _h: unknown) => routes.push({ method: "DELETE", path: p }),
      use: (_m: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };
    registerIngestionRoutes(mockRouter as any);
    assert.ok(routes.find(r => r.method === "POST" && r.path === "/derive"), "POST /derive must be registered");
  });

  it("registers POST /import/mem0", async () => {
    const { registerIngestionRoutes } = await import("../src/ingestion/routes.ts");
    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (p: string, _h: unknown) => routes.push({ method: "GET", path: p }),
      post: (p: string, _h: unknown) => routes.push({ method: "POST", path: p }),
      put: (p: string, _h: unknown) => routes.push({ method: "PUT", path: p }),
      patch: (p: string, _h: unknown) => routes.push({ method: "PATCH", path: p }),
      delete: (p: string, _h: unknown) => routes.push({ method: "DELETE", path: p }),
      use: (_m: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };
    registerIngestionRoutes(mockRouter as any);
    assert.ok(routes.find(r => r.method === "POST" && r.path === "/import/mem0"), "POST /import/mem0 must be registered");
  });

  it("registers POST /import/supermemory", async () => {
    const { registerIngestionRoutes } = await import("../src/ingestion/routes.ts");
    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (p: string, _h: unknown) => routes.push({ method: "GET", path: p }),
      post: (p: string, _h: unknown) => routes.push({ method: "POST", path: p }),
      put: (p: string, _h: unknown) => routes.push({ method: "PUT", path: p }),
      patch: (p: string, _h: unknown) => routes.push({ method: "PATCH", path: p }),
      delete: (p: string, _h: unknown) => routes.push({ method: "DELETE", path: p }),
      use: (_m: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };
    registerIngestionRoutes(mockRouter as any);
    assert.ok(routes.find(r => r.method === "POST" && r.path === "/import/supermemory"), "POST /import/supermemory must be registered");
  });

  it("registers POST /import/bulk", async () => {
    const { registerIngestionRoutes } = await import("../src/ingestion/routes.ts");
    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (p: string, _h: unknown) => routes.push({ method: "GET", path: p }),
      post: (p: string, _h: unknown) => routes.push({ method: "POST", path: p }),
      put: (p: string, _h: unknown) => routes.push({ method: "PUT", path: p }),
      patch: (p: string, _h: unknown) => routes.push({ method: "PATCH", path: p }),
      delete: (p: string, _h: unknown) => routes.push({ method: "DELETE", path: p }),
      use: (_m: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };
    registerIngestionRoutes(mockRouter as any);
    assert.ok(routes.find(r => r.method === "POST" && r.path === "/import/bulk"), "POST /import/bulk must be registered");
  });

  it("registers POST /import/json", async () => {
    const { registerIngestionRoutes } = await import("../src/ingestion/routes.ts");
    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (p: string, _h: unknown) => routes.push({ method: "GET", path: p }),
      post: (p: string, _h: unknown) => routes.push({ method: "POST", path: p }),
      put: (p: string, _h: unknown) => routes.push({ method: "PUT", path: p }),
      patch: (p: string, _h: unknown) => routes.push({ method: "PATCH", path: p }),
      delete: (p: string, _h: unknown) => routes.push({ method: "DELETE", path: p }),
      use: (_m: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };
    registerIngestionRoutes(mockRouter as any);
    assert.ok(routes.find(r => r.method === "POST" && r.path === "/import/json"), "POST /import/json must be registered");
  });

  it("registers all 7 expected routes", async () => {
    const { registerIngestionRoutes } = await import("../src/ingestion/routes.ts");
    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (p: string, _h: unknown) => routes.push({ method: "GET", path: p }),
      post: (p: string, _h: unknown) => routes.push({ method: "POST", path: p }),
      put: (p: string, _h: unknown) => routes.push({ method: "PUT", path: p }),
      patch: (p: string, _h: unknown) => routes.push({ method: "PATCH", path: p }),
      delete: (p: string, _h: unknown) => routes.push({ method: "DELETE", path: p }),
      use: (_m: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };
    registerIngestionRoutes(mockRouter as any);

    const expectedRoutes = [
      "/add", "/ingest", "/derive",
      "/import/mem0", "/import/supermemory", "/import/bulk", "/import/json",
    ];
    for (const path of expectedRoutes) {
      assert.ok(
        routes.find(r => r.method === "POST" && r.path === path),
        `POST ${path} must be registered`,
      );
    }
    assert.strictEqual(routes.filter(r => r.method === "POST").length, expectedRoutes.length);
  });
});
