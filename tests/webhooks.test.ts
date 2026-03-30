import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  WebhookRow,
  CreateWebhookBody,
  InsertWebhookResult,
  SyncChangeRow,
  SyncExistingRow,
  SyncMemoryPayload,
} from "../src/webhooks/types.ts";
import { registerWebhookRoutes } from "../src/webhooks/routes.ts";

describe("WebhookRow type", () => {
  it("has expected shape via type-level check", () => {
    const row: WebhookRow = {
      id: 1,
      url: "https://example.com/hook",
      events: '["*"]',
      active: 1,
      last_triggered_at: null,
      failure_count: 0,
      created_at: "2025-01-01",
    };
    assert.strictEqual(row.id, 1);
    assert.strictEqual(row.url, "https://example.com/hook");
    assert.strictEqual(row.active, 1);
  });
});

describe("CreateWebhookBody type", () => {
  it("requires url", () => {
    const body: CreateWebhookBody = { url: "https://example.com/hook" };
    assert.strictEqual(body.url, "https://example.com/hook");
    assert.strictEqual(body.events, undefined);
    assert.strictEqual(body.secret, undefined);
  });

  it("accepts optional events and secret", () => {
    const body: CreateWebhookBody = {
      url: "https://example.com/hook",
      events: ["memory.store", "memory.delete"],
      secret: "mysecret",
    };
    assert.strictEqual(body.events?.length, 2);
    assert.strictEqual(body.secret, "mysecret");
  });
});

describe("InsertWebhookResult type", () => {
  it("has id and created_at", () => {
    const result: InsertWebhookResult = { id: 42, created_at: "2025-01-01T00:00:00" };
    assert.strictEqual(result.id, 42);
    assert.ok(result.created_at.length > 0);
  });
});

describe("SyncChangeRow type", () => {
  it("has expected shape", () => {
    const row: SyncChangeRow = {
      id: 1,
      content: "test memory",
      category: "general",
      source: "sync",
      session_id: null,
      importance: 5,
      tags: null,
      confidence: 1.0,
      sync_id: "abc-123",
      is_static: 0,
      is_forgotten: 0,
      is_archived: 0,
      version: 1,
      created_at: "2025-01-01",
      updated_at: "2025-01-01",
    };
    assert.strictEqual(row.id, 1);
    assert.strictEqual(row.sync_id, "abc-123");
    assert.strictEqual(row.confidence, 1.0);
  });
});

describe("SyncExistingRow type", () => {
  it("has id and updated_at", () => {
    const row: SyncExistingRow = { id: 5, updated_at: "2025-06-01T00:00:00" };
    assert.strictEqual(row.id, 5);
    assert.ok(row.updated_at.length > 0);
  });
});

describe("SyncMemoryPayload type", () => {
  it("requires sync_id and content", () => {
    const mem: SyncMemoryPayload = { sync_id: "abc", content: "hello" };
    assert.strictEqual(mem.sync_id, "abc");
    assert.strictEqual(mem.content, "hello");
    assert.strictEqual(mem.category, undefined);
  });

  it("accepts all optional fields", () => {
    const mem: SyncMemoryPayload = {
      sync_id: "abc",
      content: "hello",
      category: "fact",
      source: "remote",
      importance: 7,
      tags: ["a", "b"],
      confidence: 0.9,
      is_static: false,
      is_forgotten: false,
      is_archived: false,
      version: 2,
      model: "gpt-4",
      updated_at: "2025-01-01",
    };
    assert.strictEqual(mem.importance, 7);
    assert.strictEqual(mem.confidence, 0.9);
    assert.deepStrictEqual(mem.tags, ["a", "b"]);
  });
});

describe("registerWebhookRoutes", () => {
  it("is exported as a function", () => {
    assert.strictEqual(typeof registerWebhookRoutes, "function");
  });
});
