// ============================================================================
// DATABASE CONNECTION - DB open, WAL, pragmas, migrate() helper, version tracking
// ============================================================================

import Database from 'libsql';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { log, opsCounters } from '../config/logger.ts';
import { DB_PATH, DATA_DIR, DEFAULT_RATE_LIMIT, DEFAULT_IMPORTANCE, EMBEDDING_DIM } from '../config/index.ts';

export function embeddingToVectorJSON(emb: Float32Array): string {
  if (emb.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding length ${emb.length} !== expected ${EMBEDDING_DIM}`);
  }
  for (let i = 0; i < emb.length; i++) {
    if (!Number.isFinite(emb[i])) {
      throw new Error(`Invalid embedding value at index ${i}: ${emb[i]}`);
    }
  }
  return "[" + Array.from(emb).join(",") + "]";
}

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous=NORMAL');    // NORMAL is safe for WAL mode (fsync on checkpoint)
db.exec('PRAGMA foreign_keys=ON');
db.exec('PRAGMA busy_timeout=5000');
db.exec('PRAGMA wal_autocheckpoint=1000'); // Auto-checkpoint every 1000 pages (~4MB)

// Startup integrity check (quick_check is fast, catches most corruption)
try {
  const result = db.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
  if (result && result.quick_check !== 'ok') {
    log.error({ msg: "db_integrity_check_failed", result: result.quick_check });
  }
} catch (e: any) {
  log.error({ msg: "db_integrity_check_error", error: e.message });
}

// Migration helper - logs unexpected errors instead of swallowing them silently
// Schema version tracking
db.exec("CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')), description TEXT)");

export function _getSchemaVersion(): number {
  try {
    const row = db.prepare("SELECT MAX(version) as v FROM schema_versions").get() as { v: number | null };
    return row?.v || 0;
  } catch { return 0; }
}

export function setSchemaVersion(version: number, description: string): void {
  db.prepare("INSERT OR IGNORE INTO schema_versions (version, description) VALUES (?, ?)").run(version, description);
}

export function migrate(sql: string) {
  try {
    db.exec(sql);
  } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.warn({ msg: "migration_error", sql: sql.slice(0, 120), error: msg });
  }
}

// Critical migrations that must succeed or block startup
export function migrateCritical(sql: string, description: string) {
  try {
    db.exec(sql);
  } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.error({ msg: "critical_migration_failed", description, sql: sql.slice(0, 120), error: msg });
    throw new Error(`Critical migration failed: ${description} - ${msg}`);
  }
}

// v5.9 - Dynamic vector column matching configured EMBEDDING_DIM
export const VECTOR_COL = `embedding_vec_${EMBEDDING_DIM}`;
const EP_VECTOR_COL = `ep_embedding_vec_${EMBEDDING_DIM}`;

// ============================================================================
// SCHEMA REGISTRATION - load modules in dependency order
// ============================================================================

import * as base from './schema/base.ts';
import * as fts from './schema/fts.ts';
import * as episodes from './schema/episodes.ts';
import * as intelligence from './schema/intelligence.ts';
import * as tier4 from './schema/tier4.ts';
import * as services from './schema/services.ts';
import * as schemaMigrations from './schema/migrations.ts';

base.register(db);

// v5.0 - Native vector column (libsql FLOAT32) - SKIP if already dropped by v60 migration
if (_getSchemaVersion() < 60) {
  migrate("ALTER TABLE memories ADD COLUMN embedding_vec FLOAT32(384)");
  migrate("CREATE INDEX IF NOT EXISTS memories_vec_idx ON memories(libsql_vector_idx(embedding_vec))");
}

fts.register(db);
episodes.register(db);
intelligence.register(db);
tier4.register(db);
services.register(db);
schemaMigrations.register(db);

// v5.9.1 - Drop unused 384-dim ghost vector column (0 rows populated, contributes to vtab corruption)
if (_getSchemaVersion() < 60) {
  migrate("DROP INDEX IF EXISTS memories_vec_idx");
  try { db.exec("ALTER TABLE memories DROP COLUMN embedding_vec"); } catch {}
  setSchemaVersion(60, "Drop unused 384-dim ghost vector column");
  log.info({ msg: "dropped_384_ghost_column" });
}

// Record current schema version (idempotent -- INSERT OR IGNORE)
setSchemaVersion(1, "initial schema with all tables and indexes");
setSchemaVersion(2, "insertMemory accepts user_id and space_id atomically");
setSchemaVersion(512, "artifact storage table");
setSchemaVersion(513, "artifact FTS5 index and encryption columns");
setSchemaVersion(514, "atomic fact decomposition columns");

log.info({ msg: "schema_version", version: _getSchemaVersion() });

// ============================================================================
// SCHEMA UTILITIES
// ============================================================================

export function getSchemaVersion(): number {
  try {
    const row = db.prepare("SELECT MAX(version) as v FROM schema_versions").get() as any;
    return row?.v || 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// WRITE LOCK HELPER (Phase 2.1)
// ============================================================================

let activeWrites = 0;

export function withWriteLock<T>(label: string, fn: () => T): T {
  activeWrites++;
  opsCounters.db_write_queue_depth = Math.max(opsCounters.db_write_queue_depth, activeWrites);
  if (activeWrites > 1) {
    opsCounters.db_lock_waits++;
    log.debug({ msg: "db_write_contention", label, depth: activeWrites });
  }
  try {
    return fn();
  } catch (e: any) {
    if (String(e).includes("database is locked") || String(e).includes("SQLITE_BUSY")) {
      opsCounters.db_lock_timeouts++;
      log.error({ msg: "db_lock_timeout", label, depth: activeWrites });
    }
    throw e;
  } finally {
    activeWrites--;
  }
}
