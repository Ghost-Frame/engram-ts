import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { docxParser } from "../src/ingestion/parsers/docx.ts";

describe("docxParser.detect", () => {
  it("returns true for meta.extension = .docx", () => {
    assert.equal(docxParser.detect(Buffer.alloc(0), { extension: ".docx" }), true);
  });

  it("returns true for Buffer starting with PK magic bytes (ZIP signature)", () => {
    // DOCX files are ZIP archives; ZIP magic bytes are 0x50 0x4B (PK)
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    assert.equal(docxParser.detect(buf), true);
  });

  it("returns false for .pdf extension", () => {
    assert.equal(docxParser.detect(Buffer.alloc(0), { extension: ".pdf" }), false);
  });

  it("returns false for non-DOCX buffer without extension", () => {
    const buf = Buffer.from("not a docx file");
    assert.equal(docxParser.detect(buf), false);
  });
});

describe("docxParser structure", () => {
  it("has name = docx", () => {
    assert.equal(docxParser.name, "docx");
  });

  it("exposes a parse method", () => {
    assert.equal(typeof docxParser.parse, "function");
  });

  it("parse throws when given a string (DOCX is binary-only)", async () => {
    await assert.rejects(
      async () => {
        for await (const _ of docxParser.parse("not a buffer")) {
          // consume
        }
      },
      /string input not supported/i,
    );
  });
});

// Integration test: parse requires a real DOCX buffer.
// To run: read a .docx file into a Buffer and pass it to docxParser.parse().
// Expected: yields one ParsedDocument with title (from first heading or first 60 chars),
// text (raw extracted text), source="docx".
