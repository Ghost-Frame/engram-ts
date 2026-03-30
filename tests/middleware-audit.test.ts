import { test } from "node:test";
import assert from "node:assert/strict";
import { auditLog, emitEvent, setWebhookEmitter } from "../src/middleware/audit.ts";

test("exports auditLog function", () => {
  assert.strictEqual(typeof auditLog, "function");
});

test("exports emitEvent function", () => {
  assert.strictEqual(typeof emitEvent, "function");
});

test("exports setWebhookEmitter function", () => {
  assert.strictEqual(typeof setWebhookEmitter, "function");
});
