import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claudeParser } from "../src/ingestion/parsers/claude.ts";

const testConversation = [
  {
    uuid: "abc-123",
    name: "Test Conv",
    created_at: "2026-01-15T10:00:00Z",
    updated_at: "2026-01-15T11:00:00Z",
    chat_messages: [
      { sender: "human", text: "Hello", created_at: "2026-01-15T10:00:00Z" },
      { sender: "assistant", text: "Hi there", created_at: "2026-01-15T10:00:01Z" },
    ],
  },
];

const testConversationEmpty = [
  {
    uuid: "def-456",
    name: "Empty Conv",
    created_at: "2026-01-16T10:00:00Z",
    updated_at: "2026-01-16T10:00:00Z",
    chat_messages: [],
  },
];

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
  }
  return results;
}

describe("claudeParser", () => {
  describe("detect", () => {
    it("returns true for JSON array where first element has uuid + chat_messages", () => {
      const input = JSON.stringify(testConversation);
      assert.equal(claudeParser.detect(input), true);
    });

    it("returns false for non-matching JSON (missing uuid)", () => {
      const input = JSON.stringify([{ name: "Test", chat_messages: [] }]);
      assert.equal(claudeParser.detect(input), false);
    });

    it("returns false for non-matching JSON (missing chat_messages)", () => {
      const input = JSON.stringify([{ uuid: "abc-123", name: "Test" }]);
      assert.equal(claudeParser.detect(input), false);
    });

    it("returns false for non-array JSON", () => {
      const input = JSON.stringify({ uuid: "abc-123", chat_messages: [] });
      assert.equal(claudeParser.detect(input), false);
    });

    it("returns false for empty array", () => {
      const input = JSON.stringify([]);
      assert.equal(claudeParser.detect(input), false);
    });

    it("returns false for invalid JSON", () => {
      assert.equal(claudeParser.detect("not json at all"), false);
    });

    it("works with Buffer input", () => {
      const input = Buffer.from(JSON.stringify(testConversation));
      assert.equal(claudeParser.detect(input), true);
    });
  });

  describe("parse", () => {
    it("yields one ParsedDocument per conversation", async () => {
      const input = JSON.stringify(testConversation);
      const docs = await collect(claudeParser.parse(input));
      assert.equal(docs.length, 1);
    });

    it("ParsedDocument.title equals conversation name", async () => {
      const input = JSON.stringify(testConversation);
      const docs = await collect(claudeParser.parse(input));
      assert.equal(docs[0].title, "Test Conv");
    });

    it("ParsedDocument.text has Human: and Assistant: prefixes", async () => {
      const input = JSON.stringify(testConversation);
      const docs = await collect(claudeParser.parse(input));
      assert.ok(docs[0].text.includes("Human: Hello"), `Expected 'Human: Hello' in: ${docs[0].text}`);
      assert.ok(docs[0].text.includes("Assistant: Hi there"), `Expected 'Assistant: Hi there' in: ${docs[0].text}`);
    });

    it("ParsedDocument.timestamp comes from created_at", async () => {
      const input = JSON.stringify(testConversation);
      const docs = await collect(claudeParser.parse(input));
      assert.equal(docs[0].timestamp, "2026-01-15T10:00:00Z");
    });

    it("ParsedDocument.metadata includes uuid", async () => {
      const input = JSON.stringify(testConversation);
      const docs = await collect(claudeParser.parse(input));
      assert.equal(docs[0].metadata.uuid, "abc-123");
    });

    it("handles empty chat_messages array", async () => {
      const input = JSON.stringify(testConversationEmpty);
      const docs = await collect(claudeParser.parse(input));
      assert.equal(docs.length, 1);
      assert.equal(docs[0].title, "Empty Conv");
      assert.equal(docs[0].text, "");
    });

    it("yields multiple documents for multiple conversations", async () => {
      const input = JSON.stringify([...testConversation, ...testConversationEmpty]);
      const docs = await collect(claudeParser.parse(input));
      assert.equal(docs.length, 2);
    });

    it("works with Buffer input", async () => {
      const input = Buffer.from(JSON.stringify(testConversation));
      const docs = await collect(claudeParser.parse(input));
      assert.equal(docs.length, 1);
    });
  });
});
