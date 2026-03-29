import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pdfParser } from "../src/ingestion/parsers/pdf.ts";

describe("pdfParser.detect", () => {
  it("returns true for meta.extension = .pdf", () => {
    assert.equal(pdfParser.detect(Buffer.alloc(0), { extension: ".pdf" }), true);
  });

  it("returns true for Buffer starting with %PDF magic bytes", () => {
    const buf = Buffer.from("%PDF-1.4 test content");
    assert.equal(pdfParser.detect(buf), true);
  });

  it("returns false for .txt extension", () => {
    assert.equal(pdfParser.detect("hello world", { extension: ".txt" }), false);
  });

  it("returns false for non-PDF buffer without extension", () => {
    const buf = Buffer.from("not a pdf file");
    assert.equal(pdfParser.detect(buf), false);
  });
});

describe("pdfParser structure", () => {
  it("has name = pdf", () => {
    assert.equal(pdfParser.name, "pdf");
  });

  it("exposes a parse method", () => {
    assert.equal(typeof pdfParser.parse, "function");
  });
});

// Integration test: parse requires a real PDF buffer.
// To run: obtain a valid PDF buffer (e.g. from a file on disk) and pass it to pdfParser.parse().
// Expected: yields one ParsedDocument with title (from PDF info or fallback), text, source="pdf".
