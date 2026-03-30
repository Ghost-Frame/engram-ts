// tests/middleware-auth.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("auth middleware", () => {
  it("exports createAuthMiddleware function", async () => {
    const mod = await import("../src/middleware/auth.ts");
    assert.equal(typeof mod.createAuthMiddleware, "function");
  });

  it("exports parseBody helper", async () => {
    const mod = await import("../src/middleware/auth.ts");
    assert.equal(typeof mod.parseBody, "function");
  });

  it("exports getClientIp helper", async () => {
    const mod = await import("../src/middleware/auth.ts");
    assert.equal(typeof mod.getClientIp, "function");
  });
});
