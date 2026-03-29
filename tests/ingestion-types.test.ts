import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("ingestion types", () => {
  it("exports all required interfaces and types", async () => {
    const mod = await import("../src/ingestion/types.ts");
    assert.equal(typeof mod.IngestMode, "object");
    assert.equal(mod.IngestMode.Extract, "extract");
    assert.equal(mod.IngestMode.Raw, "raw");
    assert.equal(typeof mod.SupportedFormat, "object");
    assert.ok(Array.isArray(mod.SUPPORTED_EXTENSIONS));
    assert.ok(mod.SUPPORTED_EXTENSIONS.includes(".md"));
    assert.ok(mod.SUPPORTED_EXTENSIONS.includes(".pdf"));
    assert.ok(mod.SUPPORTED_EXTENSIONS.includes(".zip"));
  });
});
