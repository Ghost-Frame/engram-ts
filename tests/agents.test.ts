import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentRow,
  SafeAgentRow,
  RegisterAgentBody,
  InsertAgentResult,
  RevokeAgentBody,
  LinkKeyBody,
  AgentExecutionRow,
  AgentPassport,
  VerifyResult,
} from "../src/agents/types.ts";
import { registerAgentRoutes } from "../src/agents/routes.ts";

describe("AgentRow type", () => {
  it("has expected shape via type-level check", () => {
    const row: AgentRow = {
      id: 1,
      user_id: 1,
      name: "my-agent",
      category: null,
      description: null,
      code_hash: null,
      trust_score: 0.8,
      total_ops: 10,
      successful_ops: 9,
      failed_ops: 1,
      guard_allows: 8,
      guard_warns: 1,
      guard_blocks: 0,
      is_active: 1,
      last_seen_at: null,
      revoked_at: null,
      revoke_reason: null,
      created_at: "2025-01-01",
    };
    assert.strictEqual(row.id, 1);
    assert.strictEqual(row.name, "my-agent");
    assert.strictEqual(row.trust_score, 0.8);
  });
});

describe("SafeAgentRow type", () => {
  it("omits code_hash from AgentRow", () => {
    const safe: SafeAgentRow = {
      id: 2,
      user_id: 1,
      name: "safe-agent",
      category: "assistant",
      description: "A test agent",
      trust_score: 1.0,
      total_ops: 0,
      successful_ops: 0,
      failed_ops: 0,
      guard_allows: 0,
      guard_warns: 0,
      guard_blocks: 0,
      is_active: 1,
      last_seen_at: null,
      revoked_at: null,
      revoke_reason: null,
      created_at: "2025-01-01",
    };
    assert.strictEqual(safe.name, "safe-agent");
    assert.strictEqual(safe.category, "assistant");
    // code_hash should not be present on SafeAgentRow
    assert.strictEqual("code_hash" in safe, false);
  });
});

describe("RegisterAgentBody type", () => {
  it("requires name", () => {
    const body: RegisterAgentBody = { name: "my-agent" };
    assert.strictEqual(body.name, "my-agent");
    assert.strictEqual(body.category, undefined);
    assert.strictEqual(body.description, undefined);
    assert.strictEqual(body.code_hash, undefined);
  });

  it("accepts all optional fields", () => {
    const body: RegisterAgentBody = {
      name: "agent",
      category: "worker",
      description: "Does stuff",
      code_hash: "abc123",
    };
    assert.strictEqual(body.category, "worker");
    assert.strictEqual(body.code_hash, "abc123");
  });
});

describe("InsertAgentResult type", () => {
  it("has id, trust_score, and created_at", () => {
    const result: InsertAgentResult = { id: 10, trust_score: 0.5, created_at: "2025-01-01" };
    assert.strictEqual(result.id, 10);
    assert.strictEqual(result.trust_score, 0.5);
    assert.ok(result.created_at.length > 0);
  });
});

describe("RevokeAgentBody type", () => {
  it("has optional reason", () => {
    const body: RevokeAgentBody = { reason: "policy violation" };
    assert.strictEqual(body.reason, "policy violation");
    const empty: RevokeAgentBody = {};
    assert.strictEqual(empty.reason, undefined);
  });
});

describe("LinkKeyBody type", () => {
  it("has key_id", () => {
    const body: LinkKeyBody = { key_id: "key_abc123" };
    assert.strictEqual(body.key_id, "key_abc123");
  });
});

describe("AgentExecutionRow type", () => {
  it("has expected shape", () => {
    const row: AgentExecutionRow = {
      id: 1,
      action: "memory.store",
      target_type: "memory",
      target_id: 42,
      details: "stored fact",
      execution_hash: "deadbeef",
      signature: "sig123",
      created_at: "2025-01-01",
    };
    assert.strictEqual(row.id, 1);
    assert.strictEqual(row.action, "memory.store");
    assert.strictEqual(row.execution_hash, "deadbeef");
  });

  it("allows null optional fields", () => {
    const row: AgentExecutionRow = {
      id: 2,
      action: "verify",
      target_type: null,
      target_id: null,
      details: null,
      execution_hash: null,
      signature: null,
      created_at: "2025-01-01",
    };
    assert.strictEqual(row.target_type, null);
    assert.strictEqual(row.signature, null);
  });
});

describe("AgentPassport type", () => {
  it("has expected shape", () => {
    const passport: AgentPassport = {
      agent_id: 1,
      user_id: 1,
      name: "my-agent",
      trust_score: 0.9,
      issued_at: "2025-01-01T00:00:00Z",
      signature: "sig_abc",
    };
    assert.strictEqual(passport.agent_id, 1);
    assert.strictEqual(passport.trust_score, 0.9);
    assert.ok(passport.signature.length > 0);
  });
});

describe("VerifyResult type", () => {
  it("has type field", () => {
    const result: VerifyResult = { type: "passport", valid: true };
    assert.strictEqual(result.type, "passport");
    assert.strictEqual(result.valid, true);
  });
});

describe("registerAgentRoutes", () => {
  it("is exported as a function", () => {
    assert.strictEqual(typeof registerAgentRoutes, "function");
  });
});
