import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  Conversation, ConversationListItem, Message,
  CreateConversationBody, UpdateConversationBody,
  BulkMessageInput, BulkInsertBody,
  UpsertConversationBody, SearchMessagesBody,
} from "../src/conversations/types.ts";
import { registerConversationRoutes } from "../src/conversations/routes.ts";

describe("Conversation type", () => {
  it("has expected shape via type-level check", () => {
    const conv: Conversation = {
      id: 1, agent: "claude-code", session_id: "sess-123",
      title: "Test conversation", metadata: null, user_id: 1,
      started_at: "2025-01-01 00:00:00", updated_at: "2025-01-01 01:00:00",
    };
    assert.strictEqual(conv.id, 1);
    assert.strictEqual(conv.agent, "claude-code");
  });
  it("allows null optional fields", () => {
    const conv: Conversation = {
      id: 2, agent: "gpt", session_id: null, title: null,
      metadata: null, user_id: 1, started_at: "2025-01-01", updated_at: "2025-01-01",
    };
    assert.strictEqual(conv.session_id, null);
  });
});

describe("ConversationListItem type", () => {
  it("includes message_count field", () => {
    const item: ConversationListItem = {
      id: 1, agent: "claude-code", session_id: null, title: "Test",
      metadata: null, started_at: "2025-01-01", updated_at: "2025-01-01", message_count: 42,
    };
    assert.strictEqual(item.message_count, 42);
  });
});

describe("Message type", () => {
  it("has expected shape", () => {
    const msg: Message = {
      id: 1, conversation_id: 10, role: "user",
      content: "Hello", metadata: null, created_at: "2025-01-01",
    };
    assert.strictEqual(msg.role, "user");
    assert.strictEqual(msg.conversation_id, 10);
  });
});

describe("CreateConversationBody type", () => {
  it("requires agent, allows optional fields", () => {
    const body: CreateConversationBody = { agent: "claude-code" };
    assert.strictEqual(body.agent, "claude-code");
    assert.strictEqual(body.session_id, undefined);
  });
  it("accepts all optional fields", () => {
    const body: CreateConversationBody = {
      agent: "gpt", session_id: "sess-1",
      title: "My chat", metadata: { foo: "bar" },
    };
    assert.strictEqual(body.title, "My chat");
  });
});

describe("UpdateConversationBody type", () => {
  it("allows partial fields", () => {
    const body: UpdateConversationBody = { title: "New title" };
    assert.strictEqual(body.title, "New title");
    assert.strictEqual(body.metadata, undefined);
  });
});

describe("BulkMessageInput type", () => {
  it("has role and content, optional metadata", () => {
    const msg: BulkMessageInput = { role: "user", content: "hi" };
    assert.strictEqual(msg.role, "user");
    assert.strictEqual(msg.metadata, undefined);
  });
});

describe("BulkInsertBody type", () => {
  it("requires agent and messages array", () => {
    const body: BulkInsertBody = {
      agent: "claude-code",
      messages: [{ role: "user", content: "hello" }],
    };
    assert.strictEqual(body.agent, "claude-code");
    assert.strictEqual(body.messages.length, 1);
  });
});

describe("UpsertConversationBody type", () => {
  it("requires agent and session_id", () => {
    const body: UpsertConversationBody = {
      agent: "claude-code", session_id: "sess-abc",
    };
    assert.strictEqual(body.agent, "claude-code");
    assert.strictEqual(body.session_id, "sess-abc");
    assert.strictEqual(body.messages, undefined);
  });
  it("accepts optional messages array", () => {
    const body: UpsertConversationBody = {
      agent: "gpt", session_id: "sess-xyz",
      messages: [{ role: "assistant", content: "hi there" }],
    };
    assert.strictEqual(body.messages!.length, 1);
  });
});

describe("SearchMessagesBody type", () => {
  it("requires query, allows optional limit", () => {
    const body: SearchMessagesBody = { query: "hello world" };
    assert.strictEqual(body.query, "hello world");
    assert.strictEqual(body.limit, undefined);
  });
  it("accepts limit", () => {
    const body: SearchMessagesBody = { query: "test", limit: 50 };
    assert.strictEqual(body.limit, 50);
  });
});

describe("registerConversationRoutes", () => {
  it("is exported as a function", () => {
    assert.strictEqual(typeof registerConversationRoutes, "function");
  });
});
