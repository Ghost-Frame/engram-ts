import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zipParser } from "../src/ingestion/parsers/zip.ts";

describe("zipParser.detect", () => {
  it("returns true for meta.extension = .zip", () => {
    assert.equal(zipParser.detect(Buffer.alloc(0), { extension: ".zip" }), true);
  });

  it("returns true for Buffer starting with PK magic bytes", () => {
    // PK magic: 0x50 0x4B 0x03 0x04
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    assert.equal(zipParser.detect(buf), true);
  });

  it("returns false for .txt extension", () => {
    assert.equal(zipParser.detect("hello world", { extension: ".txt" }), false);
  });

  it("returns false for non-ZIP buffer without extension", () => {
    const buf = Buffer.from("not a zip file");
    assert.equal(zipParser.detect(buf), false);
  });
});

describe("zipParser structure", () => {
  it("has name = zip", () => {
    assert.equal(zipParser.name, "zip");
  });

  it("exposes a parse method", () => {
    assert.equal(typeof zipParser.parse, "function");
  });

  it("parse returns an async iterable (async generator)", () => {
    // Verify the function is an async generator function without actually running it
    // (running it on invalid input is expected to throw)
    const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
    assert.ok(zipParser.parse instanceof AsyncGeneratorFunction);
  });
});

// Integration tests: parse requires a real ZIP buffer.
// To run: create a valid ZIP buffer (e.g. using a zip library or reading a .zip file from disk)
// and pass it to zipParser.parse(buffer).
// Expected: yields ParsedDocuments from all non-directory, non-hidden entries inside the ZIP,
// delegating to the appropriate sub-parser per file extension.
// Nested ZIP files are skipped to prevent zip bombs.
