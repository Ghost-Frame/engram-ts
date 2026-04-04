// Tests for POST /import/bulk API endpoint.
// Structural tests verify the route exists and the ingestion module has the correct shape.
// Integration tests (requiring a running server) can be run via api.test.mjs with ENGRAM_URL set.
//
// Run: node --experimental-strip-types --test tests/ingestion-api.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTES_FILE = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "../src/routes/index.ts");

describe("POST /import/bulk - route registration", () => {
  it("route handler exists in src/routes/index.ts", () => {
    const src = readFileSync(ROUTES_FILE, "utf8");
    assert.ok(
      src.includes('url.pathname === "/import/bulk"'),
      'routes/index.ts must contain: url.pathname === "/import/bulk"',
    );
  });

  it("route requires write scope", () => {
    const src = readFileSync(ROUTES_FILE, "utf8");
    // Find the /import/bulk block and verify it checks for write scope
    const idx = src.indexOf('url.pathname === "/import/bulk"');
    assert.ok(idx !== -1, "/import/bulk handler not found");
    const block = src.slice(idx, idx + 4000);
    assert.ok(
      block.includes('hasScope(auth, "write")'),
      "/import/bulk must check hasScope(auth, 'write')",
    );
  });

  it("route uses ingestAsync from ingestion module", () => {
    const src = readFileSync(ROUTES_FILE, "utf8");
    const idx = src.indexOf('url.pathname === "/import/bulk"');
    assert.ok(idx !== -1, "/import/bulk handler not found");
    // Check that ingestAsync is imported within the block
    const block = src.slice(idx, idx + 3000);
    assert.ok(
      block.includes("ingestAsync"),
      "/import/bulk must call ingestAsync",
    );
  });

  it("route returns 202 status", () => {
    const src = readFileSync(ROUTES_FILE, "utf8");
    const idx = src.indexOf('url.pathname === "/import/bulk"');
    assert.ok(idx !== -1, "/import/bulk handler not found");
    const block = src.slice(idx, idx + 4000);
    assert.ok(
      block.includes("202"),
      "/import/bulk must return HTTP 202",
    );
  });

  it("response shape includes required fields", () => {
    const src = readFileSync(ROUTES_FILE, "utf8");
    const idx = src.indexOf('url.pathname === "/import/bulk"');
    assert.ok(idx !== -1, "/import/bulk handler not found");
    const block = src.slice(idx, idx + 4000);
    assert.ok(block.includes("job_id"), "response must include job_id");
    assert.ok(block.includes("chiasm_task_id"), "response must include chiasm_task_id");
    assert.ok(block.includes('"processing"'), 'response must include status: "processing"');
    assert.ok(block.includes("axon_channel"), "response must include axon_channel");
    assert.ok(block.includes("subscribe"), "response must include subscribe");
  });

  it("route validates that text or url is required", () => {
    const src = readFileSync(ROUTES_FILE, "utf8");
    const idx = src.indexOf('url.pathname === "/import/bulk"');
    assert.ok(idx !== -1, "/import/bulk handler not found");
    const block = src.slice(idx, idx + 3000);
    assert.ok(
      block.includes("!text && !ingestUrl"),
      "/import/bulk must validate that text or url is provided",
    );
  });

  it("route includes SSRF protection for URL fetching", () => {
    const src = readFileSync(ROUTES_FILE, "utf8");
    const idx = src.indexOf('url.pathname === "/import/bulk"');
    assert.ok(idx !== -1, "/import/bulk handler not found");
    const block = src.slice(idx, idx + 3000);
    assert.ok(
      block.includes("localhost") || block.includes("SSRF") || block.includes("private/internal"),
      "/import/bulk must include SSRF protection",
    );
  });
});

describe("POST /import/bulk - ingestion module contract", () => {
  it("ingestAsync is exported from src/ingestion/index.ts", async () => {
    const mod = await import("../src/ingestion/index.ts");
    assert.equal(typeof mod.ingestAsync, "function", "ingestAsync must be a function");
  });

  it("ingestAsync returns synchronous shape with job_id, chiasm_task_id, promise", async () => {
    const mod = await import("../src/ingestion/index.ts");
    const opts = {
      mode: "raw" as const,
      source: "import",
      category: "general",
      userId: 1,
      spaceId: null,
    };

    const result = mod.ingestAsync("test memory content", opts);

    assert.equal(typeof result.job_id, "string", "job_id must be a string");
    assert.ok(result.job_id.startsWith("ingest_"), `job_id must start with "ingest_", got: ${result.job_id}`);
    assert.equal(typeof result.chiasm_task_id, "number", "chiasm_task_id must be a number");
    assert.ok(result.promise instanceof Promise, "promise must be a Promise");

    // Consume promise to avoid unhandled rejection
    await result.promise.catch(() => {});
  });

  it("ingestAsync job_id is unique per call", async () => {
    const mod = await import("../src/ingestion/index.ts");
    const opts = {
      mode: "raw" as const,
      source: "import",
      category: "general",
      userId: 1,
      spaceId: null,
    };

    const r1 = mod.ingestAsync("first document", opts);
    const r2 = mod.ingestAsync("second document", opts);

    assert.notEqual(r1.job_id, r2.job_id, "each call must produce a unique job_id");

    await r1.promise.catch(() => {});
    await r2.promise.catch(() => {});
  });

  it("ingestAsync chiasm_task_id is a number (may be -1 fallback when DB unavailable)", async () => {
    const mod = await import("../src/ingestion/index.ts");
    const opts = {
      mode: "raw" as const,
      source: "import",
      category: "general",
      userId: 1,
      spaceId: null,
    };

    const result = mod.ingestAsync("test content for chiasm check", opts);
    assert.equal(typeof result.chiasm_task_id, "number");

    await result.promise.catch(() => {});
  });
});
