import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("fsrs domain", () => {
  it("registerFsrsRoutes is exported as a function", async () => {
    const mod = await import("../src/fsrs/routes.ts");
    assert.equal(typeof mod.registerFsrsRoutes, "function");
  });

  it("fsrs db exports getFSRSForUser as a prepared statement", async () => {
    const mod = await import("../src/fsrs/db.ts");
    assert.ok(mod.getFSRSForUser, "getFSRSForUser should be exported");
    assert.equal(typeof mod.getFSRSForUser.get, "function");
  });

  it("fsrs db exports updateFSRS as a prepared statement", async () => {
    const mod = await import("../src/fsrs/db.ts");
    assert.ok(mod.updateFSRS, "updateFSRS should be exported");
    assert.equal(typeof mod.updateFSRS.run, "function");
  });

  it("fsrs db exports getMemoryWithoutEmbedding as a prepared statement", async () => {
    const mod = await import("../src/fsrs/db.ts");
    assert.ok(mod.getMemoryWithoutEmbedding, "getMemoryWithoutEmbedding should be exported");
    assert.equal(typeof mod.getMemoryWithoutEmbedding.get, "function");
  });

  it("fsrs db exports getUninitializedFSRS as a function", async () => {
    const mod = await import("../src/fsrs/db.ts");
    assert.equal(typeof mod.getUninitializedFSRS, "function");
  });
});
