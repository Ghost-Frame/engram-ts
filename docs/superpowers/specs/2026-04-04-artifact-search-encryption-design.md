# Engram Artifact Search & Encryption at Rest

**Date:** 2026-04-04
**Status:** Design approved, pending implementation

## Overview

Two features extending the existing artifact storage system:
1. **Artifact content search** - FTS5 indexing of text-based artifact content, integrated into existing search/recall results
2. **Encryption at rest** - AES-256-GCM encryption with per-user key derivation, opt-in via env var or cred

Both features are additive. Existing artifacts continue to work unchanged.

---

## Feature 1: Artifact Content Search

### Problem

Agents store artifacts (configs, code, reports) but can only find them via the parent memory's text. Searching for "nginx upstream block" won't find a memory whose text says "Generated nginx config" even though the attached artifact contains the exact directive. Artifact content should be searchable.

### Approach

Text-only FTS5 indexing. Text-based artifacts (plaintext, JSON, YAML, code) get indexed. Binary artifacts (images, archives) are not indexed. Matches boost the parent memory in normal search/recall results. No new endpoints.

### Data Model

New FTS5 virtual table:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  content,
  content_rowid='artifact_id'
);
```

New column on `artifacts` table:

```sql
ALTER TABLE artifacts ADD COLUMN is_indexed INTEGER NOT NULL DEFAULT 0;
```

### Indexable MIME Types

Any `mime_type` starting with `text/`, plus:
- `application/json`
- `application/yaml`
- `application/x-yaml`
- `application/xml`
- `application/javascript`
- `application/typescript`
- `application/toml`
- `application/x-sh`
- `application/x-python`

Binary types are silently skipped. No error, `is_indexed` stays 0.

### Index Timing

On store, synchronously. When `processArtifact` runs and the mime type is indexable:
1. Decode the base64 content
2. Truncate to `ENGRAM_ARTIFACT_FTS_MAX_SIZE` bytes (default 100KB) for indexing
3. Insert into `artifacts_fts`
4. Set `is_indexed = 1` on the artifact row

If FTS5 insertion fails (malformed content, encoding issues), log a warning, set `is_indexed = 0`, and continue. The artifact is still stored normally.

### Search Integration

In `hybridSearch` (src/memory/search.ts), after the normal FTS5 + vector search pipeline:

1. Run a secondary query: `SELECT artifact_id, rank FROM artifacts_fts WHERE content MATCH ?`
2. For each match, look up the parent `memory_id` via the artifacts table
3. If the parent memory is already in results, boost its score by a configurable factor (0.15 additive)
4. If the parent memory is NOT in results, fetch it and add it with the artifact FTS rank as its base score
5. Re-sort results by final score

This keeps artifact search transparent. Agents don't learn a new API or change behavior. Memories with matching artifacts just rank higher.

### Size Guard

Only the first 100KB of text content is indexed. Configurable via `ENGRAM_ARTIFACT_FTS_MAX_SIZE`. Larger files are truncated for indexing; the full file is still stored and downloadable.

---

## Feature 2: Encryption at Rest

### Problem

Artifact data (inline BLOBs and disk files) is stored as plaintext. Anyone with disk access or DB access can read artifact contents directly. Multi-tenant deployments need cryptographic isolation between users.

### Approach

AES-256-GCM encryption with per-user key derivation from a master key. Opt-in: no key configured means no encryption, artifacts work exactly as today.

### Key Hierarchy

1. **Master key** - loaded at startup from one of two sources (priority order):
   - `cred get engram artifact-encryption-key --raw` (try first, silently skip if cred unavailable)
   - `ENGRAM_ARTIFACT_ENCRYPTION_KEY` env var (hex string, 64 chars, or base64, 44 chars)
2. **Per-user key** - derived via HKDF-SHA256:
   - `HKDF-SHA256(ikm=master_key, salt="engram-artifact", info=user_id_as_string)` producing 32 bytes
3. **Per-artifact IV** - 12 random bytes generated for each encryption operation

### Storage Format

```
[12-byte IV][16-byte GCM auth tag][ciphertext]
```

Both inline BLOBs (`data` column) and disk files use this identical format. The encrypted payload replaces the plaintext payload in the same storage location.

### Data Model

New column on `artifacts` table:

```sql
ALTER TABLE artifacts ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0;
```

The read path checks `is_encrypted` to decide whether to decrypt. Existing unencrypted artifacts remain readable.

### Behavior Matrix

| Master key set? | Artifact `is_encrypted`? | Write behavior | Read behavior |
|-----------------|--------------------------|----------------|---------------|
| No | N/A | Store plaintext | Read plaintext |
| Yes | 0 (old artifact) | N/A | Read plaintext |
| Yes | 1 (new artifact) | Encrypt then store | Decrypt then serve |

### Encryption Flow (write)

1. `processArtifact` produces plaintext data and SHA-256 hash (unchanged)
2. If master key is configured, call `encryptArtifact(data, userId)`:
   - Derive per-user key via HKDF
   - Generate 12-byte random IV
   - AES-256-GCM encrypt
   - Return `Buffer.concat([iv, authTag, ciphertext])`
3. Store encrypted buffer in `data` column (inline) or disk file
4. Set `is_encrypted = 1`

### Decryption Flow (read)

1. Check `is_encrypted` flag
2. If 0, return data as-is (backwards compatible)
3. If 1, call `decryptArtifact(encryptedData, userId)`:
   - Extract IV (first 12 bytes), auth tag (next 16 bytes), ciphertext (remainder)
   - Derive per-user key via HKDF
   - AES-256-GCM decrypt
   - Return plaintext buffer
4. On decryption failure (wrong key, corrupted), return 500 with `artifact_decryption_failed`

### Dedup with Encryption

SHA-256 hash is computed on plaintext (before encryption), same as today. Dedup rules:

- **Same user, same hash:** Reuse existing disk path. No new file written.
- **Different user, same hash:** Write a new encrypted file (different user key = different ciphertext). Cross-user dedup is not possible with per-user encryption.

When encryption is enabled, disk storage paths include the user_id prefix to separate per-user encrypted copies:

```
$ENGRAM_DATA_DIR/artifacts/<user_id>/<sha256_prefix>/<sha256>
```

### FTS Indexing + Encryption Interaction

FTS5 indexing happens on plaintext BEFORE encryption. The FTS index stores plaintext snippets in the same LibSQL database. This is the correct tradeoff: if an attacker has DB access, they already have the FTS content. Encryption primarily protects:
- Disk-stored artifact files (large files)
- Raw BLOB column data from database dumps
- Cross-user isolation in multi-tenant deployments

### Migration Endpoint

`POST /artifacts/migrate-encryption` (admin only):
- Encrypts all existing unencrypted artifacts
- Processes in batches of 50
- Returns `{ migrated: N, remaining: N, errors: N }`
- Idempotent (skips already-encrypted artifacts)
- Moves disk files from old path (`<prefix>/<sha256>`) to user-scoped path (`<user_id>/<prefix>/<sha256>`)
- Requires master key to be configured

---

## Configuration

| Setting | Default | Purpose |
|---------|---------|---------|
| `ENGRAM_ARTIFACT_ENCRYPTION_KEY` | none | Master encryption key (64-char hex or 44-char base64). Also loadable from cred. |
| `ENGRAM_ARTIFACT_FTS_MAX_SIZE` | 102400 | Max bytes of artifact content to index in FTS5 |

## Error Handling

| Condition | Behavior |
|-----------|----------|
| Invalid encryption key format at startup | Log error, exit. Do not silently run unencrypted. |
| Decryption failure on read | Return 500 with `artifact_decryption_failed`. Never return garbled data. |
| FTS5 indexing fails on a file | Log warning, `is_indexed = 0`, artifact stored normally |
| Key not set | No encryption. Artifacts stored/read as plaintext. |

## Follow-up Tasks (out of scope)

- Repo sweep for private information in tracked files
- Pre-push hooks or filters to prevent private info leaking into mirror repos
- Key rotation tooling (decrypt with old key, re-encrypt with new key)
