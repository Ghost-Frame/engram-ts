# Artifact Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add transactional artifact storage to Engram so agents can attach files to memories and find them via semantic search.

**Architecture:** New `artifacts` table with FK to memories. Small files (under 1MB) stored inline as BLOBs, large files on disk at `$ENGRAM_DATA_DIR/artifacts/<hash_prefix>/<sha256>`. Content-addressable dedup for disk files. Artifacts surface as metadata in search/recall/context responses, downloadable via dedicated endpoints.

**Tech Stack:** TypeScript, LibSQL, Node.js crypto (sha256), node:fs for disk writes, node:test for testing.

**Deferred:** Multipart/form-data upload support. The codebase currently has zero multipart handling and adding it would require a new dependency (e.g. busboy). Base64 JSON covers the use case for now. Multipart can be added later if agents need to stream large files without base64 overhead.

---

### Task 1: Schema Migration and Prepared Statements

**Files:**
- Modify: `src/db/connection.ts` (add artifacts table in migration section)
- Modify: `src/db/index.ts` (add prepared statements)

- [ ] **Step 1: Write the failing test**

Create `tests/artifacts.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: FAIL -- /store does not handle `artifacts` field yet.

- [ ] **Step 3: Add artifacts table migration to connection.ts**

In `src/db/connection.ts`, after the existing migration blocks, add:

```typescript
// v5.12: Artifact storage
migrate(`CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_mode TEXT NOT NULL DEFAULT 'inline',
  data BLOB,
  disk_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
migrate("CREATE INDEX IF NOT EXISTS idx_artifacts_memory ON artifacts(memory_id)");
migrate("CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(sha256)");
setSchemaVersion(512, "artifact storage table");
```

- [ ] **Step 4: Add prepared statements to db/index.ts**

In `src/db/index.ts`, add:

```typescript
export const insertArtifact = db.prepare(
  `INSERT INTO artifacts (memory_id, filename, mime_type, size_bytes, sha256, storage_mode, data, disk_path)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   RETURNING id, created_at`
);

export const getArtifactsByMemory = db.prepare(
  `SELECT id, filename, mime_type, size_bytes, sha256, storage_mode, created_at
   FROM artifacts WHERE memory_id = ?`
);

export const getArtifactById = db.prepare(
  `SELECT id, memory_id, filename, mime_type, size_bytes, sha256, storage_mode, data, disk_path, created_at
   FROM artifacts WHERE id = ?`
);

export const getArtifactDiskRefCount = db.prepare(
  `SELECT COUNT(*) as count FROM artifacts WHERE disk_path = ?`
);

export const getArtifactStats = db.prepare(
  `SELECT
     COUNT(*) as total_count,
     SUM(size_bytes) as total_bytes,
     SUM(CASE WHEN storage_mode = 'inline' THEN size_bytes ELSE 0 END) as inline_bytes,
     SUM(CASE WHEN storage_mode = 'disk' THEN size_bytes ELSE 0 END) as disk_bytes,
     SUM(CASE WHEN storage_mode = 'inline' THEN 1 ELSE 0 END) as inline_count,
     SUM(CASE WHEN storage_mode = 'disk' THEN 1 ELSE 0 END) as disk_count
   FROM artifacts`
);
```

- [ ] **Step 5: Commit**

```bash
git add src/db/connection.ts src/db/index.ts tests/artifacts.test.mjs
git commit -m "feat: add artifacts table schema, prepared statements, and test scaffold"
```

---

### Task 2: Config and Disk Storage Utilities

**Files:**
- Modify: `src/config/index.ts` (add artifact config vars)
- Create: `src/artifacts/storage.ts` (disk write/read/delete utilities)

- [ ] **Step 1: Write the failing test**

Add to `tests/artifacts.test.mjs`:

```javascript
describe("Artifact retrieval", () => {
  it("GET /artifacts/:memoryId lists artifacts for a memory", async () => {
    const { status, data } = await api(`/artifacts/${memoryId}`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.artifacts));
    assert.equal(data.artifacts.length, 1);
    assert.equal(data.artifacts[0].filename, "nginx.conf");
    assert.ok(!data.artifacts[0].data, "List should not include blob data");
  });

  it("GET /artifact/:id downloads the artifact content", async () => {
    const listRes = await api(`/artifacts/${memoryId}`);
    const artifactId = listRes.data.artifacts[0].id;

    const res = await fetch(`${BASE}/artifact/${artifactId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain");
    const body = await res.text();
    assert.equal(body, "server { listen 80; }");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: FAIL -- endpoints don't exist yet.

- [ ] **Step 3: Add config vars to config/index.ts**

In `src/config/index.ts`, add:

```typescript
// Artifact storage
export const ARTIFACT_SIZE_THRESHOLD = Number(process.env.ENGRAM_ARTIFACT_SIZE_THRESHOLD || 1_048_576); // 1MB
export const MAX_ARTIFACT_SIZE = Number(process.env.ENGRAM_MAX_ARTIFACT_SIZE || 52_428_800); // 50MB
export const MAX_ARTIFACTS_PER_MEMORY = Number(process.env.ENGRAM_MAX_ARTIFACTS_PER_MEMORY || 10);
export const ARTIFACT_DIR = resolve(DATA_DIR, "artifacts");
```

- [ ] **Step 4: Create src/artifacts/storage.ts**

```typescript
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { ARTIFACT_DIR, ARTIFACT_SIZE_THRESHOLD } from "../config/index.ts";
import { log } from "../config/index.ts";

export interface ArtifactInput {
  filename: string;
  mime_type?: string;
  data_base64: string;
}

export interface StoredArtifact {
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_mode: "inline" | "disk";
  data: Buffer | null;
  disk_path: string | null;
}

export function processArtifact(input: ArtifactInput): StoredArtifact {
  const data = Buffer.from(input.data_base64, "base64");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const mime = input.mime_type || "application/octet-stream";
  const size = data.length;

  if (size <= ARTIFACT_SIZE_THRESHOLD) {
    return {
      filename: input.filename,
      mime_type: mime,
      size_bytes: size,
      sha256,
      storage_mode: "inline",
      data,
      disk_path: null,
    };
  }

  // Disk storage
  const prefix = sha256.slice(0, 2);
  const dir = resolve(ARTIFACT_DIR, prefix);
  const filePath = join(dir, sha256);

  if (!existsSync(filePath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, data);
  }

  return {
    filename: input.filename,
    mime_type: mime,
    size_bytes: size,
    sha256,
    storage_mode: "disk",
    data: null,
    disk_path: filePath,
  };
}

export function readArtifactFromDisk(diskPath: string): Buffer {
  return readFileSync(diskPath);
}

export function deleteArtifactFromDisk(diskPath: string): void {
  try {
    if (existsSync(diskPath)) {
      unlinkSync(diskPath);
      log.info({ msg: "artifact_disk_deleted", path: diskPath });
    }
  } catch (e: any) {
    log.warn({ msg: "artifact_disk_delete_failed", path: diskPath, error: e.message });
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/config/index.ts src/artifacts/storage.ts
git commit -m "feat: add artifact config vars and disk storage utilities"
```

---

### Task 3: Store Handler -- Accept Artifacts

**Files:**
- Modify: `src/memory/routes.ts` (extend /store to process artifacts)
- Modify: `src/db/index.ts` (import if needed)

- [ ] **Step 1: Add artifact processing to the store handler**

In `src/memory/routes.ts`, after the memory insert and post-insert metadata block (after the `db.prepare("UPDATE memories SET tags = ...").run(...)` call), add:

```typescript
import { processArtifact, ArtifactInput } from "../artifacts/storage.ts";
import { insertArtifact } from "../db/index.ts";
import { MAX_ARTIFACT_SIZE, MAX_ARTIFACTS_PER_MEMORY } from "../config/index.ts";
```

Then in the handler, after the FSRS initialization block and before the webhook emit:

```typescript
      // Artifact storage
      const artifactResults: Array<{ id: number; filename: string; size_bytes: number; storage_mode: string }> = [];
      if (Array.isArray(b?.artifacts) && b.artifacts.length > 0) {
        if (b.artifacts.length > MAX_ARTIFACTS_PER_MEMORY) {
          return errorResponse(`Too many artifacts (max ${MAX_ARTIFACTS_PER_MEMORY})`, 400, requestId);
        }

        for (const rawArtifact of b.artifacts) {
          if (!rawArtifact.filename || !rawArtifact.data_base64) {
            return errorResponse("Each artifact requires filename and data_base64", 400, requestId);
          }

          const decoded = Buffer.from(rawArtifact.data_base64, "base64");
          if (decoded.length > MAX_ARTIFACT_SIZE) {
            return errorResponse(`Artifact "${rawArtifact.filename}" exceeds max size (${MAX_ARTIFACT_SIZE} bytes)`, 413, requestId);
          }

          const stored = processArtifact(rawArtifact as ArtifactInput);
          const artResult = insertArtifact.get(
            result.id,
            stored.filename,
            stored.mime_type,
            stored.size_bytes,
            stored.sha256,
            stored.storage_mode,
            stored.data,
            stored.disk_path
          ) as { id: number; created_at: string };

          artifactResults.push({
            id: artResult.id,
            filename: stored.filename,
            size_bytes: stored.size_bytes,
            storage_mode: stored.storage_mode,
          });
        }
      }
```

Then update the response to include artifacts:

```typescript
      const response = json({
        stored: true,
        id: result.id,
        created_at: result.created_at,
        importance: imp,
        linked: 0,
        embedded: !!embBuffer,
        tags: tagsJson ? JSON.parse(tagsJson) : [],
        episode_id: episodeId,
        decay_score: decayScore,
        fact_extraction: isLLMAvailable() ? "queued" : "disabled",
        status: memStatus,
        model: (model && typeof model === "string") ? model.trim() : null,
        ...(artifactResults.length > 0 ? { artifacts: artifactResults } : {}),
      }, 201);
```

- [ ] **Step 2: Run the store test to verify it passes**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: The "POST /store with artifacts" test passes. Retrieval tests still fail.

- [ ] **Step 3: Commit**

```bash
git add src/memory/routes.ts
git commit -m "feat: extend /store to accept and persist artifacts"
```

---

### Task 4: Retrieval Endpoints

**Files:**
- Modify: `src/routes/index.ts` (add GET /artifacts/:memoryId and GET /artifact/:id)

- [ ] **Step 1: Add the list endpoint**

In `src/routes/index.ts`, in the route handler section (near other GET endpoints), add:

```typescript
import { getArtifactsByMemory, getArtifactById, getArtifactDiskRefCount, getArtifactStats } from "../db/index.ts";
import { readArtifactFromDisk } from "../artifacts/storage.ts";
```

Then add the route handler:

```typescript
  // GET /artifacts/:memoryId -- list artifacts for a memory
  if (url.pathname.match(/^\/artifacts\/(\d+)$/) && method === "GET") {
    const memoryId = Number(url.pathname.split("/")[2]);
    const rows = getArtifactsByMemory.all(memoryId) as Array<{
      id: number; filename: string; mime_type: string; size_bytes: number;
      sha256: string; storage_mode: string; created_at: string;
    }>;
    return json({ artifacts: rows, memory_id: memoryId });
  }
```

- [ ] **Step 2: Add the download endpoint**

```typescript
  // GET /artifact/:id -- download a single artifact
  if (url.pathname.match(/^\/artifact\/(\d+)$/) && method === "GET") {
    const artifactId = Number(url.pathname.split("/")[2]);
    const row = getArtifactById.get(artifactId) as {
      id: number; memory_id: number; filename: string; mime_type: string;
      size_bytes: number; sha256: string; storage_mode: string;
      data: Buffer | null; disk_path: string | null; created_at: string;
    } | undefined;

    if (!row) return json({ error: "Artifact not found" }, 404);

    let content: Buffer;
    if (row.storage_mode === "inline" && row.data) {
      content = Buffer.from(row.data);
    } else if (row.storage_mode === "disk" && row.disk_path) {
      try {
        content = readArtifactFromDisk(row.disk_path);
      } catch (e: any) {
        return json({ error: "Artifact file missing from disk", artifact_id: row.id }, 404);
      }
    } else {
      return json({ error: "Artifact has no data" }, 500);
    }

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": row.mime_type,
        "Content-Length": String(content.length),
        "Content-Disposition": `attachment; filename="${row.filename}"`,
      },
    });
  }
```

- [ ] **Step 3: Add the stats endpoint**

```typescript
  // GET /artifacts/stats -- storage usage stats
  if (url.pathname === "/artifacts/stats" && method === "GET") {
    const stats = getArtifactStats.get() as {
      total_count: number; total_bytes: number;
      inline_bytes: number; disk_bytes: number;
      inline_count: number; disk_count: number;
    };
    return json({
      total_count: stats.total_count || 0,
      total_bytes: stats.total_bytes || 0,
      inline: { count: stats.inline_count || 0, bytes: stats.inline_bytes || 0 },
      disk: { count: stats.disk_count || 0, bytes: stats.disk_bytes || 0 },
    });
  }
```

**Important:** Place the `/artifacts/stats` route BEFORE the `/artifacts/:memoryId` route so "stats" doesn't get parsed as a numeric ID.

- [ ] **Step 4: Run all artifact tests**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: All tests pass -- store, list, and download.

- [ ] **Step 5: Commit**

```bash
git add src/routes/index.ts
git commit -m "feat: add artifact retrieval and stats endpoints"
```

---

### Task 5: Surface Artifacts in Search/Recall/Context

**Files:**
- Modify: `src/routes/index.ts` (add artifact metadata to search results)

- [ ] **Step 1: Write the failing test**

Add to `tests/artifacts.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: FAIL -- search results don't include artifacts yet.

- [ ] **Step 3: Add artifact metadata to search response formatting**

In `src/routes/index.ts`, in the search result formatting section (the `explainResults` map), add artifact lookup:

```typescript
  // After building explainResults, enrich with artifact metadata
  for (const r of explainResults) {
    const arts = getArtifactsByMemory.all(r.id) as Array<{
      id: number; filename: string; mime_type: string; size_bytes: number;
      sha256: string; storage_mode: string; created_at: string;
    }>;
    r.artifacts = arts.length > 0 ? arts.map(({ id, filename, mime_type, size_bytes }) => ({
      id, filename, mime_type, size_bytes,
    })) : [];
  }
```

- [ ] **Step 4: Add artifact metadata to recall response formatting**

In the `/recall` handler, after building the memories array, add the same enrichment:

```typescript
  // Enrich recall results with artifact metadata
  for (const m of responseMemories) {
    const arts = getArtifactsByMemory.all(m.id) as Array<{
      id: number; filename: string; mime_type: string; size_bytes: number;
      sha256: string; storage_mode: string; created_at: string;
    }>;
    m.artifacts = arts.length > 0 ? arts.map(({ id, filename, mime_type, size_bytes }) => ({
      id, filename, mime_type, size_bytes,
    })) : [];
  }
```

- [ ] **Step 5: Run all tests**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/index.ts tests/artifacts.test.mjs
git commit -m "feat: surface artifact metadata in search and recall responses"
```

---

### Task 6: Disk Cleanup on Memory Deletion

**Files:**
- Modify: `src/routes/index.ts` or wherever memory deletion/forget is handled
- Modify: `src/artifacts/storage.ts` (if cleanup helper needed)

- [ ] **Step 1: Write the failing test**

Add to `tests/artifacts.test.mjs`:

```javascript
describe("Cleanup on delete", () => {
  let deleteMemoryId;
  let deleteArtifactId;

  it("stores a memory with an artifact for deletion test", async () => {
    const content = Buffer.from("temporary file").toString("base64");
    const { data } = await api("/store", {
      method: "POST",
      body: {
        content: "Temporary memory for delete test",
        category: "test",
        source: "test",
        artifacts: [{ filename: "temp.txt", mime_type: "text/plain", data_base64: content }],
      },
    });
    deleteMemoryId = data.id;
    deleteArtifactId = data.artifacts[0].id;
  });

  it("after forgetting memory, artifacts are gone", async () => {
    // Forget the memory
    const { status } = await api(`/memory/${deleteMemoryId}/forget`, { method: "POST" });
    assert.ok(status === 200 || status === 204, `Forget returned ${status}`);

    // Artifact should be gone
    const artRes = await fetch(`${BASE}/artifact/${deleteArtifactId}`);
    assert.equal(artRes.status, 404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: FAIL -- forget doesn't clean up artifacts (CASCADE handles DB rows, but disk files need manual cleanup).

- [ ] **Step 3: Add disk cleanup to the forget/delete handler**

Find the memory forget/delete handler in the routes. Before or after the memory is deleted/forgotten, add disk artifact cleanup:

```typescript
import { deleteArtifactFromDisk } from "../artifacts/storage.ts";
import { getArtifactsByMemory, getArtifactById, getArtifactDiskRefCount } from "../db/index.ts";

// Before the delete/forget operation:
function cleanupArtifactDiskFiles(memoryId: number): void {
  const artifacts = db.prepare(
    "SELECT id, storage_mode, disk_path FROM artifacts WHERE memory_id = ?"
  ).all(memoryId) as Array<{ id: number; storage_mode: string; disk_path: string | null }>;

  for (const art of artifacts) {
    if (art.storage_mode === "disk" && art.disk_path) {
      // Check refcount: will be 1 if this is the only reference (about to be deleted)
      const refCount = getArtifactDiskRefCount.get(art.disk_path) as { count: number };
      if (refCount.count <= 1) {
        deleteArtifactFromDisk(art.disk_path);
      }
    }
  }
}
```

Call `cleanupArtifactDiskFiles(memoryId)` BEFORE the delete/forget SQL executes (so CASCADE hasn't removed the artifact rows yet when we check refcount).

- [ ] **Step 4: Run all tests**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/index.ts src/artifacts/storage.ts tests/artifacts.test.mjs
git commit -m "feat: clean up disk artifacts on memory forget/delete"
```

---

### Task 7: Multiple Artifacts and Edge Cases

**Files:**
- Modify: `tests/artifacts.test.mjs` (edge case tests)

- [ ] **Step 1: Add edge case tests**

```javascript
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
```

- [ ] **Step 2: Run all tests**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/artifacts.test.mjs
git commit -m "test: add edge case coverage for artifact storage"
```

---

### Task 8: Context Endpoint Integration

**Files:**
- Modify: `src/routes/index.ts` (add artifact metadata to /context responses)

- [ ] **Step 1: Write the failing test**

Add to `tests/artifacts.test.mjs`:

```javascript
describe("Context integration", () => {
  it("POST /context returns artifact metadata on memories", async () => {
    const { status, data } = await api("/context", {
      method: "POST",
      body: { query: "nginx config", max_tokens: 4000 },
    });
    assert.equal(status, 200);
    // Context response format varies -- check that artifacts field exists on any memory that has them
    const memories = data.semantic_matches || data.memories || data.results || [];
    const match = memories.find((m) => m.id === memoryId);
    if (match) {
      assert.ok(Array.isArray(match.artifacts));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: FAIL -- /context doesn't include artifacts yet.

- [ ] **Step 3: Add artifact enrichment to /context handler**

Find the `/context` handler in `src/routes/index.ts`. Apply the same enrichment pattern used in search/recall:

```typescript
  // Enrich context results with artifact metadata
  for (const m of semanticMatches) {
    const arts = getArtifactsByMemory.all(m.id) as Array<{
      id: number; filename: string; mime_type: string; size_bytes: number;
    }>;
    m.artifacts = arts.length > 0 ? arts.map(({ id, filename, mime_type, size_bytes }) => ({
      id, filename, mime_type, size_bytes,
    })) : [];
  }
```

- [ ] **Step 4: Run all tests**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/index.ts tests/artifacts.test.mjs
git commit -m "feat: surface artifact metadata in /context responses"
```

---

### Task 9: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run the full existing test suite**

Run: `cd C:/Users/Zan/Projects/Engram && npm test`
Expected: All existing tests still pass. No regressions.

- [ ] **Step 2: Run the artifact test suite**

Run: `cd C:/Users/Zan/Projects/Engram && node --test tests/artifacts.test.mjs`
Expected: All artifact tests pass.

- [ ] **Step 3: Typecheck**

Run: `cd C:/Users/Zan/Projects/Engram && npm run typecheck`
Expected: No type errors.

- [ ] **Step 4: Manual smoke test**

Start the server and test manually:

```bash
# Store with artifact
curl -s http://localhost:4200/store -X POST \
  -H "Content-Type: application/json" \
  -d '{"content":"manual test","category":"test","source":"test","artifacts":[{"filename":"hello.txt","mime_type":"text/plain","data_base64":"aGVsbG8gd29ybGQ="}]}'

# List artifacts
curl -s http://localhost:4200/artifacts/MEMORY_ID

# Download artifact
curl -s http://localhost:4200/artifact/ARTIFACT_ID

# Check stats
curl -s http://localhost:4200/artifacts/stats
```

- [ ] **Step 5: Final commit with any fixups**

```bash
git add -A
git commit -m "chore: final cleanup for artifact storage feature"
```
