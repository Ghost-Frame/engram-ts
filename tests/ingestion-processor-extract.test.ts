// Tests for the extract ingestion processor.
// Structural tests only - integration tests require a running Engram instance
// with an initialized LLM, embedding provider, and database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractProcessor } from "../src/ingestion/processors/extract.ts";

describe("extractProcessor", () => {
  it("has name 'extract'", () => {
    assert.equal(extractProcessor.name, "extract");
  });

  it("has a process function", () => {
    assert.equal(typeof extractProcessor.process, "function");
  });
});
