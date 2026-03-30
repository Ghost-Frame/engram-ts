import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkDocument } from "../src/ingestion/chunker.ts";
import type { ParsedDocument } from "../src/ingestion/types.ts";

const baseDoc: ParsedDocument = {
  title: "Test Document",
  text: "Hello world",
  metadata: { author: "tester" },
  source: "test-source",
};

describe("chunkDocument", () => {
  it("short text returns single chunk", () => {
    const doc = { ...baseDoc, text: "Hello world. This is a short document." };
    const chunks = chunkDocument(doc);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, "Hello world. This is a short document.");
    assert.equal(chunks[0].document_title, "Test Document");
    assert.equal(chunks[0].source, "test-source");
    assert.deepEqual(chunks[0].metadata, { author: "tester" });
  });

  it("empty text returns empty array", () => {
    const doc = { ...baseDoc, text: "" };
    assert.deepEqual(chunkDocument(doc), []);

    const docWhitespace = { ...baseDoc, text: "   \n\n  " };
    assert.deepEqual(chunkDocument(docWhitespace), []);
  });

  it("long text splits into multiple chunks", () => {
    // Create ~9000 chars of text (3x the default 3000 chunk size)
    const sentence = "This is a test sentence that has some real content in it. ";
    const text = sentence.repeat(155); // ~8990 chars
    const doc = { ...baseDoc, text };
    const chunks = chunkDocument(doc);
    assert.ok(chunks.length >= 2, `Expected >= 2 chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(
        chunk.text.length <= 3100,
        `Chunk too long: ${chunk.text.length}`
      );
    }
  });

  it("respects paragraph boundaries when respect_structure=true", () => {
    // Build a text with clear paragraph breaks near the chunk boundary
    const para1 = "Word ".repeat(500); // 2500 chars
    const para2 = "Data ".repeat(500); // 2500 chars
    const text = para1.trimEnd() + "\n\n" + para2.trimEnd();
    const doc = { ...baseDoc, text };
    const chunks = chunkDocument(doc, {
      max_chunk_size: 3000,
      overlap: 0,
      respect_structure: true,
    });
    // The split should happen at the \n\n boundary, not mid-word
    assert.ok(chunks.length >= 2, `Expected >= 2 chunks, got ${chunks.length}`);
    // First chunk should end cleanly at the paragraph boundary (para1 content)
    assert.ok(
      !chunks[0].text.includes("Data"),
      `Expected first chunk to not contain para2 content`
    );
  });

  it("respects custom chunk size and overlap", () => {
    const text = "abcde ".repeat(200); // 1200 chars
    const doc = { ...baseDoc, text };
    const chunks = chunkDocument(doc, {
      max_chunk_size: 300,
      overlap: 50,
      respect_structure: false,
    });
    assert.ok(chunks.length >= 3, `Expected >= 3 chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      // With overlap, chunk can be up to maxSize
      assert.ok(
        chunk.text.length <= 350,
        `Chunk too long: ${chunk.text.length}`
      );
    }
  });

  it("assigns sequential indexes and correct total", () => {
    const sentence = "The quick brown fox jumps over the lazy dog. ";
    const text = sentence.repeat(200); // ~9000 chars
    const doc = { ...baseDoc, text };
    const chunks = chunkDocument(doc);
    assert.ok(chunks.length >= 2, `Need >= 2 chunks for this test`);
    assert.equal(chunks[0].index, 0);
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i].index, i, `chunk[${i}].index should be ${i}`);
      assert.equal(
        chunks[i].total,
        chunks.length,
        `chunk[${i}].total should be ${chunks.length}`
      );
    }
  });
});
