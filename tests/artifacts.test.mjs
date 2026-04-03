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

  describe("Search integration", () => {
    it("POST /search returns artifact metadata on results", async () => {
      const { status, data } = await api("/search", {
        method: "POST",
        body: { query: "nginx config for test" },
      });
      assert.equal(status, 200);
      const match = data.results.find((r) => r.id === memoryId);
      assert.ok(match, "Should find the memory with artifact");
      assert.ok(Array.isArray(match.artifacts), "Result should have artifacts array");
      assert.equal(match.artifacts.length, 1);
      assert.equal(match.artifacts[0].filename, "nginx.conf");
      assert.ok(!match.artifacts[0].data, "Search should not include blob data");
    });

    it("POST /recall returns artifact metadata on results", async () => {
      const { status, data } = await api("/recall", {
        method: "POST",
        body: { context: "nginx config" },
      });
      assert.equal(status, 200);
      const match = data.memories.find((m) => m.id === memoryId);
      if (match) {
        assert.ok(Array.isArray(match.artifacts), "Recall result should have artifacts array");
      }
    });
  });

  describe("Edge cases", () => {
    it("stores multiple artifacts on one memory", async () => {
      const { status, data } = await api("/store", {
        method: "POST",
        body: {
          content: "Multi-file deployment",
          category: "task",
          source: "test",
          artifacts: [
            { filename: "config.json", mime_type: "application/json", data_base64: Buffer.from('{"key":"value"}').toString("base64") },
            { filename: "deploy.sh", mime_type: "text/x-shellscript", data_base64: Buffer.from("#!/bin/bash\necho deploy").toString("base64") },
          ],
        },
      });
      assert.ok(status === 200 || status === 201);
      assert.equal(data.artifacts.length, 2);
      const list = await api(`/artifacts/${data.id}`);
      assert.equal(list.data.artifacts.length, 2);
    });

    it("rejects store with too many artifacts", async () => {
      const artifacts = Array.from({ length: 11 }, (_, i) => ({
        filename: `file${i}.txt`,
        mime_type: "text/plain",
        data_base64: Buffer.from("x").toString("base64"),
      }));
      const { status } = await api("/store", {
        method: "POST",
        body: { content: "Too many files", category: "test", source: "test", artifacts },
      });
      assert.equal(status, 400);
    });

    it("rejects artifact missing filename", async () => {
      const { status } = await api("/store", {
        method: "POST",
        body: {
          content: "Bad artifact",
          category: "test",
          source: "test",
          artifacts: [{ data_base64: Buffer.from("x").toString("base64") }],
        },
      });
      assert.equal(status, 400);
    });

    it("rejects artifact missing data_base64", async () => {
      const { status } = await api("/store", {
        method: "POST",
        body: {
          content: "Bad artifact",
          category: "test",
          source: "test",
          artifacts: [{ filename: "test.txt" }],
        },
      });
      assert.equal(status, 400);
    });

    it("memory without artifacts returns empty artifacts array in search", async () => {
      const { data: storeData } = await api("/store", {
        method: "POST",
        body: { content: "No artifacts here unique-marker-12345", category: "test", source: "test" },
      });
      const { data: searchData } = await api("/search", {
        method: "POST",
        body: { query: "unique-marker-12345" },
      });
      const match = searchData.results.find((r) => r.id === storeData.id);
      if (match) {
        assert.ok(Array.isArray(match.artifacts));
        assert.equal(match.artifacts.length, 0);
      }
    });

    it("GET /artifact/:id returns 404 for nonexistent id", async () => {
      const res = await fetch(`${BASE}/artifact/999999`);
      assert.equal(res.status, 404);
    });

    it("GET /artifacts/stats returns usage stats", async () => {
      const { status, data } = await api("/artifacts/stats");
      assert.equal(status, 200);
      assert.ok(typeof data.total_count === "number");
      assert.ok(typeof data.total_bytes === "number");
      assert.ok(data.inline);
      assert.ok(data.disk);
    });
  });

  describe("Context integration", () => {
    it("POST /context returns artifact metadata on memories", async () => {
      const { status, data } = await api("/context", {
        method: "POST",
        body: { query: "nginx config", max_tokens: 4000 },
      });
      assert.equal(status, 200);
      const memories = data.semantic_matches || data.memories || data.results || [];
      const match = memories.find((m) => m.id === memoryId);
      if (match) {
        assert.ok(Array.isArray(match.artifacts));
      }
    });
  });
});
