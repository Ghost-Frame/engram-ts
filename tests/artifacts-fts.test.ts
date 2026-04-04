import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("artifact FTS config", () => {
  it("ARTIFACT_FTS_MAX_SIZE defaults to 102400", async () => {
    const { ARTIFACT_FTS_MAX_SIZE } = await import("../src/config/index.ts");
    assert.equal(ARTIFACT_FTS_MAX_SIZE, 102400);
  });
});

describe("artifact FTS schema", () => {
  it("artifacts table has is_indexed column", async () => {
    const { db } = await import("../src/db/connection.ts");
    const cols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes("is_indexed"), "missing is_indexed column");
  });

  it("artifacts table has is_encrypted column", async () => {
    const { db } = await import("../src/db/connection.ts");
    const cols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes("is_encrypted"), "missing is_encrypted column");
  });

  it("artifacts_fts virtual table exists", async () => {
    const { db } = await import("../src/db/connection.ts");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts_fts'").all() as Array<{ name: string }>;
    assert.equal(tables.length, 1);
  });
});
