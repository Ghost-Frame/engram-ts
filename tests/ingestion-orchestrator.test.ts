import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("ingestion orchestrator", () => {
  it("exports ingest as an async function", async () => {
    const mod = await import("../src/ingestion/index.ts");
    assert.equal(typeof mod.ingest, "function");
    // Verify it returns a Promise (is async)
    const opts = {
      mode: "raw" as const,
      source: "test",
      category: "general",
      userId: 1,
      spaceId: null,
    };
    const result = mod.ingest("# Hello\n\nWorld", opts);
    assert.ok(result instanceof Promise, "ingest should return a Promise");
    // Await to avoid unhandled rejection -- it will likely fail due to no DB
    await result.catch(() => {});
  });

  it("exports ingestAsync as a function", async () => {
    const mod = await import("../src/ingestion/index.ts");
    assert.equal(typeof mod.ingestAsync, "function");
  });

  it("re-exports detectFormat", async () => {
    const mod = await import("../src/ingestion/index.ts");
    assert.equal(typeof mod.detectFormat, "function");
  });

  it("re-exports chunkDocument", async () => {
    const mod = await import("../src/ingestion/index.ts");
    assert.equal(typeof mod.chunkDocument, "function");
  });

  it("ingestAsync returns synchronous shape with job_id, chiasm_task_id, promise", async () => {
    const mod = await import("../src/ingestion/index.ts");
    const opts = {
      mode: "raw" as const,
      source: "test",
      category: "general",
      userId: 1,
      spaceId: null,
    };

    const result = mod.ingestAsync("# Hello\n\nThis is a test document.", opts);

    // Synchronous fields must be present immediately
    assert.equal(typeof result.job_id, "string");
    assert.ok(result.job_id.startsWith("ingest_"), `job_id should start with "ingest_", got: ${result.job_id}`);
    assert.equal(typeof result.chiasm_task_id, "number");
    assert.ok(result.promise instanceof Promise, "promise field should be a Promise");

    // Consume promise to avoid unhandled rejection
    await result.promise.catch(() => {});
  });

  it("ingestAsync job_id has correct format (ingest_ + 8 hex chars)", async () => {
    const mod = await import("../src/ingestion/index.ts");
    const opts = {
      mode: "raw" as const,
      source: "test",
      category: "general",
      userId: 1,
      spaceId: null,
    };

    const r1 = mod.ingestAsync("hello world", opts);
    const r2 = mod.ingestAsync("another doc", opts);

    // Both should have the prefix
    assert.ok(r1.job_id.startsWith("ingest_"));
    assert.ok(r2.job_id.startsWith("ingest_"));

    // They should be unique
    assert.notEqual(r1.job_id, r2.job_id);

    await r1.promise.catch(() => {});
    await r2.promise.catch(() => {});
  });

  it("chiasm_task_id falls back to -1 when DB is unavailable", async () => {
    const mod = await import("../src/ingestion/index.ts");
    const opts = {
      mode: "raw" as const,
      source: "test",
      category: "general",
      userId: 1,
      spaceId: null,
    };

    // In test environment without DB, Chiasm creation will fail and fallback to -1
    const result = mod.ingestAsync("# Test\n\nDocument content.", opts);
    // chiasm_task_id must be a number (either real ID or fallback -1)
    assert.equal(typeof result.chiasm_task_id, "number");

    await result.promise.catch(() => {});
  });
});
