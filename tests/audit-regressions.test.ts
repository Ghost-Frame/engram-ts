import { describe, it } from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";

process.env.ENGRAM_OPEN_ACCESS = "1";

describe("audit regressions", () => {
  it("rejects expired api keys in authenticate()", async () => {
    const { db } = await import("../src/db/index.ts");
    const { authenticate, generateApiKey } = await import("../src/auth/index.ts");

    const { key, prefix, hash } = generateApiKey();
    const expiresAt = "2000-01-01 00:00:00";

    db.prepare(
      "INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(1, prefix, hash, "expired-regression-key", "read", 10, expiresAt);

    try {
      const auth = authenticate(new Request("http://127.0.0.1/", {
        headers: { Authorization: `Bearer ${key}` },
      }));

      assert.ok(auth && typeof auth === "object" && "error" in auth, "expired key should return an auth error");
      assert.equal((auth as { error: string }).error, "API key expired");
    } finally {
      db.prepare("DELETE FROM api_keys WHERE key_prefix = ? AND key_hash = ?").run(prefix, hash);
    }
  });

  it("blocks mutating service routes in open-access mode", async () => {
    const { fetchHandler } = await import("../src/routes/index.ts");
    const requests = [
      new Request("http://127.0.0.1/tasks", { method: "POST" }),
      new Request("http://127.0.0.1/axon/publish", { method: "POST" }),
      new Request("http://127.0.0.1/soma/agents", { method: "POST" }),
      new Request("http://127.0.0.1/thymus/rubrics", { method: "POST" }),
      new Request("http://127.0.0.1/skills/sync", { method: "POST" }),
      new Request("http://127.0.0.1/skills/upload", { method: "POST" }),
      new Request("http://127.0.0.1/skills/execute", { method: "POST" }),
      new Request("http://127.0.0.1/skills/demo", { method: "DELETE" }),
      new Request("http://127.0.0.1/skills/demo/fix", { method: "POST" }),
    ];

    for (const request of requests) {
      const res = await fetchHandler(request, "127.0.0.1");
      assert.equal(res.status, 403, `${new URL(request.url).pathname} should be blocked in open access mode`);
    }
  });

  it("rejects private IPv6 literals in /fetch without outbound fetch", async () => {
    let fetchCalls = 0;
    mock.method(globalThis, "fetch", async () => {
      fetchCalls++;
      throw new Error("outbound fetch should not be called");
    });

    try {
      const { fetchHandler } = await import("../src/routes/index.ts");
      const body = JSON.stringify({ url: "http://[::1]/", cache: false });
      const res = await fetchHandler(new Request("http://127.0.0.1/fetch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
        body,
      }), "127.0.0.1");

      const json = await res.json();
      assert.equal(res.status, 400);
      assert.match(json.error, /private\/internal addresses|Invalid URL|cannot point to private/i);
      assert.equal(fetchCalls, 0);
    } finally {
      mock.restoreAll();
    }
  });
});
