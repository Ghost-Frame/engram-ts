import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chatgptParser } from "../src/ingestion/parsers/chatgpt.ts";

const testConversation = [
  {
    title: "Test Chat",
    create_time: 1705312800,
    update_time: 1705316400,
    mapping: {
      root: {
        message: null,
        parent: null,
        children: ["msg1"],
      },
      msg1: {
        message: {
          author: { role: "user" },
          content: { parts: ["Hello"] },
          create_time: 1705312800,
        },
        parent: "root",
        children: ["msg2"],
      },
      msg2: {
        message: {
          author: { role: "assistant" },
          content: { parts: ["Hi there"] },
          create_time: 1705312801,
        },
        parent: "msg1",
        children: [],
      },
    },
  },
];

const testConversationWithSystem = [
  {
    title: "Chat With System",
    create_time: 1705312800,
    update_time: 1705316400,
    mapping: {
      root: {
        message: null,
        parent: null,
        children: ["sys1"],
      },
      sys1: {
        message: {
          author: { role: "system" },
          content: { parts: ["You are a helpful assistant."] },
          create_time: 1705312799,
        },
        parent: "root",
        children: ["msg1"],
      },
      msg1: {
        message: {
          author: { role: "user" },
          content: { parts: ["Hello"] },
          create_time: 1705312800,
        },
        parent: "sys1",
        children: ["msg2"],
      },
      msg2: {
        message: {
          author: { role: "assistant" },
          content: { parts: ["Hi there"] },
          create_time: 1705312801,
        },
        parent: "msg1",
        children: [],
      },
    },
  },
];

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
  }
  return results;
}

describe("chatgptParser", () => {
  describe("detect", () => {
    it("returns true for JSON array where first element has title + mapping", () => {
      const input = JSON.stringify(testConversation);
      assert.equal(chatgptParser.detect(input), true);
    });

    it("returns false for non-matching JSON (missing mapping)", () => {
      const input = JSON.stringify([{ title: "Test", create_time: 1234 }]);
      assert.equal(chatgptParser.detect(input), false);
    });

    it("returns false for non-matching JSON (missing title)", () => {
      const input = JSON.stringify([{ mapping: {}, create_time: 1234 }]);
      assert.equal(chatgptParser.detect(input), false);
    });

    it("returns false for non-array JSON", () => {
      const input = JSON.stringify({ title: "Test", mapping: {} });
      assert.equal(chatgptParser.detect(input), false);
    });

    it("returns false for empty array", () => {
      const input = JSON.stringify([]);
      assert.equal(chatgptParser.detect(input), false);
    });

    it("returns false for invalid JSON", () => {
      assert.equal(chatgptParser.detect("not json"), false);
    });

    it("works with Buffer input", () => {
      const input = Buffer.from(JSON.stringify(testConversation));
      assert.equal(chatgptParser.detect(input), true);
    });
  });

  describe("parse", () => {
    it("yields one ParsedDocument per conversation", async () => {
      const input = JSON.stringify(testConversation);
      const docs = await collect(chatgptParser.parse(input));
      assert.equal(docs.length, 1);
    });

    it("title comes from conversation title field", async () => {
      const input = JSON.stringify(testConversation);
      const docs = await collect(chatgptParser.parse(input));
      assert.equal(docs[0].title, "Test Chat");
    });

    it("timestamp from create_time (unix seconds -> ISO string)", async () => {
      const input = JSON.stringify(testConversation);
      const docs = await collect(chatgptParser.parse(input));
      const expected = new Date(1705312800 * 1000).toISOString();
      assert.equal(docs[0].timestamp, expected);
    });

    it("text has User: and Assistant: prefixes", async () => {
      const input = JSON.stringify(testConversation);
      const docs = await collect(chatgptParser.parse(input));
      assert.ok(docs[0].text.includes("User: Hello"), `Expected 'User: Hello' in: ${docs[0].text}`);
      assert.ok(docs[0].text.includes("Assistant: Hi there"), `Expected 'Assistant: Hi there' in: ${docs[0].text}`);
    });

    it("filters out system role messages", async () => {
      const input = JSON.stringify(testConversationWithSystem);
      const docs = await collect(chatgptParser.parse(input));
      assert.equal(docs.length, 1);
      assert.ok(
        !docs[0].text.includes("You are a helpful assistant"),
        `System message should be filtered out. Got: ${docs[0].text}`
      );
      assert.ok(docs[0].text.includes("User: Hello"), `Expected user message in: ${docs[0].text}`);
    });

    it("filters out null messages (walks tree correctly from root)", async () => {
      const input = JSON.stringify(testConversation);
      const docs = await collect(chatgptParser.parse(input));
      // root has null message - should not appear in text
      assert.ok(docs[0].text.trim().length > 0, "Should have some text content");
      // Should only have user + assistant messages
      const lines = docs[0].text.trim().split("\n").filter((l: string) => l.trim());
      // Each line should start with User: or Assistant:
      for (const line of lines) {
        assert.ok(
          line.startsWith("User: ") || line.startsWith("Assistant: "),
          `Unexpected line format: "${line}"`
        );
      }
    });

    it("yields multiple documents for multiple conversations", async () => {
      const conv2 = { ...testConversation[0], title: "Second Chat" };
      const input = JSON.stringify([...testConversation, conv2]);
      const docs = await collect(chatgptParser.parse(input));
      assert.equal(docs.length, 2);
    });

    it("works with Buffer input", async () => {
      const input = Buffer.from(JSON.stringify(testConversation));
      const docs = await collect(chatgptParser.parse(input));
      assert.equal(docs.length, 1);
    });
  });
});
