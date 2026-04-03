# Engram Artifact Storage

**Date:** 2026-04-03
**Status:** Design approved, pending implementation

## Problem

Agents generate artifacts (configs, code, reports, etc.) that live on the filesystem disconnected from the memories that created them. Finding them later requires grepping and exploring. If artifacts lived in Engram, agents could search for them semantically like any other memory.

## Requirements

- Unified store -- artifacts searchable alongside memories, no filesystem grepping
- Hybrid storage -- small files inline (BLOB), large files on disk (path reference)
- Always attached to a memory -- no orphan artifacts
- One-to-many -- a memory can have multiple artifacts

## Data Model

New `artifacts` table in LibSQL:

```sql
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_mode TEXT NOT NULL DEFAULT 'inline',  -- 'inline' or 'disk'
  data BLOB,                                     -- populated when storage_mode = 'inline'
  disk_path TEXT,                                 -- populated when storage_mode = 'disk'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_artifacts_memory ON artifacts(memory_id);
CREATE INDEX idx_artifacts_hash ON artifacts(sha256);
```

**Size threshold:** 1MB. Under = inline BLOB. Over = written to disk.

**Dedup by hash:** If an artifact with the same sha256 already exists on disk, reference the same path. No duplicate disk storage. Inline BLOBs do not dedup (not worth the complexity for small files).

**CASCADE delete:** When a memory is deleted/forgotten, its artifacts go with it. On CASCADE, check refcount on disk_path -- only delete the file when no other artifact rows reference it.

## Disk Storage Layout

Large artifacts stored at:

```
$ENGRAM_DATA_DIR/
  artifacts/
    ab/                          # first 2 chars of sha256
      ab3f8c...full_sha256       # raw file, no extension
```

Content-addressable. Same file never stored twice. Nested by prefix to avoid one directory with millions of files.

`ENGRAM_DATA_DIR` defaults to `./data` (next to the DB file). Configurable via env var.

## API

### Store (extended)

`POST /store` gains two new input modes for artifacts:

**Option 1 -- multipart/form-data:**
- `metadata` part (application/json): the normal JSON payload (content, category, source, etc.)
- `files` parts (one or more, field name `files`): the artifacts to attach

**Option 2 -- JSON with base64:**
```json
{
  "content": "Generated nginx config for bav-apps",
  "category": "task",
  "source": "claude-code",
  "artifacts": [
    {
      "filename": "nginx.conf",
      "mime_type": "text/plain",
      "data_base64": "c2VydmVyIHsKICAuLi4KfQ=="
    }
  ]
}
```

Both paths store the memory and all artifacts in a single write-lock transaction. Atomic -- everything lands or nothing does.

**Response** gains an `artifacts` array:
```json
{
  "stored": true,
  "id": 12345,
  "artifacts": [
    {"id": 1, "filename": "nginx.conf", "size_bytes": 2048, "storage_mode": "inline"}
  ]
}
```

### Retrieve

- `GET /artifacts/:memory_id` -- list all artifacts for a memory (metadata only, no blob)
- `GET /artifact/:id` -- download a single artifact (streams BLOB or file from disk)

### Search Integration

`/search`, `/recall`, and `/context` responses gain an `artifacts` field on each memory result:

```json
{
  "id": 12345,
  "content": "Generated nginx config for bav-apps",
  "score": 0.87,
  "artifacts": [
    {"id": 1, "filename": "nginx.conf", "mime_type": "text/plain", "size_bytes": 2048}
  ]
}
```

- Metadata only in search results. Agents fetch content via `GET /artifact/:id`.
- LEFT JOIN -- memories without artifacts return `artifacts: []`.
- Artifacts do not affect search ranking. The memory's text content is the signal, the artifact is cargo.

### Delete

Handled by existing memory deletion. CASCADE handles cleanup. No separate delete endpoint.

## Error Handling & Limits

| Config | Default | Purpose |
|--------|---------|---------|
| `ENGRAM_MAX_ARTIFACT_SIZE` | 50MB | Max single artifact size |
| `ENGRAM_MAX_ARTIFACTS_PER_MEMORY` | 10 | Max artifacts per memory |

- Upload failure mid-transaction: entire `/store` rolls back, no memory created, no partial artifacts
- Disk write failure: return 507 (Insufficient Storage), roll back
- Missing disk file (corruption/manual deletion): `GET /artifact/:id` returns 404 with clear error

### Monitoring

`GET /artifacts/stats` returns total artifact count, total storage used (inline + disk), and breakdown by storage mode.

## Non-Goals

- Artifact-level search (searching inside file contents) -- out of scope
- Standalone artifacts without a parent memory -- explicitly rejected
- Streaming uploads -- not needed at these sizes
- Encryption at rest for artifacts -- relies on existing disk/volume encryption
