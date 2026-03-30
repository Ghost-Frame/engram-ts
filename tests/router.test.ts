import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/router/index.ts";

// Helper to make a minimal Request
function makeReq(method: string, url: string): Request {
  return new Request(url, { method });
}

describe("router", () => {
  it("exports createRouter function", () => {
    assert.strictEqual(typeof createRouter, "function");
  });

  it("matches GET route and calls handler", async () => {
    const router = createRouter();
    router.get("/ping", async (_req, _params) => {
      return new Response("pong", { status: 200 });
    });
    const res = await router.handle(makeReq("GET", "http://localhost/ping"));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), "pong");
  });

  it("matches POST route", async () => {
    const router = createRouter();
    router.post("/items", async (_req, _params) => {
      return new Response("created", { status: 201 });
    });
    const res = await router.handle(makeReq("POST", "http://localhost/items"));
    assert.strictEqual(res.status, 201);
  });

  it("extracts single path parameter", async () => {
    const router = createRouter();
    let capturedId = "";
    router.get("/memory/:id", async (_req, params) => {
      capturedId = params.id;
      return new Response("ok", { status: 200 });
    });
    await router.handle(makeReq("GET", "http://localhost/memory/42"));
    assert.strictEqual(capturedId, "42");
  });

  it("extracts multiple path parameters", async () => {
    const router = createRouter();
    let capturedEid = "";
    let capturedMid = "";
    router.get("/entities/:eid/memories/:mid", async (_req, params) => {
      capturedEid = params.eid;
      capturedMid = params.mid;
      return new Response("ok", { status: 200 });
    });
    await router.handle(makeReq("GET", "http://localhost/entities/abc/memories/xyz"));
    assert.strictEqual(capturedEid, "abc");
    assert.strictEqual(capturedMid, "xyz");
  });

  it("returns 404 for unmatched route", async () => {
    const router = createRouter();
    router.get("/exists", async () => new Response("ok", { status: 200 }));
    const res = await router.handle(makeReq("GET", "http://localhost/does-not-exist"));
    assert.strictEqual(res.status, 404);
    const body = await res.json() as { error: string };
    assert.strictEqual(body.error, "Not found");
  });

  it("runs middleware in order", async () => {
    const router = createRouter();
    const order: number[] = [];

    router.use(async (_req, _params, next) => {
      order.push(1);
      return next();
    });
    router.use(async (_req, _params, next) => {
      order.push(2);
      return next();
    });
    router.use(async (_req, _params, next) => {
      order.push(3);
      return next();
    });

    router.get("/test", async () => new Response("ok", { status: 200 }));

    await router.handle(makeReq("GET", "http://localhost/test"));
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it("middleware can short-circuit without calling handler", async () => {
    const router = createRouter();
    let handlerCalled = false;

    router.use(async (_req, _params, _next) => {
      return new Response("forbidden", { status: 403 });
    });

    router.get("/secret", async () => {
      handlerCalled = true;
      return new Response("secret data", { status: 200 });
    });

    const res = await router.handle(makeReq("GET", "http://localhost/secret"));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(handlerCalled, false);
  });

  it("supports route grouping with prefix", async () => {
    const router = createRouter();

    router.group("/admin", (r) => {
      r.get("/stats", async () => new Response("admin stats", { status: 200 }));
    });

    const res = await router.handle(makeReq("GET", "http://localhost/admin/stats"));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), "admin stats");
  });

  it("matches routes when query strings are present", async () => {
    const router = createRouter();
    router.get("/search", async (_req, _params) => {
      return new Response("results", { status: 200 });
    });
    const res = await router.handle(makeReq("GET", "http://localhost/search?q=test"));
    assert.strictEqual(res.status, 200);
  });

  it("supports DELETE and PATCH methods", async () => {
    const router = createRouter();
    router.delete("/items/:id", async (_req, params) => {
      return new Response(`deleted ${params.id}`, { status: 200 });
    });
    router.patch("/items/:id", async (_req, params) => {
      return new Response(`patched ${params.id}`, { status: 200 });
    });

    const delRes = await router.handle(makeReq("DELETE", "http://localhost/items/99"));
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(await delRes.text(), "deleted 99");

    const patchRes = await router.handle(makeReq("PATCH", "http://localhost/items/77"));
    assert.strictEqual(patchRes.status, 200);
    assert.strictEqual(await patchRes.text(), "patched 77");
  });

  it("handles OPTIONS for CORS preflight with 204", async () => {
    const router = createRouter();
    router.get("/api/data", async () => new Response("data", { status: 200 }));

    const res = await router.handle(makeReq("OPTIONS", "http://localhost/api/data"));
    assert.strictEqual(res.status, 204);
  });
});
