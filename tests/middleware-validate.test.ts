import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requireString,
  optionalInt,
  clampInt,
  requireBody,
  ValidationError,
} from "../src/middleware/validate.ts";

test("exports requireString", () => {
  assert.strictEqual(typeof requireString, "function");
});

test("requireString returns value for valid string", () => {
  assert.strictEqual(requireString("hello", "field"), "hello");
  assert.strictEqual(requireString("  trimmed  ", "field"), "trimmed");
});

test("requireString throws for empty string", () => {
  assert.throws(() => requireString("", "name"), /name is required/);
  assert.throws(() => requireString("   ", "name"), /name is required/);
});

test("requireString throws for non-string", () => {
  assert.throws(() => requireString(42, "name"), /name must be a string/);
  assert.throws(() => requireString(null, "name"), /name must be a string/);
});

test("optionalInt returns parsed int or default", () => {
  assert.strictEqual(optionalInt("42", 10), 42);
  assert.strictEqual(optionalInt(undefined, 10), 10);
  assert.strictEqual(optionalInt("abc", 10), 10);
});

test("clampInt clamps to range", () => {
  assert.strictEqual(clampInt(5, 1, 10), 5);
  assert.strictEqual(clampInt(0, 1, 10), 1);
  assert.strictEqual(clampInt(100, 1, 10), 10);
});

test("requireBody returns validated body fields", () => {
  const body = { name: "test", value: 42 };
  const result = requireBody(body, ["name", "value"]);
  assert.strictEqual(result["name"], "test");
  assert.strictEqual(result["value"], 42);
});

test("requireBody throws for missing required fields", () => {
  const body = { value: 42 };
  assert.throws(() => requireBody(body, ["name"]), /name is required/);
});
