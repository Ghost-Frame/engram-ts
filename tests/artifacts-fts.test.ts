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

describe("isIndexableMimeType", () => {
  it("indexes text/* types", async () => {
    const { isIndexableMimeType } = await import("../src/artifacts/fts.ts");
    assert.ok(isIndexableMimeType("text/plain"));
    assert.ok(isIndexableMimeType("text/html"));
    assert.ok(isIndexableMimeType("text/csv"));
    assert.ok(isIndexableMimeType("text/markdown"));
  });

  it("indexes application code types", async () => {
    const { isIndexableMimeType } = await import("../src/artifacts/fts.ts");
    assert.ok(isIndexableMimeType("application/json"));
    assert.ok(isIndexableMimeType("application/yaml"));
    assert.ok(isIndexableMimeType("application/x-yaml"));
    assert.ok(isIndexableMimeType("application/xml"));
    assert.ok(isIndexableMimeType("application/javascript"));
    assert.ok(isIndexableMimeType("application/typescript"));
    assert.ok(isIndexableMimeType("application/toml"));
    assert.ok(isIndexableMimeType("application/x-sh"));
    assert.ok(isIndexableMimeType("application/x-python"));
  });

  it("rejects binary types", async () => {
    const { isIndexableMimeType } = await import("../src/artifacts/fts.ts");
    assert.ok(!isIndexableMimeType("image/png"));
    assert.ok(!isIndexableMimeType("application/octet-stream"));
    assert.ok(!isIndexableMimeType("application/zip"));
    assert.ok(!isIndexableMimeType("audio/mpeg"));
  });
});

describe("indexArtifact", () => {
  it("indexes text artifact and marks is_indexed", async () => {
    const { db } = await import("../src/db/connection.ts");
    const { indexArtifact } = await import("../src/artifacts/fts.ts");

    const memResult = db.prepare(
      "INSERT INTO memories (content, category, importance, user_id, embedding) VALUES (?, ?, ?, ?, zeroblob(4)) RETURNING id"
    ).get("test memory for fts", "test", 5, 1) as { id: number };

    const artResult = db.prepare(
      "INSERT INTO artifacts (memory_id, filename, mime_type, size_bytes, sha256, storage_mode, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
    ).get(memResult.id, "config.json", "application/json", 20, "abc123fts", "inline", Buffer.from('{"key":"value"}')) as { id: number };

    const indexed = indexArtifact(artResult.id, "application/json", Buffer.from('{"key":"value"}'));
    assert.ok(indexed, "should have indexed the artifact");

    const row = db.prepare("SELECT is_indexed FROM artifacts WHERE id = ?").get(artResult.id) as { is_indexed: number };
    assert.equal(row.is_indexed, 1);

    const ftsResult = db.prepare("SELECT rowid FROM artifacts_fts WHERE content MATCH 'key'").all();
    assert.ok(ftsResult.length > 0, "FTS should find the content");
  });

  it("skips binary artifacts", async () => {
    const { indexArtifact } = await import("../src/artifacts/fts.ts");
    const result = indexArtifact(99999, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(result, false);
  });
});
