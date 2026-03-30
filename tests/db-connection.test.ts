import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("db connection", () => {
  it("exports a working db instance", async () => {
    const { db } = await import("../src/db/connection.ts");
    assert.ok(db, "db should be exported");
    const row = db.prepare("SELECT 1 as val").get() as { val: number };
    assert.equal(row.val, 1);
  });

  it("exports getSchemaVersion function", async () => {
    const { getSchemaVersion } = await import("../src/db/connection.ts");
    assert.equal(typeof getSchemaVersion, "function");
    const version = getSchemaVersion();
    assert.equal(typeof version, "number");
    assert.ok(version >= 0);
  });

  it("exports migrate function", async () => {
    const { migrate } = await import("../src/db/connection.ts");
    assert.equal(typeof migrate, "function");
  });

  it("has WAL journal mode", async () => {
    const { db } = await import("../src/db/connection.ts");
    const row = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    assert.equal(row[0].journal_mode, "wal");
  });
});
