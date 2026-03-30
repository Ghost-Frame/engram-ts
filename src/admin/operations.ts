// ============================================================================
// ADMIN DOMAIN -- Heavy operations (reembed, rebuild FTS, compact, GC, etc.)
// ============================================================================

import { db } from "../db/connection.ts";
import { log } from "../config/logger.ts";
import {
  countForgottenStale, countOrphanedLinks, countExpiredScratch,
  countOldAudit, countOldJobs, countOrphanedSignals,
} from "./db.ts";
import type { GcResult } from "./types.ts";

// ── Re-embed all memories ─────────────────────────────────────────────────────

/**
 * Triggers a full re-embed sweep using the current embedding provider.
 * Heavy operation -- may take minutes on large corpora.
 * TODO: Move progress tracking to a background job for async reporting.
 */
export async function runReembed(triggeredBy: number): Promise<Record<string, unknown>> {
  const { reembedAll, getEmbeddingProviderInfo } = await import("../embeddings/index.ts");
  const info = getEmbeddingProviderInfo();
  log.info({ msg: "reembed_started", ...info, triggered_by: triggeredBy });
  const result = await reembedAll((done: number, total: number) => {
    log.info({ msg: "reembed_progress", done, total, pct: Math.round(done / total * 100) });
  });
  return { ...result, provider: info };
}

// ── Backfill fact validity ────────────────────────────────────────────────────

/**
 * Populates valid_at for existing facts that are missing it.
 * TODO: Consider batching for large databases.
 */
export async function runBackfillFacts(userId: number): Promise<{ backfilled: number }> {
  const { backfillFactValidity } = await import("../intelligence/temporal.ts");
  const filled = backfillFactValidity(userId);
  return { backfilled: filled };
}

// ── Rebuild entity cooccurrences ──────────────────────────────────────────────

/**
 * Rebuilds the entity co-occurrence graph from scratch for a given user.
 * TODO: Support global rebuild (all users) via admin flag.
 */
export async function runRebuildCooccurrences(userId: number): Promise<{ rebuilt_pairs: number }> {
  const { rebuildCooccurrences } = await import("../graph/cooccurrence.ts");
  const pairs = rebuildCooccurrences(userId);
  return { rebuilt_pairs: pairs };
}

// ── Community detection ───────────────────────────────────────────────────────

/**
 * Runs Louvain-style label propagation community detection on the memory graph.
 */
export async function runDetectCommunities(userId: number): Promise<Record<string, unknown>> {
  const { detectCommunities } = await import("../graph/communities.ts");
  return detectCommunities(userId) as Record<string, unknown>;
}

// ── Rebuild FTS index ─────────────────────────────────────────────────────────

/**
 * Drops and recreates the memories_fts FTS5 virtual table with all triggers.
 * Destructive to existing FTS data but safe (rebuilt from memories table).
 */
export function runRebuildFts(): { rebuilt: boolean; rows: number; elapsed_ms: number } {
  const startMs = performance.now();

  db.exec("DROP TABLE IF EXISTS memories_fts");
  db.exec(`
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      content, category, source,
      content_rowid='id', tokenize='porter unicode61'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category, source) VALUES (NEW.id, NEW.content, NEW.category, NEW.source);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, source) VALUES('delete', OLD.id, OLD.content, OLD.category, OLD.source);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, source) VALUES('delete', OLD.id, OLD.content, OLD.category, OLD.source);
      INSERT INTO memories_fts(rowid, content, category, source) VALUES (NEW.id, NEW.content, NEW.category, NEW.source);
    END
  `);
  db.exec("INSERT INTO memories_fts(rowid, content, category, source) SELECT id, content, category, source FROM memories WHERE is_forgotten = 0");

  const elapsedMs = Math.round(performance.now() - startMs);
  const count = (db.prepare("SELECT COUNT(*) as c FROM memories_fts").get() as any).c;
  return { rebuilt: true, rows: count, elapsed_ms: elapsedMs };
}

// ── Refresh embedding cache ───────────────────────────────────────────────────
// NOTE: runRefreshCache is intentionally omitted here.
// routes.ts imports refreshEmbeddingCache and getEmbeddingCacheStats directly
// from ../embeddings/index.ts and calls them inline to avoid circular deps.

// ── Compact (VACUUM + ANALYZE) ────────────────────────────────────────────────

import { statSync } from "fs";
import { DB_PATH } from "../config/index.ts";
import { cleanupOldUsage } from "../db/index.ts";
import { refreshEmbeddingCache } from "../embeddings/index.ts";

export function runCompact(): {
  compacted: boolean;
  before_size_mb: number;
  after_size_mb: number;
  saved_mb: number;
  elapsed_ms: number;
} {
  const beforeSize = statSync(DB_PATH).size;
  const startMs = performance.now();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.exec("ANALYZE");
  const afterSize = statSync(DB_PATH).size;
  const elapsedMs = Math.round(performance.now() - startMs);
  const savedBytes = beforeSize - afterSize;
  return {
    compacted: true,
    before_size_mb: Math.round(beforeSize / 1048576 * 100) / 100,
    after_size_mb: Math.round(afterSize / 1048576 * 100) / 100,
    saved_mb: Math.round(savedBytes / 1048576 * 100) / 100,
    elapsed_ms: elapsedMs,
  };
}

// ── GC (garbage collection) ───────────────────────────────────────────────────

/**
 * Identifies and optionally deletes stale/orphaned rows across multiple tables.
 * Default is dry_run=true to prevent accidental data loss.
 */
export function runGc(dryRun: boolean): GcResult {
  const results: Record<string, number> = {};

  results.forgotten_stale = (countForgottenStale.get() as any).c;
  results.orphaned_links = (countOrphanedLinks.get() as any).c;
  results.expired_scratchpad = (countExpiredScratch.get() as any).c;
  results.old_audit_entries = (countOldAudit.get() as any).c;
  results.old_jobs = (countOldJobs.get() as any).c;
  results.orphaned_signals = (countOrphanedSignals.get() as any).c;

  const totalReclaimable = Object.values(results).reduce((a, b) => a + b, 0);

  if (!dryRun) {
    db.exec(`DELETE FROM memories WHERE is_forgotten = 1 AND updated_at < datetime('now', '-30 days')`);
    db.exec(`DELETE FROM memory_links WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.source_id AND m.is_forgotten = 0) OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.target_id AND m.is_forgotten = 0)`);
    db.exec(`DELETE FROM scratchpad WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`);
    db.exec(`DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')`);
    db.exec(`DELETE FROM jobs WHERE status IN ('completed', 'failed') AND completed_at < datetime('now', '-7 days')`);
    db.exec(`DELETE FROM personality_signals WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = personality_signals.memory_id)`);

    // Clean up old usage events (keep 180 days)
    try { cleanupOldUsage.run(180); } catch {}

    // Reload embedding cache after deleting forgotten memories
    try { refreshEmbeddingCache(); } catch {}
  }

  return {
    dry_run: dryRun,
    reclaimable_rows: totalReclaimable,
    breakdown: results as any,
    message: dryRun
      ? "Run with { dry_run: false } to execute cleanup"
      : `Deleted ${totalReclaimable} rows`,
  };
}
