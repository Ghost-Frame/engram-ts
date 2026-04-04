# Artifact Search & Encryption at Rest - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add FTS5 full-text indexing of text-based artifact content (boosting parent memories in search), and AES-256-GCM encryption at rest for all artifact data with per-user key derivation.

**Architecture:** Two additive features layered onto the existing artifact storage system. FTS5 indexing hooks into `processArtifact` at store time, indexes plaintext content, and feeds a new RRF channel into `hybridSearch`. Encryption wraps the storage layer with AES-256-GCM using HKDF-derived per-user keys from a master key (env var or cred). Both features are opt-in and backwards compatible.

**Tech Stack:** Node.js `node:crypto` (AES-256-GCM, HKDF, randomBytes), LibSQL FTS5, existing Engram v6 module pattern.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/config/index.ts` | Modify | Add `ARTIFACT_FTS_MAX_SIZE` and `ARTIFACT_ENCRYPTION_KEY` config constants |
| `src/db/connection.ts` | Modify | Add `artifacts_fts` FTS5 table, `is_indexed` and `is_encrypted` columns on `artifacts` |
| `src/db/index.ts` | Modify | Add prepared statements for artifact FTS and encryption operations |
| `src/artifacts/fts.ts` | Create | Indexable MIME type detection, FTS insert/delete helpers |
| `src/artifacts/encryption.ts` | Create | Key loading, HKDF derivation, encrypt/decrypt functions |
| `src/artifacts/storage.ts` | Modify | Return plaintext reference for FTS, hook encryption into write path |
| `src/memory/search.ts` | Modify | Add artifact FTS as 5th RRF channel in hybridSearch |
| `src/memory/routes.ts` | Modify | Hook FTS indexing and encryption into store pipeline |
| `src/artifacts/routes.ts` | Modify | Add decryption to artifact download, add migration endpoint |
| `tests/artifacts-fts.test.ts` | Create | Unit tests for FTS indexing |
| `tests/artifacts-encryption.test.ts` | Create | Unit tests for encryption module |

---

### Task 1: Configuration Constants

**Files:**
- Modify: `src/config/index.ts:160` (after existing artifact config)
- Create: `tests/artifacts-fts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/artifacts-fts.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("artifact FTS config", () => {
  it("ARTIFACT_FTS_MAX_SIZE defaults to 102400", async () => {
    const { ARTIFACT_FTS_MAX_SIZE } = await import("../src/config/index.ts");
    assert.equal(ARTIFACT_FTS_MAX_SIZE, 102400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/artifacts-fts.test.ts`
Expected: FAIL - `ARTIFACT_FTS_MAX_SIZE` is not exported

- [ ] **Step 3: Add config constants to `src/config/index.ts`**

After line 160 (`export const ARTIFACT_DIR = resolve(DATA_DIR, "artifacts");`), add:

```typescript
export const ARTIFACT_FTS_MAX_SIZE = Number(process.env.ENGRAM_ARTIFACT_FTS_MAX_SIZE || 102400); // 100KB
export const ARTIFACT_ENCRYPTION_KEY = process.env.ENGRAM_ARTIFACT_ENCRYPTION_KEY || "";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/artifacts-fts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/index.ts tests/artifacts-fts.test.ts
git commit -m "feat: add artifact FTS and encryption config constants"
```

---

### Task 2: Schema Migration - FTS5 Table and New Columns

**Files:**
- Modify: `src/db/connection.ts:992` (after schema version 512)
- Modify: `tests/artifacts-fts.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/artifacts-fts.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/artifacts-fts.test.ts`
Expected: FAIL - columns and table don't exist yet

- [ ] **Step 3: Add migrations to `src/db/connection.ts`**

After line 992 (`setSchemaVersion(512, "artifact storage table");`), add:

```typescript
// v6.1: Artifact content search (FTS5) + encryption at rest
migrate("ALTER TABLE artifacts ADD COLUMN is_indexed INTEGER NOT NULL DEFAULT 0");
migrate("ALTER TABLE artifacts ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0");

migrate(`CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  content,
  tokenize='porter unicode61'
)`);

setSchemaVersion(513, "artifact FTS5 index and encryption columns");
```

The FTS table is manually managed (no `content=` sync). We insert/delete rows explicitly, using `artifacts.id` as the rowid.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/artifacts-fts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/connection.ts tests/artifacts-fts.test.ts
git commit -m "feat: add artifacts_fts table and is_indexed/is_encrypted columns"
```

---

### Task 3: Artifact FTS Module - MIME Detection and Indexing

**Files:**
- Create: `src/artifacts/fts.ts`
- Modify: `src/db/index.ts:1297` (add prepared statements)
- Modify: `tests/artifacts-fts.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/artifacts-fts.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/artifacts-fts.test.ts`
Expected: FAIL - `src/artifacts/fts.ts` doesn't exist

- [ ] **Step 3: Add prepared statements to `src/db/index.ts`**

After the existing artifact prepared statements (after line 1297, after `getArtifactStats`), add:

```typescript
// Artifact FTS (v6.1)
export const insertArtifactFTS = db.prepare(
  `INSERT INTO artifacts_fts(rowid, content) VALUES (?, ?)`
);

export const deleteArtifactFTS = db.prepare(
  `INSERT INTO artifacts_fts(artifacts_fts, rowid, content) VALUES ('delete', ?, ?)`
);

export const searchArtifactsFTS = db.prepare(
  `SELECT rowid, rank FROM artifacts_fts WHERE content MATCH ? ORDER BY rank LIMIT ?`
);

export const markArtifactIndexed = db.prepare(
  `UPDATE artifacts SET is_indexed = 1 WHERE id = ?`
);

export const markArtifactEncrypted = db.prepare(
  `UPDATE artifacts SET is_encrypted = 1 WHERE id = ?`
);

export const getArtifactMemoryId = db.prepare(
  `SELECT memory_id FROM artifacts WHERE id = ?`
);
```

- [ ] **Step 4: Create `src/artifacts/fts.ts`**

```typescript
import { ARTIFACT_FTS_MAX_SIZE } from "../config/index.ts";
import { insertArtifactFTS, markArtifactIndexed } from "../db/index.ts";
import { log } from "../config/logger.ts";

const INDEXABLE_APP_TYPES = new Set([
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/toml",
  "application/x-sh",
  "application/x-python",
]);

export function isIndexableMimeType(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  return INDEXABLE_APP_TYPES.has(mime);
}

export function indexArtifact(artifactId: number, mimeType: string, data: Buffer): boolean {
  if (!isIndexableMimeType(mimeType)) return false;

  try {
    const text = data.subarray(0, ARTIFACT_FTS_MAX_SIZE).toString("utf-8");
    if (!text.trim()) return false;

    insertArtifactFTS.run(artifactId, text);
    markArtifactIndexed.run(artifactId);
    return true;
  } catch (e: any) {
    log.warn({ msg: "artifact_fts_index_failed", artifact_id: artifactId, error: e.message });
    return false;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/artifacts-fts.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/artifacts/fts.ts src/db/index.ts tests/artifacts-fts.test.ts
git commit -m "feat: artifact FTS module with MIME detection and indexing"
```

---

### Task 4: Hook FTS Indexing into Store Pipeline

**Files:**
- Modify: `src/memory/routes.ts:34,157-174` (import + artifact storage loop)

- [ ] **Step 1: Add the import**

In `src/memory/routes.ts`, after line 34 (`import { processArtifact } from "../artifacts/storage.ts";`), add:

```typescript
import { indexArtifact } from "../artifacts/fts.ts";
```

- [ ] **Step 2: Add FTS indexing after artifact insert**

In the artifact storage loop (around line 174, after the `artifactResults.push(...)` block), add:

```typescript
          // FTS index text-based artifacts on plaintext
          if (stored.data) {
            indexArtifact(artResult.id, stored.mime_type, stored.data);
          }
```

Note: At this point (before Task 8 encryption), `stored.data` is plaintext. Task 8 will update this to use `stored.plaintextData` after encryption is wired in.

- [ ] **Step 3: Run tests**

Run: `node --experimental-strip-types --test tests/artifacts-fts.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/memory/routes.ts
git commit -m "feat: hook FTS indexing into artifact store pipeline"
```

---

### Task 5: Artifact FTS as Search Channel in hybridSearch

**Files:**
- Modify: `src/memory/search.ts` (hybridSearch function, lines 535-954)

This adds artifact FTS as a 5th RRF channel alongside vector, fts, personality, and graph.

- [ ] **Step 1: Add imports at top of `src/memory/search.ts`**

Add these imports near the existing db imports:

```typescript
import { searchArtifactsFTS, getArtifactMemoryId } from "../db/index.ts";
```

- [ ] **Step 2: Add artifact FTS ranked list declaration**

At line 561 (after `const graphRanked: Array<{ id: number; rawScore: number }> = [];`), add:

```typescript
  const artifactFtsRanked: Array<{ id: number; rawScore: number }> = [];
```

- [ ] **Step 3: Add artifact FTS search phase after memory FTS**

After the memory FTS5 block (after line 670, the `catch {}` closing the FTS try block, before the `// 3. Personality signal supplementation` comment at line 675), add:

```typescript
  // 2b. Artifact FTS5 content search
  if (sanitized) {
    try {
      const artifactHits = searchArtifactsFTS.all(sanitized, Math.min(candidateTarget, 50)) as Array<{
        rowid: number;
        rank: number;
      }>;

      for (const ah of artifactHits) {
        const memRow = getArtifactMemoryId.get(ah.rowid) as { memory_id: number } | undefined;
        if (!memRow) continue;
        const memId = memRow.memory_id;

        artifactFtsRanked.push({ id: memId, rawScore: Math.abs(ah.rank) });

        if (!results.has(memId)) {
          const mem = getMemoryWithoutEmbedding.get(memId) as any;
          if (mem && !mem.is_forgotten) {
            if (latestOnly && !mem.is_latest) continue;
            if (sourceFilter && (!mem.source || !mem.source.includes(sourceFilter))) continue;
            results.set(memId, {
              id: memId,
              content: mem.content,
              category: mem.category,
              source: mem.source,
              model: mem.model || undefined,
              importance: mem.importance,
              created_at: mem.created_at,
              score: 0,
              version: mem.version,
              is_latest: !!mem.is_latest,
              is_static: !!mem.is_static,
              source_count: mem.source_count || 1,
              root_memory_id: mem.root_memory_id,
            });
          }
        }
      }
    } catch {}
  }
```

- [ ] **Step 4: Add artifact FTS to RRF fusion**

After the line `const graphScoreMap = new Map<number, number>();` (line 715), add:

```typescript
  const artifactFtsSet = new Set(artifactFtsRanked.map(r => r.id));
  const artifactFtsScoreMap = new Map<number, number>(artifactFtsRanked.map(r => [r.id, r.rawScore]));
```

After the personality RRF loop (after the block ending at line 728), add:

```typescript
  for (let rank = 0; rank < artifactFtsRanked.length; rank++) {
    const id = artifactFtsRanked[rank].id;
    rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (RRF_K + rank + 1));
  }
```

- [ ] **Step 5: Add artifact FTS to channel annotations**

In the channel annotation section (around line 952, after the graph channel annotation), add:

```typescript
    if (artifactFtsSet.has(r.id)) { channels.push("artifact_fts"); (r as any).artifact_fts_score = Math.round((artifactFtsScoreMap.get(r.id) || 0) * 1000) / 1000; }
```

- [ ] **Step 6: Run tests**

Run: `node --experimental-strip-types --test tests/artifacts-fts.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/memory/search.ts
git commit -m "feat: artifact FTS as 5th RRF channel in hybrid search"
```

---

### Task 6: Encryption Module - Key Loading, HKDF, AES-256-GCM

**Files:**
- Create: `src/artifacts/encryption.ts`
- Create: `tests/artifacts-encryption.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/artifacts-encryption.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("parseEncryptionKey", () => {
  it("accepts 64-char hex", async () => {
    const { parseEncryptionKey } = await import("../src/artifacts/encryption.ts");
    const key = parseEncryptionKey("a".repeat(64));
    assert.ok(key instanceof Buffer);
    assert.equal(key.length, 32);
  });

  it("accepts 44-char base64", async () => {
    const { parseEncryptionKey } = await import("../src/artifacts/encryption.ts");
    const b64 = Buffer.alloc(32, 0xab).toString("base64");
    const key = parseEncryptionKey(b64);
    assert.ok(key instanceof Buffer);
    assert.equal(key.length, 32);
  });

  it("rejects invalid input", async () => {
    const { parseEncryptionKey } = await import("../src/artifacts/encryption.ts");
    assert.throws(() => parseEncryptionKey("too-short"), /Invalid encryption key format/);
    assert.throws(() => parseEncryptionKey("x".repeat(64)), /Invalid encryption key format/);
  });
});

describe("deriveUserKey", () => {
  it("produces 32-byte key", async () => {
    const { deriveUserKey } = await import("../src/artifacts/encryption.ts");
    const master = Buffer.alloc(32, 0xaa);
    const key = deriveUserKey(master, 42);
    assert.equal(key.length, 32);
  });

  it("produces different keys for different users", async () => {
    const { deriveUserKey } = await import("../src/artifacts/encryption.ts");
    const master = Buffer.alloc(32, 0xaa);
    const key1 = deriveUserKey(master, 1);
    const key2 = deriveUserKey(master, 2);
    assert.notDeepEqual(key1, key2);
  });
});

describe("encrypt/decrypt round-trip", () => {
  it("encrypts and decrypts correctly", async () => {
    const { encryptArtifact, decryptArtifact } = await import("../src/artifacts/encryption.ts");
    const master = Buffer.alloc(32, 0xbb);
    const plaintext = Buffer.from("Hello, encrypted world!");
    const userId = 7;

    const encrypted = encryptArtifact(plaintext, master, userId);
    assert.ok(encrypted.length > plaintext.length);
    assert.notDeepEqual(encrypted, plaintext);

    const decrypted = decryptArtifact(encrypted, master, userId);
    assert.deepEqual(decrypted, plaintext);
  });

  it("encrypted format is [12 IV][16 tag][ciphertext]", async () => {
    const { encryptArtifact } = await import("../src/artifacts/encryption.ts");
    const master = Buffer.alloc(32, 0xcc);
    const plaintext = Buffer.from("test data");

    const encrypted = encryptArtifact(plaintext, master, 1);
    assert.equal(encrypted.length, 12 + 16 + plaintext.length);
  });

  it("decrypt with wrong user fails", async () => {
    const { encryptArtifact, decryptArtifact } = await import("../src/artifacts/encryption.ts");
    const master = Buffer.alloc(32, 0xdd);
    const plaintext = Buffer.from("secret data");

    const encrypted = encryptArtifact(plaintext, master, 1);
    assert.throws(() => decryptArtifact(encrypted, master, 2));
  });

  it("decrypt with wrong key fails", async () => {
    const { encryptArtifact, decryptArtifact } = await import("../src/artifacts/encryption.ts");
    const master1 = Buffer.alloc(32, 0xee);
    const master2 = Buffer.alloc(32, 0xff);
    const plaintext = Buffer.from("secret data");

    const encrypted = encryptArtifact(plaintext, master1, 1);
    assert.throws(() => decryptArtifact(encrypted, master2, 1));
  });
});

describe("initEncryption", () => {
  it("empty string disables encryption", async () => {
    const { initEncryption, isEncryptionEnabled } = await import("../src/artifacts/encryption.ts");
    initEncryption("");
    assert.equal(isEncryptionEnabled(), false);
  });

  it("valid hex enables encryption", async () => {
    const { initEncryption, isEncryptionEnabled } = await import("../src/artifacts/encryption.ts");
    initEncryption("a".repeat(64));
    assert.equal(isEncryptionEnabled(), true);
  });

  it("invalid key throws", async () => {
    const { initEncryption } = await import("../src/artifacts/encryption.ts");
    assert.throws(() => initEncryption("bad-key"), /Invalid encryption key format/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/artifacts-encryption.test.ts`
Expected: FAIL - module doesn't exist

- [ ] **Step 3: Create `src/artifacts/encryption.ts`**

```typescript
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { log } from "../config/logger.ts";

const HKDF_SALT = Buffer.from("engram-artifact");
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function parseEncryptionKey(raw: string): Buffer {
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  if (raw.length === 44) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
  }
  throw new Error("Invalid encryption key format: must be 64-char hex or 44-char base64");
}

export function deriveUserKey(masterKey: Buffer, userId: number): Buffer {
  const info = String(userId);
  return Buffer.from(hkdfSync("sha256", masterKey, HKDF_SALT, info, 32));
}

export function encryptArtifact(plaintext: Buffer, masterKey: Buffer, userId: number): Buffer {
  const userKey = deriveUserKey(masterKey, userId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", userKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptArtifact(encrypted: Buffer, masterKey: Buffer, userId: number): Buffer {
  if (encrypted.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Encrypted data too short");
  }
  const userKey = deriveUserKey(masterKey, userId);
  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", userKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

let _masterKey: Buffer | null = null;

export function initEncryption(keyString: string): void {
  if (!keyString) {
    _masterKey = null;
    log.info({ msg: "artifact_encryption", status: "disabled", reason: "no key configured" });
    return;
  }
  _masterKey = parseEncryptionKey(keyString);
  log.info({ msg: "artifact_encryption", status: "enabled" });
}

export function getMasterKey(): Buffer | null {
  return _masterKey;
}

export function isEncryptionEnabled(): boolean {
  return _masterKey !== null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/artifacts-encryption.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/artifacts/encryption.ts tests/artifacts-encryption.test.ts
git commit -m "feat: artifact encryption module with AES-256-GCM and HKDF key derivation"
```

---

### Task 7: Initialize Encryption at Server Startup

**Files:**
- Modify: `server.ts:9,37-38` (config import + initialization section)

- [ ] **Step 1: Add ARTIFACT_ENCRYPTION_KEY to config import**

At line 9 of `server.ts`, add `ARTIFACT_ENCRYPTION_KEY` to the existing config import:

```typescript
import { PORT, HOST, PKG_VERSION, CORS_ORIGIN, OPEN_ACCESS, ARTIFACT_ENCRYPTION_KEY } from "./src/config/index.ts";
```

- [ ] **Step 2: Add encryption initialization**

After line 38 (`await initReranker();`), add:

```typescript
// Artifact encryption (try cred first, fall back to env var)
import { initEncryption } from "./src/artifacts/encryption.ts";
{
  let encKey = "";
  try {
    const { execSync } = await import("node:child_process");
    encKey = execSync("cred get engram artifact-encryption-key --raw", { timeout: 3000 }).toString().trim();
  } catch {}
  if (!encKey) encKey = ARTIFACT_ENCRYPTION_KEY;
  try {
    initEncryption(encKey);
  } catch (e: any) {
    log.error({ msg: "artifact_encryption_key_invalid", error: e.message });
    process.exit(1);
  }
}
```

- [ ] **Step 3: Verify server still starts**

Run: `node --experimental-strip-types server.ts`
Expected: Log shows `artifact_encryption: disabled` (no key configured in dev). Stop with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat: initialize artifact encryption at server startup"
```

---

### Task 8: Hook Encryption into Storage and Retrieval

**Files:**
- Modify: `src/artifacts/storage.ts` (processArtifact + StoredArtifact)
- Modify: `src/memory/routes.ts:157-174` (pass userId, mark encrypted, use plaintextData for FTS)
- Modify: `src/artifacts/routes.ts:51-83` (decrypt on download)
- Modify: `src/db/index.ts:1279-1281` (add is_encrypted to SELECT)

- [ ] **Step 1: Modify `StoredArtifact` interface in `src/artifacts/storage.ts`**

Add two fields to the `StoredArtifact` interface (after `disk_path: string | null;`):

```typescript
  encrypted: boolean;
  plaintextData: Buffer | null;
```

- [ ] **Step 2: Add encryption import and modify processArtifact**

Add import at top of `src/artifacts/storage.ts`:

```typescript
import { getMasterKey, encryptArtifact } from "./encryption.ts";
```

Change the function signature to accept userId:

```typescript
export function processArtifact(input: ArtifactInput, userId?: number): StoredArtifact {
```

After line 25 (`const sha256 = createHash("sha256").update(data).digest("hex");`) and before the size check, add:

```typescript
  let storedData = data;
  let encrypted = false;
  const masterKey = getMasterKey();
  if (masterKey && userId != null) {
    storedData = encryptArtifact(data, masterKey, userId);
    encrypted = true;
  }
```

Modify the inline return (lines 30-38) to use `storedData` and add new fields:

```typescript
  if (size <= ARTIFACT_SIZE_THRESHOLD) {
    return {
      filename: input.filename,
      mime_type: mime,
      size_bytes: size,
      sha256,
      storage_mode: "inline",
      data: storedData,
      disk_path: null,
      encrypted,
      plaintextData: data,
    };
  }
```

Modify the disk storage section (lines 42-59) to use user-scoped paths when encrypted:

```typescript
  const prefix = sha256.slice(0, 2);
  const baseDir = encrypted && userId != null
    ? resolve(ARTIFACT_DIR, String(userId), prefix)
    : resolve(ARTIFACT_DIR, prefix);
  const filePath = join(baseDir, sha256);

  if (!existsSync(filePath)) {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(filePath, storedData);
  }

  return {
    filename: input.filename,
    mime_type: mime,
    size_bytes: size,
    sha256,
    storage_mode: "disk",
    data: null,
    disk_path: filePath,
    encrypted,
    plaintextData: data,
  };
```

- [ ] **Step 3: Update store pipeline in `src/memory/routes.ts`**

Add `markArtifactEncrypted` to imports from `../db/index.ts`.

At line 157, pass `auth.user_id` to `processArtifact`:

```typescript
          const stored = processArtifact(rawArtifact as ArtifactInput, auth.user_id);
```

After `artifactResults.push(...)`, add encryption marking:

```typescript
          if (stored.encrypted) {
            markArtifactEncrypted.run(artResult.id);
          }
```

Update the FTS indexing call (added in Task 4) to use `plaintextData`:

```typescript
          // FTS index text-based artifacts on plaintext (before encryption)
          if (stored.plaintextData) {
            indexArtifact(artResult.id, stored.mime_type, stored.plaintextData);
          }
```

- [ ] **Step 4: Update getArtifactById SELECT in `src/db/index.ts`**

At line 1280, add `is_encrypted` to the SELECT:

```typescript
export const getArtifactById = db.prepare(
  `SELECT id, memory_id, filename, mime_type, size_bytes, sha256, storage_mode, data, disk_path, is_encrypted, created_at
   FROM artifacts WHERE id = ?`
);
```

- [ ] **Step 5: Add decryption to artifact download in `src/artifacts/routes.ts`**

In the `GET /artifact/:id` handler (line 51), change `_req` to `req`:

```typescript
  router.get("/artifact/:id", async (req, params) => {
```

After reading the content buffer (after the else block around line 73), before `return new Response(...)`, add:

```typescript
    if ((row as any).is_encrypted) {
      const { getMasterKey, decryptArtifact } = await import("./encryption.ts");
      const masterKey = getMasterKey();
      if (!masterKey) {
        return json({ error: "artifact_decryption_failed", detail: "No encryption key configured" }, 500);
      }
      const { auth } = getContext(req);
      try {
        content = decryptArtifact(content, masterKey, auth.user_id);
      } catch {
        return json({ error: "artifact_decryption_failed" }, 500);
      }
    }
```

- [ ] **Step 6: Run all tests**

Run: `node --experimental-strip-types --test tests/artifacts-fts.test.ts && node --experimental-strip-types --test tests/artifacts-encryption.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/artifacts/storage.ts src/artifacts/routes.ts src/memory/routes.ts src/db/index.ts
git commit -m "feat: hook encryption into artifact storage and retrieval"
```

---

### Task 9: Encryption Migration Endpoint

**Files:**
- Modify: `src/artifacts/routes.ts`

- [ ] **Step 1: Add imports for migration endpoint**

At top of `src/artifacts/routes.ts`, ensure these are imported:

```typescript
import { getContext, hasScope } from "../middleware/auth.ts";
import { readArtifactFromDisk } from "./storage.ts";
import { db } from "../db/connection.ts";
import { ARTIFACT_DIR } from "../config/index.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
```

Note: `getContext` and `readArtifactFromDisk` are already imported. Add only the missing ones.

- [ ] **Step 2: Add migration endpoint**

Inside `registerArtifactRoutes`, after the existing routes and before the closing `}`, add:

```typescript
  // POST /artifacts/migrate-encryption - encrypt existing unencrypted artifacts (admin only)
  router.post("/artifacts/migrate-encryption", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "admin")) return json({ error: "Admin scope required" }, 403);

    const { getMasterKey, encryptArtifact } = await import("./encryption.ts");
    const masterKey = getMasterKey();
    if (!masterKey) return json({ error: "No encryption key configured" }, 400);

    const BATCH_SIZE = 50;
    const unencrypted = db.prepare(
      `SELECT a.id, a.memory_id, a.data, a.disk_path, a.storage_mode, a.sha256, m.user_id
       FROM artifacts a JOIN memories m ON a.memory_id = m.id
       WHERE a.is_encrypted = 0 LIMIT ?`
    ).all(BATCH_SIZE) as Array<{
      id: number; memory_id: number; data: Buffer | null; disk_path: string | null;
      storage_mode: string; sha256: string; user_id: number;
    }>;

    let migrated = 0;
    let errors = 0;

    for (const art of unencrypted) {
      try {
        let plaintext: Buffer;
        if (art.storage_mode === "inline" && art.data) {
          plaintext = Buffer.from(art.data);
        } else if (art.storage_mode === "disk" && art.disk_path) {
          plaintext = readArtifactFromDisk(art.disk_path);
        } else {
          continue;
        }

        const encrypted = encryptArtifact(plaintext, masterKey, art.user_id);

        if (art.storage_mode === "inline") {
          db.prepare("UPDATE artifacts SET data = ?, is_encrypted = 1 WHERE id = ?").run(encrypted, art.id);
        } else if (art.disk_path) {
          const prefix = art.sha256.slice(0, 2);
          const newDir = resolve(ARTIFACT_DIR, String(art.user_id), prefix);
          const newPath = join(newDir, art.sha256);
          mkdirSync(newDir, { recursive: true });
          writeFileSync(newPath, encrypted);
          db.prepare("UPDATE artifacts SET disk_path = ?, is_encrypted = 1 WHERE id = ?").run(newPath, art.id);
        }

        migrated++;
      } catch {
        errors++;
      }
    }

    const remaining = (db.prepare("SELECT COUNT(*) as c FROM artifacts WHERE is_encrypted = 0").get() as { c: number }).c;
    return json({ migrated, remaining, errors });
  });
```

- [ ] **Step 3: Run tests**

Run: `node --experimental-strip-types --test tests/artifacts-encryption.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/artifacts/routes.ts
git commit -m "feat: add POST /artifacts/migrate-encryption endpoint"
```

---

### Task 10: Integration Tests - FTS + Encryption Combined

**Files:**
- Modify: `tests/artifacts-encryption.test.ts`

- [ ] **Step 1: Add combined integration test**

Append to `tests/artifacts-encryption.test.ts`:

```typescript
describe("encryption + FTS interaction", () => {
  it("indexes plaintext but stores encrypted data", async () => {
    const { db } = await import("../src/db/connection.ts");
    const { encryptArtifact, parseEncryptionKey } = await import("../src/artifacts/encryption.ts");
    const { indexArtifact } = await import("../src/artifacts/fts.ts");

    const masterKey = parseEncryptionKey("a".repeat(64));
    const userId = 1;
    const plaintext = Buffer.from('server { listen 80; upstream backend { server 127.0.0.1:3000; } }');
    const encrypted = encryptArtifact(plaintext, masterKey, userId);

    const memResult = db.prepare(
      "INSERT INTO memories (content, category, importance, user_id, embedding) VALUES (?, ?, ?, ?, zeroblob(4)) RETURNING id"
    ).get("nginx config for encryption test", "config", 5, userId) as { id: number };

    const artResult = db.prepare(
      "INSERT INTO artifacts (memory_id, filename, mime_type, size_bytes, sha256, storage_mode, data, is_encrypted) VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING id"
    ).get(memResult.id, "nginx.conf", "text/plain", plaintext.length, "enctest456", "inline", encrypted) as { id: number };

    // Index the PLAINTEXT
    const indexed = indexArtifact(artResult.id, "text/plain", plaintext);
    assert.ok(indexed, "should index plaintext content");

    // FTS finds the content via plaintext
    const ftsHits = db.prepare("SELECT rowid FROM artifacts_fts WHERE content MATCH 'upstream'").all();
    assert.ok(ftsHits.length > 0, "FTS should find 'upstream' in plaintext");

    // But stored data is encrypted
    const storedRow = db.prepare("SELECT data FROM artifacts WHERE id = ?").get(artResult.id) as { data: Buffer };
    assert.notDeepEqual(Buffer.from(storedRow.data), plaintext, "stored data should be encrypted");
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `node --experimental-strip-types --test tests/artifacts-fts.test.ts && node --experimental-strip-types --test tests/artifacts-encryption.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/artifacts-encryption.test.ts
git commit -m "test: integration tests for FTS + encryption interaction"
```

---

### Task 11: Deploy to Production

**Files:** None (deployment task)

- [ ] **Step 1: Run full test suite locally**

```bash
node --experimental-strip-types --test tests/artifacts-fts.test.ts
node --experimental-strip-types --test tests/artifacts-encryption.test.ts
```

Expected: All PASS

- [ ] **Step 2: Start server and verify**

Run: `node --experimental-strip-types server.ts`
Expected: Log shows `artifact_encryption: disabled` and no errors. Stop with Ctrl+C.

- [ ] **Step 3: Bundle and deploy**

```bash
git bundle create /tmp/engram-artifact-search-enc.bundle HEAD
scp /tmp/engram-artifact-search-enc.bundle hetzner-zan:/home/zan/engram/
ssh hetzner-zan "cd /home/zan/engram && git fetch engram-artifact-search-enc.bundle HEAD:incoming && git merge incoming && systemctl --user restart engram"
```

- [ ] **Step 4: Verify deployment**

```bash
ssh hetzner-zan "curl -s http://localhost:4200/health | head -c 200"
ssh hetzner-zan "journalctl --user -u engram --no-pager -n 20"
```

Check for `artifact_encryption: disabled` in logs and no errors.

- [ ] **Step 5: Store to Engram**

```bash
engram-cli store "Artifact FTS search and encryption at rest deployed. FTS5 indexes text artifacts as 5th RRF channel in hybrid search. AES-256-GCM encryption with HKDF per-user keys, opt-in via ENGRAM_ARTIFACT_ENCRYPTION_KEY or cred. Schema v513." --source claude-code --category task
```
