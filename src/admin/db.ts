// ============================================================================
// ADMIN DOMAIN - Prepared statements for admin operations
// ============================================================================

import { db } from "../db/connection.ts";

// ── Audit log queries ────────────────────────────────────────────────────────

export const countAuditLog = db.prepare(
  "SELECT COUNT(*) as count FROM audit_log"
);

/** Build dynamic audit query - returns both the sql string and params array. */
export function buildAuditQuery(action?: string | null, limit = 50, offset = 0): { sql: string; params: unknown[] } {
  let sql = "SELECT * FROM audit_log WHERE 1=1";
  const params: unknown[] = [];
  if (action) { sql += " AND action = ?"; params.push(action); }
  sql += " ORDER BY id DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  return { sql, params };
}

// ── Tenant / user queries ────────────────────────────────────────────────────

export const insertUser = db.prepare(
  "INSERT INTO users (username, email, role, is_admin) VALUES (?, ?, ?, ?) RETURNING id"
);

export const insertDefaultSpace = db.prepare(
  "INSERT INTO spaces (user_id, name, description) VALUES (?, ?, ?)"
);

export const selectUser = db.prepare(
  "SELECT * FROM users WHERE id = ?"
);

export const deleteUser = db.prepare(
  "DELETE FROM users WHERE id = ?"
);

export const countUserMemories = db.prepare(
  "SELECT COUNT(*) as c FROM memories WHERE user_id = ?"
);

export const countUserConversations = db.prepare(
  "SELECT COUNT(*) as c FROM conversations WHERE user_id = ?"
);

export const deleteUserMemories = db.prepare(
  "DELETE FROM memories WHERE user_id = ?"
);

export const tenantsQuery = db.prepare(`
  SELECT
    u.id as user_id,
    u.username,
    u.role,
    u.created_at,
    (SELECT COUNT(*) FROM memories WHERE user_id = u.id AND is_forgotten = 0) as memory_count,
    (SELECT COUNT(*) FROM conversations WHERE user_id = u.id) as conversation_count,
    (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id AND is_active = 1) as active_keys,
    (SELECT COUNT(*) FROM spaces WHERE user_id = u.id) as space_count,
    (SELECT MAX(ak.last_used_at) FROM api_keys ak WHERE ak.user_id = u.id) as last_active,
    tq.max_memories
  FROM users u
  LEFT JOIN tenant_quotas tq ON tq.user_id = u.id
  ORDER BY u.id
`);

export const allQuotas = db.prepare(
  "SELECT tq.*, u.username FROM tenant_quotas tq JOIN users u ON tq.user_id = u.id"
);

// ── GC queries (used in admin/gc endpoint) ───────────────────────────────────

export const countForgottenStale = db.prepare(
  `SELECT COUNT(*) as c FROM memories WHERE is_forgotten = 1 AND updated_at < datetime('now', '-30 days')`
);

export const countOrphanedLinks = db.prepare(
  `SELECT COUNT(*) as c FROM memory_links ml
   WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = ml.source_id AND m.is_forgotten = 0)
      OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = ml.target_id AND m.is_forgotten = 0)`
);

export const countExpiredScratch = db.prepare(
  `SELECT COUNT(*) as c FROM scratchpad WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`
);

export const countOldAudit = db.prepare(
  `SELECT COUNT(*) as c FROM audit_log WHERE created_at < datetime('now', '-90 days')`
);

export const countOldJobs = db.prepare(
  `SELECT COUNT(*) as c FROM jobs WHERE status IN ('completed', 'failed') AND completed_at < datetime('now', '-7 days')`
);

export const countOrphanedSignals = db.prepare(
  `SELECT COUNT(*) as c FROM personality_signals ps
   WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = ps.memory_id)`
);

// ── WAL checkpoint ───────────────────────────────────────────────────────────

export const walCheckpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)");

// ── Backup / integrity queries ───────────────────────────────────────────────

export const integrityCheck = db.prepare("PRAGMA integrity_check");

export const foreignKeyCheck = db.prepare("PRAGMA foreign_key_check");

export const walCheckpointPassive = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");

export const countAllMemories = db.prepare("SELECT COUNT(*) as count FROM memories");

export const countAllTables = db.prepare(
  "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'"
);

// ── Cold storage / scale queries ─────────────────────────────────────────────

export const countTotalNonForgotten = db.prepare(
  "SELECT COUNT(*) as c FROM memories WHERE is_forgotten = 0"
);

export const countWithEmbedding = db.prepare(
  "SELECT COUNT(*) as c FROM memories WHERE is_forgotten = 0 AND embedding IS NOT NULL"
);

export const coldStorageDistribution = db.prepare(`
  SELECT
    CASE
      WHEN last_accessed_at IS NULL AND created_at < datetime('now', '-90 days') THEN 'never_accessed_90d+'
      WHEN last_accessed_at IS NULL AND created_at < datetime('now', '-30 days') THEN 'never_accessed_30d+'
      WHEN last_accessed_at IS NULL THEN 'never_accessed_recent'
      WHEN last_accessed_at < datetime('now', '-365 days') THEN 'cold_365d+'
      WHEN last_accessed_at < datetime('now', '-90 days') THEN 'cold_90d+'
      WHEN last_accessed_at < datetime('now', '-30 days') THEN 'cool_30d+'
      ELSE 'hot'
    END as tier,
    COUNT(*) as count
  FROM memories WHERE is_forgotten = 0
  GROUP BY tier ORDER BY count DESC
`);

// ── Usage queries ────────────────────────────────────────────────────────────

export const adminUsageByUser = db.prepare(`
  SELECT u.username, ue.user_id, ue.event_type, SUM(ue.quantity) as total
  FROM usage_events ue
  JOIN users u ON u.id = ue.user_id
  WHERE ue.created_at > ?
  GROUP BY ue.user_id, ue.event_type
  ORDER BY total DESC
`);

export const adminUsageTotals = db.prepare(`
  SELECT event_type, SUM(quantity) as total, COUNT(DISTINCT user_id) as unique_users
  FROM usage_events WHERE created_at > ?
  GROUP BY event_type ORDER BY total DESC
`);

// ── Schema / migration queries ────────────────────────────────────────────────

export const schemaIndexes = db.prepare(
  `SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name`
);

export function getSchemaMigrations(): unknown[] {
  try {
    return db.prepare("SELECT * FROM schema_versions ORDER BY version DESC LIMIT 20").all();
  } catch {
    return [];
  }
}

// ── State queries ─────────────────────────────────────────────────────────────

export const stateByKey = db.prepare(
  "SELECT * FROM current_state WHERE user_id = ? AND key LIKE ? ORDER BY updated_at DESC"
);

export const stateAll = db.prepare(
  "SELECT * FROM current_state WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100"
);

export const deleteStateByKey = db.prepare(
  "DELETE FROM current_state WHERE user_id = ? AND key LIKE ?"
);

export const deleteStateAll = db.prepare(
  "DELETE FROM current_state WHERE user_id = ?"
);

// ── Export queries ────────────────────────────────────────────────────────────

export const exportMemories = db.prepare(
  `SELECT id, content, category, source, importance, version, is_latest,
     parent_memory_id, root_memory_id, source_count, is_static, is_forgotten,
     is_archived, forget_after, forget_reason, is_inference, created_at, updated_at
   FROM memories WHERE user_id = ? ORDER BY id`
);

export const exportMemoriesWithSpace = db.prepare(
  `SELECT id, content, category, source, importance, version, is_latest,
     parent_memory_id, root_memory_id, source_count, is_static, is_forgotten,
     is_archived, forget_after, forget_reason, is_inference, created_at, updated_at
   FROM memories WHERE user_id = ? AND space_id = ? ORDER BY id`
);

export const exportLinks = db.prepare(
  `SELECT ml.source_id, ml.target_id, ml.similarity, ml.type
   FROM memory_links ml
   JOIN memories m ON ml.source_id = m.id
   WHERE m.user_id = ?`
);
