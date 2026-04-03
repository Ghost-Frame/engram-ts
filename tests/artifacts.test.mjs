import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.ENGRAM_URL || "http://127.0.0.1:4201";

async function api(path, opts = {}) {
  const { method = "GET", body, headers = {} } = opts;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("json") ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers };
}

describe("Artifact Storage", () => {
  let memoryId;

  describe("Store with artifacts", () => {
    it("POST /store with artifacts array creates memory and artifacts", async () => {
      const content = Buffer.from("server { listen 80; }").toString("base64");
      const { status, data } = await api("/store", {
        method: "POST",
        body: {
          content: "Generated nginx config for test",
          category: "task",
          source: "test",
          artifacts: [
            {
              filename: "nginx.conf",
              mime_type: "text/plain",
              data_base64: content,
            },
          ],
        },
      });
      assert.ok(status === 200 || status === 201, `Expected 2xx, got ${status}`);
      assert.ok(data.stored, "Memory should be stored");
      assert.ok(data.id, "Should return memory id");
      assert.ok(Array.isArray(data.artifacts), "Should return artifacts array");
      assert.equal(data.artifacts.length, 1);
      assert.equal(data.artifacts[0].filename, "nginx.conf");
      assert.ok(data.artifacts[0].id, "Artifact should have an id");
      assert.ok(data.artifacts[0].size_bytes > 0, "Should report size");
      memoryId = data.id;
    });
  });
});
