import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { messagesParser } from "../src/ingestion/parsers/messages.ts";

describe("messagesParser.detect", () => {
  it("returns true for JSON array where first element has role + content", () => {
    const input = JSON.stringify([{ role: "user", content: "Hello" }]);
    assert.equal(messagesParser.detect(input), true);
  });

  it("returns false for non-array JSON", () => {
    const input = JSON.stringify({ role: "user", content: "Hello" });
    assert.equal(messagesParser.detect(input), false);
  });

  it("returns false for array missing role field", () => {
    const input = JSON.stringify([{ content: "Hello" }]);
    assert.equal(messagesParser.detect(input), false);
  });

  it("returns false for array missing content field", () => {
    const input = JSON.stringify([{ role: "user" }]);
    assert.equal(messagesParser.detect(input), false);
  });

  it("returns false for non-JSON string", () => {
    assert.equal(messagesParser.detect("not json at all"), false);
  });

  it("returns false for empty array", () => {
    assert.equal(messagesParser.detect("[]"), false);
  });
});

describe("messagesParser.parse", () => {
  it("yields a single ParsedDocument", async () => {
    const input = JSON.stringify([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi!" },
    ]);
    const docs: unknown[] = [];
    for await (const doc of messagesParser.parse(input)) {
      docs.push(doc);
    }
    assert.equal(docs.length, 1);
  });

  it("text has Role: content format separated by double newlines", async () => {
    const input = JSON.stringify([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi back" },
    ]);
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of messagesParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    const expected = "User: Hello there\n\nAssistant: Hi back";
    assert.equal(docs[0].text, expected);
  });

  it("capitalizes role names", async () => {
    const input = JSON.stringify([{ role: "system", content: "You are helpful" }]);
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of messagesParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.ok(docs[0].text.startsWith("System:"));
  });

  it("title is first 60 chars of concatenated text", async () => {
    const input = JSON.stringify([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi back" },
    ]);
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of messagesParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    const expectedText = "User: Hello there\n\nAssistant: Hi back";
    assert.equal(docs[0].title, expectedText.slice(0, 60));
  });

  it("includes timestamp from message if present", async () => {
    const input = JSON.stringify([
      { role: "user", content: "Hello", timestamp: "2024-01-01T00:00:00Z" },
    ]);
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown>; timestamp?: string }[] = [];
    for await (const doc of messagesParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].metadata.message_count, 1);
  });

  it("metadata includes message_count", async () => {
    const input = JSON.stringify([
      { role: "user", content: "A" },
      { role: "assistant", content: "B" },
      { role: "user", content: "C" },
    ]);
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of messagesParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].metadata.message_count, 3);
  });
});
