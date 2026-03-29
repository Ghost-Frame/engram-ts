import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../src/embeddings/chunking.ts";

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const chunks = chunkText("Hello world", 1440, 160);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "Hello world");
  });

  it("returns empty array for empty text", () => {
    assert.deepEqual(chunkText("", 1440, 160), []);
    assert.deepEqual(chunkText("   ", 1440, 160), []);
  });

  it("splits long text into multiple chunks", () => {
    const text = "This is a test sentence. ".repeat(150);
    const chunks = chunkText(text, 1440, 160);
    assert.ok(chunks.length >= 2, `Expected >= 2 chunks, got ${chunks.length}`);
    assert.ok(chunks.length <= 4, `Expected <= 4 chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 1500, `Chunk too long: ${chunk.length}`);
    }
  });

  it("respects maxChunks limit", () => {
    const text = "Word ".repeat(5000);
    const chunks = chunkText(text, 1440, 160, 3);
    assert.ok(chunks.length <= 3, `Expected <= 3 chunks, got ${chunks.length}`);
  });

  it("chunks have overlap", () => {
    const sentences: string[] = [];
    for (let i = 0; i < 100; i++) {
      sentences.push(`Sentence number ${i} with some padding text here.`);
    }
    const text = sentences.join(" ");
    const chunks = chunkText(text, 1440, 160);
    assert.ok(chunks.length >= 2, "Need at least 2 chunks to test overlap");
    const chunk0End = chunks[0].slice(-100);
    const chunk1Start = chunks[1].slice(0, 200);
    const overlapWords = chunk0End.split(/\s+/).filter(w => chunk1Start.includes(w));
    assert.ok(overlapWords.length > 0, "Expected overlap between consecutive chunks");
  });

  it("handles text exactly at maxChars boundary", () => {
    const text = "x".repeat(1440);
    const chunks = chunkText(text, 1440, 160);
    assert.equal(chunks.length, 1);
  });

  it("handles text just over maxChars boundary", () => {
    const text = "x".repeat(1441);
    const chunks = chunkText(text, 1440, 160);
    assert.equal(chunks.length, 2);
  });

  it("prefers sentence boundaries for splitting", () => {
    const part1 = "A".repeat(1000) + ". ";
    const part2 = "B".repeat(500) + ". ";
    const part3 = "C".repeat(500);
    const text = part1 + part2 + part3;
    const chunks = chunkText(text, 1440, 160);
    assert.ok(
      chunks[0].endsWith(".") || chunks[0].endsWith(". "),
      `Expected chunk to end at sentence boundary, got: ...${chunks[0].slice(-20)}`
    );
  });
});
