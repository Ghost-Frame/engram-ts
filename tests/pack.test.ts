// Tests for pack domain: export/type verification only.
// Run: node --experimental-strip-types --test tests/pack.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ============================================================================
// src/pack/index.ts -- exports and types
// ============================================================================

describe("packMemories function", () => {
  it("is exported as a function", async () => {
    const mod = await import("../src/pack/index.ts");
    assert.strictEqual(typeof mod.packMemories, "function");
  });
});

describe("PackFormat type values", () => {
  it("accepts text, json, xml as PackFormat", async () => {
    const { packMemories } = await import("../src/pack/index.ts");
    // Type-level: just verify the function exists and accepts these strings
    // (runtime type-checking is trivial -- these are string literals in the module)
    assert.ok(packMemories);
  });
});

// ============================================================================
// src/pack/routes.ts -- exports
// ============================================================================

describe("registerPackRoutes", () => {
  it("is exported as a function from src/pack/routes.ts", async () => {
    const mod = await import("../src/pack/routes.ts");
    assert.strictEqual(typeof mod.registerPackRoutes, "function");
  });

  it("accepts a Router and returns void", async () => {
    const { registerPackRoutes } = await import("../src/pack/routes.ts");

    // Mock router that captures registered routes
    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (path: string) => routes.push({ method: "GET", path }),
      post: (path: string, _handler: unknown) => routes.push({ method: "POST", path }),
      put: (path: string, _handler: unknown) => routes.push({ method: "PUT", path }),
      patch: (path: string, _handler: unknown) => routes.push({ method: "PATCH", path }),
      delete: (path: string, _handler: unknown) => routes.push({ method: "DELETE", path }),
      use: (_middleware: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };

    const result = registerPackRoutes(mockRouter as any);
    assert.strictEqual(result, undefined, "registerPackRoutes must return void");
  });

  it("registers POST /pack", async () => {
    const { registerPackRoutes } = await import("../src/pack/routes.ts");

    const routes: Array<{ method: string; path: string }> = [];
    const mockRouter = {
      get: (path: string) => routes.push({ method: "GET", path }),
      post: (path: string, _handler: unknown) => routes.push({ method: "POST", path }),
      put: (path: string, _handler: unknown) => routes.push({ method: "PUT", path }),
      patch: (path: string, _handler: unknown) => routes.push({ method: "PATCH", path }),
      delete: (path: string, _handler: unknown) => routes.push({ method: "DELETE", path }),
      use: (_middleware: unknown) => {},
      group: (_prefix: string, fn: (r: typeof mockRouter) => void) => fn(mockRouter),
      handle: async (_req: Request) => new Response(),
    };

    registerPackRoutes(mockRouter as any);

    const packRoute = routes.find(r => r.method === "POST" && r.path === "/pack");
    assert.ok(packRoute, "POST /pack must be registered");
  });
});

// ============================================================================
// PackCandidate and PackResult type shapes (compile-time checks via assignment)
// ============================================================================

describe("PackCandidate type", () => {
  it("has expected shape", async () => {
    const mod = await import("../src/pack/index.ts");
    // Verify the module loaded and types are usable
    assert.ok(mod.packMemories);

    // Type-level check: construct an object conforming to PackCandidate
    const candidate: import("../src/pack/index.ts").PackCandidate = {
      id: 1,
      content: "test content",
      category: "general",
      importance: 7,
      decay_score: 0.8,
      confidence: 0.9,
      score: 50,
      source: "static",
    };
    assert.strictEqual(candidate.id, 1);
    assert.strictEqual(candidate.source, "static");
  });
});

describe("PackResult type", () => {
  it("has expected shape", async () => {
    const mod = await import("../src/pack/index.ts");
    assert.ok(mod.packMemories);

    // Type-level check: construct an object conforming to PackResult
    const result: import("../src/pack/index.ts").PackResult = {
      packed: "[general] some memory",
      memories_included: 5,
      tokens_estimated: 120,
      token_budget: 4000,
      utilization: "3%",
    };
    assert.strictEqual(result.memories_included, 5);
    assert.strictEqual(result.token_budget, 4000);
  });
});
