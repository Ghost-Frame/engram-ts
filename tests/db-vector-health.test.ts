import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ENGRAM_DATA_DIR = mkdtempSync(join(tmpdir(), "engram-vector-health-"));

async function loadDb() {
  return import("../src/db/index.ts");
}

async function makeEmbeddingBuffer() {
  const { EMBEDDING_DIM } = await import("../src/config/index.ts");
  const embedding = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < embedding.length; i++) {
    embedding[i] = i + 0.25;
  }
  return { buffer: Buffer.from(embedding.buffer), dim: EMBEDDING_DIM };
}

describe("db vector health", () => {
  it("probeVectorHealth exercises the vector update path and rolls back", async () => {
    const { db, probeVectorHealth, updateMemoryVec, VECTOR_COL } = await loadDb();
    const { buffer } = await makeEmbeddingBuffer();

    const inserted = db.prepare(
      "INSERT INTO memories (content, category, source, embedding) VALUES (?, ?, ?, ?) RETURNING id"
    ).get("vector-health", "general", "test", buffer) as { id: number };

    const originalRun = updateMemoryVec.run.bind(updateMemoryVec);
    const originalPrepare = db.prepare.bind(db);
    let capturedArgs: unknown[] | null = null;
    let annProbeVector: string | null = null;
    mock.method(updateMemoryVec, "run", ((...args: any[]) => {
      capturedArgs = args;
      return originalRun(args[0] as string, args[1] as number);
    }) as any);
    mock.method(db, "prepare", ((sql: string) => {
      if (sql.includes(`${VECTOR_COL} MATCH vector(?)`)) {
        return {
          get: (vecJson: string) => {
            annProbeVector = vecJson;
            return { id: inserted.id };
          },
        };
      }
      return originalPrepare(sql);
    }) as any);

    try {
      assert.equal(probeVectorHealth(), true);
      assert.ok(capturedArgs, "probe should call the vector update statement");
      assert.equal(capturedArgs?.[1], inserted.id);
      assert.equal(typeof capturedArgs?.[0], "string");
      assert.match(String(capturedArgs?.[0]), /^\[/, "probe should pass vector JSON");
      assert.equal(annProbeVector, capturedArgs?.[0], "probe should reuse the same vector JSON for ANN verification");

      const row = db.prepare(`SELECT ${VECTOR_COL} IS NULL AS is_null FROM memories WHERE id = ?`).get(inserted.id) as { is_null: number };
      assert.equal(row.is_null, 1, "probe should roll back the vector write");
    } finally {
      db.prepare("DELETE FROM memories WHERE id = ?").run(inserted.id);
      mock.restoreAll();
    }
  });

  it("probeVectorHealth returns false on a corruption-shaped ANN probe failure", async () => {
    const { db, probeVectorHealth, VECTOR_COL } = await loadDb();
    const { buffer } = await makeEmbeddingBuffer();

    const inserted = db.prepare(
      "INSERT INTO memories (content, category, source, embedding) VALUES (?, ?, ?, ?) RETURNING id"
    ).get("vector-health-corrupt", "general", "test", buffer) as { id: number };
    const originalPrepare = db.prepare.bind(db);
    mock.method(db, "prepare", ((sql: string) => {
      if (sql.includes(`${VECTOR_COL} MATCH vector(?)`)) {
        return {
          get: () => {
            const err = new Error("malformed vector");
            (err as Error & { code?: string }).code = "SQLITE_CORRUPT";
            throw err;
          },
        };
      }
      return originalPrepare(sql);
    }) as any);

    try {
      assert.equal(probeVectorHealth(), false);
      const row = db.prepare(`SELECT ${VECTOR_COL} IS NULL AS is_null FROM memories WHERE id = ?`).get(inserted.id) as { is_null: number };
      assert.equal(row.is_null, 1, "failed probe should still roll back");
    } finally {
      db.prepare("DELETE FROM memories WHERE id = ?").run(inserted.id);
      mock.restoreAll();
    }
  });

  it("rebuildVectorIndex paginates with a stable id cursor", async () => {
    const { db, rebuildVectorIndex } = await loadDb();
    const { EMBEDDING_DIM } = await import("../src/config/index.ts");
    const makeEmbedding = (seed: number) => {
      const embedding = new Float32Array(EMBEDDING_DIM);
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] = seed + i;
      }
      return Buffer.from(embedding.buffer);
    };
    const memoryRowsByCursor = new Map<number, Array<{ id: number; embedding: Buffer }>>([
      [0, [
        { id: 1, embedding: makeEmbedding(1) },
        { id: 3, embedding: makeEmbedding(3) },
      ]],
      [3, [
        { id: 11, embedding: makeEmbedding(11) },
      ]],
    ]);
    const episodeRowsByCursor = new Map<number, Array<{ id: number; embedding: Buffer }>>([
      [0, [
        { id: 2, embedding: makeEmbedding(2) },
      ]],
    ]);

    const prepareCalls: string[] = [];
    const memorySelectCalls: Array<[number, number]> = [];
    const episodeSelectCalls: Array<[number, number]> = [];
    let repopulatedWrites = 0;

    const originalExec = db.exec;
    const originalTransaction = db.transaction;
    const originalPrepare = db.prepare;

    (db as any).exec = (() => undefined) as any;
    (db as any).transaction = ((fn: () => void) => () => fn()) as any;
    (db as any).prepare = ((sql: string) => {
      prepareCalls.push(sql);
      if (sql.includes("SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL")) {
        return { get: () => ({ count: 3 }) };
      }
      if (sql.includes("SELECT COUNT(*) as count FROM episodes WHERE embedding IS NOT NULL")) {
        return { get: () => ({ count: 1 }) };
      }
      if (sql.includes("SELECT id, embedding FROM memories")) {
        assert.ok(!sql.includes("OFFSET"), "memory scan should not use OFFSET pagination");
        return {
          all: (lastId: number, limit: number) => {
            memorySelectCalls.push([lastId, limit]);
            return memoryRowsByCursor.get(lastId) ?? [];
          },
        };
      }
      if (sql.includes("SELECT id, embedding FROM episodes")) {
        assert.ok(!sql.includes("OFFSET"), "episode scan should not use OFFSET pagination");
        return {
          all: (lastId: number, limit: number) => {
            episodeSelectCalls.push([lastId, limit]);
            return episodeRowsByCursor.get(lastId) ?? [];
          },
        };
      }
      return {
        run: () => {
          repopulatedWrites++;
        },
      };
    }) as any;

    try {
      const result = rebuildVectorIndex();
      assert.equal(result.repopulated, 4);
      assert.equal(repopulatedWrites, 4);
      assert.deepEqual(memorySelectCalls, [[0, 100], [3, 100], [11, 100]]);
      assert.deepEqual(episodeSelectCalls, [[0, 100], [2, 100]]);
      assert.ok(prepareCalls.some((sql) => sql.includes("SELECT id, embedding FROM memories WHERE embedding IS NOT NULL AND id > ? ORDER BY id LIMIT ?")));
      assert.ok(prepareCalls.some((sql) => sql.includes("SELECT id, embedding FROM episodes WHERE embedding IS NOT NULL AND id > ? ORDER BY id LIMIT ?")));
    } finally {
      (db as any).prepare = originalPrepare;
      (db as any).transaction = originalTransaction;
      (db as any).exec = originalExec;
      mock.restoreAll();
    }
  });

  it("rebuildVectorIndex fails closed when repopulation is incomplete", async () => {
    const { db, rebuildVectorIndex } = await loadDb();
    const { buffer } = await makeEmbeddingBuffer();
    const invalid = Buffer.from([1, 2, 3]);

    const originalExec = db.exec;
    const originalTransaction = db.transaction;
    const originalPrepare = db.prepare;

    (db as any).exec = (() => undefined) as any;
    (db as any).transaction = ((fn: () => void) => () => fn()) as any;
    (db as any).prepare = ((sql: string) => {
      if (sql.includes("SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL")) {
        return { get: () => ({ count: 2 }) };
      }
      if (sql.includes("SELECT COUNT(*) as count FROM episodes WHERE embedding IS NOT NULL")) {
        return { get: () => ({ count: 1 }) };
      }
      if (sql.includes("SELECT id, embedding FROM memories")) {
        return {
          all: (lastId: number) => lastId === 0
            ? [
                { id: 1, embedding: buffer },
                { id: 2, embedding: invalid },
              ]
            : [],
        };
      }
      if (sql.includes("SELECT id, embedding FROM episodes")) {
        return {
          all: (lastId: number) => lastId === 0
            ? [{ id: 3, embedding: buffer }]
            : [],
        };
      }
      if (sql.includes("MATCH vector(?)")) {
        return { get: () => ({ id: 1 }) };
      }
      return {
        run: () => undefined,
      };
    }) as any;

    try {
      assert.throws(
        () => rebuildVectorIndex(),
        /incomplete|mismatch|rebuild/i,
      );
    } finally {
      (db as any).prepare = originalPrepare;
      (db as any).transaction = originalTransaction;
      (db as any).exec = originalExec;
      mock.restoreAll();
    }
  });
});
