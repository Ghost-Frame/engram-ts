import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerPromptRoutes } from "../src/prompts/routes.ts";
import { registerGuardRoutes } from "../src/guard/routes.ts";
import { registerDocsRoutes } from "../src/docs/routes.ts";
import { registerOnboardRoutes } from "../src/onboard/routes.ts";

describe("registerPromptRoutes", () => {
  it("is a function", () => {
    assert.strictEqual(typeof registerPromptRoutes, "function");
  });

  it("accepts a router argument", () => {
    const calls: string[] = [];
    const mockRouter = {
      get: (path: string, _handler: any) => { calls.push(`GET ${path}`); },
      post: (path: string, _handler: any) => { calls.push(`POST ${path}`); },
      put: (path: string, _handler: any) => { calls.push(`PUT ${path}`); },
      patch: (path: string, _handler: any) => { calls.push(`PATCH ${path}`); },
      delete: (path: string, _handler: any) => { calls.push(`DELETE ${path}`); },
      use: (_middleware: any) => {},
      group: (_prefix: string, _fn: any) => {},
      handle: async (_req: any) => new Response(),
    };
    registerPromptRoutes(mockRouter as any);
    assert.ok(calls.includes("GET /prompt"), "should register GET /prompt");
    assert.ok(calls.includes("POST /header"), "should register POST /header");
    assert.strictEqual(calls.length, 2, "should register exactly 2 routes");
  });
});

describe("registerGuardRoutes", () => {
  it("is a function", () => {
    assert.strictEqual(typeof registerGuardRoutes, "function");
  });

  it("registers POST /guard", () => {
    const calls: string[] = [];
    const mockRouter = {
      get: (path: string, _handler: any) => { calls.push(`GET ${path}`); },
      post: (path: string, _handler: any) => { calls.push(`POST ${path}`); },
      put: (path: string, _handler: any) => { calls.push(`PUT ${path}`); },
      patch: (path: string, _handler: any) => { calls.push(`PATCH ${path}`); },
      delete: (path: string, _handler: any) => { calls.push(`DELETE ${path}`); },
      use: (_middleware: any) => {},
      group: (_prefix: string, _fn: any) => {},
      handle: async (_req: any) => new Response(),
    };
    registerGuardRoutes(mockRouter as any);
    assert.ok(calls.includes("POST /guard"), "should register POST /guard");
    assert.strictEqual(calls.length, 1, "should register exactly 1 route");
  });
});

describe("registerDocsRoutes", () => {
  it("is a function", () => {
    assert.strictEqual(typeof registerDocsRoutes, "function");
  });

  it("registers docs and errors routes", () => {
    const calls: string[] = [];
    const mockRouter = {
      get: (path: string, _handler: any) => { calls.push(`GET ${path}`); },
      post: (path: string, _handler: any) => { calls.push(`POST ${path}`); },
      put: (path: string, _handler: any) => { calls.push(`PUT ${path}`); },
      patch: (path: string, _handler: any) => { calls.push(`PATCH ${path}`); },
      delete: (path: string, _handler: any) => { calls.push(`DELETE ${path}`); },
      use: (_middleware: any) => {},
      group: (_prefix: string, _fn: any) => {},
      handle: async (_req: any) => new Response(),
    };
    registerDocsRoutes(mockRouter as any);
    assert.ok(calls.includes("POST /docs/resolve"), "should register POST /docs/resolve");
    assert.ok(calls.includes("POST /errors"), "should register POST /errors");
    assert.ok(calls.includes("GET /errors"), "should register GET /errors");
    assert.strictEqual(calls.length, 3, "should register exactly 3 routes");
  });
});

describe("registerOnboardRoutes", () => {
  it("is a function", () => {
    assert.strictEqual(typeof registerOnboardRoutes, "function");
  });

  it("registers onboard and fetch routes", () => {
    const calls: string[] = [];
    const mockRouter = {
      get: (path: string, _handler: any) => { calls.push(`GET ${path}`); },
      post: (path: string, _handler: any) => { calls.push(`POST ${path}`); },
      put: (path: string, _handler: any) => { calls.push(`PUT ${path}`); },
      patch: (path: string, _handler: any) => { calls.push(`PATCH ${path}`); },
      delete: (path: string, _handler: any) => { calls.push(`DELETE ${path}`); },
      use: (_middleware: any) => {},
      group: (_prefix: string, _fn: any) => {},
      handle: async (_req: any) => new Response(),
    };
    registerOnboardRoutes(mockRouter as any);
    assert.ok(calls.includes("POST /onboard"), "should register POST /onboard");
    assert.ok(calls.includes("POST /fetch"), "should register POST /fetch");
    assert.strictEqual(calls.length, 2, "should register exactly 2 routes");
  });
});
