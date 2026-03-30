// Tests for the raw ingestion processor.
// Structural tests only -- integration tests require a running Engram instance
// with an initialized embedding provider and database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rawProcessor } from "../src/ingestion/processors/raw.ts";

describe("rawProcessor", () => {
  it("has name 'raw'", () => {
    assert.equal(rawProcessor.name, "raw");
  });

  it("has a process function", () => {
    assert.equal(typeof rawProcessor.process, "function");
  });
});
