// ============================================================================
// DATABASE - Prepared statements, query functions, audit
// ============================================================================

import { log, opsCounters } from '../config/logger.ts';
import { EMBEDDING_DIM } from '../config/index.ts';
import { FSRSRating, type FSRSMemoryState, fsrsProcessReview, calculateDecayScore } from '../fsrs/index.ts';
import { db, embeddingToVectorJSON, VECTOR_COL, getSchemaVersion, migrate, withWriteLock } from './connection.ts';

// Re-export connection exports so existing imports from '../db' continue to work
export { db, embeddingToVectorJSON, VECTOR_COL, getSchemaVersion, migrate, withWriteLock } from './connection.ts';

export const insertAudit = db.prepare(
  "INSERT INTO audit_log (user_id, action, target_type, target_id, details, ip, request_id, agent_id, execution_hash, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
export function audit(userId: number | null, action: string, targetType: string | null, targetId: number | null, details: string | null, ip: string | null, requestId: string | null, agentId?: number | null, executionHash?: string | null, signature?: string | null) {
  try { insertAudit.run(userId, action, targetType, targetId, details, ip, requestId, agentId ?? null, executionHash ?? null, signature ?? null); } catch (e: any) { log.warn({ msg: "audit_write_fail", action, error: String(e).slice(0, 200) }); }
}

// ============================================================================
// PREPARED STATEMENTS - memories (v3)
// ============================================================================

export const insertMemory = db.prepare(
  `INSERT INTO memories (content, category, source, session_id, importance, embedding,
    version, is_latest, parent_memory_id, root_memory_id, source_count, is_static,
    is_forgotten, forget_after, forget_reason, is_inference, model, user_id, space_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   RETURNING id, created_at`
);

export const updateMemoryEmbedding = db.prepare(
  `UPDATE memories SET embedding = ? WHERE id = ?`
);

export let updateMemoryVec = db.prepare(
  `UPDATE memories SET ${VECTOR_COL} = vector(?) WHERE id = ?`
);

/** Write vector column for a newly inserted memory (call after insertMemory) */
export function writeVec(memoryId: number, embArray: Float32Array | null): void {
  if (!embArray) return;
  // Validate BEFORE attempting DB write - reject poison data at the gate
  let vecJson: string;
  try {
    vecJson = embeddingToVectorJSON(embArray);
  } catch (e: any) {
    log.warn({ msg: "vec_write_rejected_invalid_embedding", id: memoryId, error: e.message });
    opsCounters.vec_write_failures++;
    return; // Do NOT write invalid data - skip silently
  }
  try {
    updateMemoryVec.run(vecJson, memoryId);
  } catch (e: any) {
    opsCounters.vec_write_failures++;
    if (!_rebuildInProgress && (e.code?.includes("CORRUPT") || e.message?.includes("malformed"))) {
      log.error({ msg: "vec_write_corrupt_detected", id: memoryId, triggering_rebuild: true });
      rebuildVectorIndex();
      try { updateMemoryVec.run(vecJson, memoryId); } catch (retryErr: any) {
        log.error({ msg: "vec_write_retry_failed", id: memoryId, error: retryErr.message });
      }
    } else {
      log.warn({ msg: "vec_write_failed", id: memoryId, error: e?.message });
    }
  }
}

/** Fast corruption probe - tries a no-op vector update in a transaction, rolls back. Returns true if healthy. */
export function probeVectorHealth(): boolean {
  try {
    const testRow = db.prepare(`SELECT id FROM memories WHERE ${VECTOR_COL} IS NOT NULL LIMIT 1`).get() as { id: number } | undefined;
    if (!testRow) return true; // no vector data = nothing to corrupt
    db.exec("BEGIN");
    db.prepare(`UPDATE memories SET decay_score = decay_score WHERE id = ?`).run(testRow.id);
    db.exec("ROLLBACK");
    return true;
  } catch (e: any) {
    try { db.exec("ROLLBACK"); } catch {}
    if (e.code?.includes("CORRUPT") || e.message?.includes("malformed")) {
      log.error({ msg: "vector_health_probe_failed", error: e.message, code: e.code });
      return false;
    }
    // Non-corruption error, still healthy
    return true;
  }
}

let _rebuildInProgress = false;
export function isRebuildInProgress(): boolean { return _rebuildInProgress; }

const EP_VECTOR_COL = `ep_embedding_vec_${EMBEDDING_DIM}`;

/** Nuclear repair: drop all FLOAT32 columns and indexes, recreate empty, repopulate from BLOB embeddings. */
export function rebuildVectorIndex(): { dropped: number; recreated: number; repopulated: number } {
  if (_rebuildInProgress) return { dropped: 0, recreated: 0, repopulated: 0 };
  _rebuildInProgress = true;
  log.warn({ msg: "vector_rebuild_start" });
  const t0 = Date.now();
  let dropped = 0, recreated = 0, repopulated = 0;

  try {
    // Phase 1: Schema changes (DROP + ADD) - must be outside transaction (DDL in libsql)
    // Drop all vector indexes
    for (const idx of [
      "memories_vec_idx", "memories_vec_1024_idx",
      `memories_vec_${EMBEDDING_DIM}_idx`,
      "episodes_vec_1024_idx",
      `episodes_vec_${EMBEDDING_DIM}_idx`,
    ]) {
      try { db.exec(`DROP INDEX IF EXISTS ${idx}`); dropped++; } catch (e: any) {
        log.warn({ msg: "vector_rebuild_drop_index_skip", index: idx, error: e.message });
      }
    }

    // Drop FLOAT32 columns from memories
    for (const col of ["embedding_vec", "embedding_vec_1024", VECTOR_COL]) {
      try { db.exec(`ALTER TABLE memories DROP COLUMN ${col}`); dropped++; } catch (e: any) {
        log.warn({ msg: "vector_rebuild_drop_col_skip", table: "memories", col, error: e.message });
      }
    }
    // Drop from episodes
    for (const col of ["embedding_vec_1024", VECTOR_COL]) {
      try { db.exec(`ALTER TABLE episodes DROP COLUMN ${col}`); dropped++; } catch (e: any) {
        log.warn({ msg: "vector_rebuild_drop_col_skip", table: "episodes", col, error: e.message });
      }
    }

    // Recreate ONLY the current EMBEDDING_DIM column + indexes
    db.exec(`ALTER TABLE memories ADD COLUMN ${VECTOR_COL} FLOAT32(${EMBEDDING_DIM})`);
    db.exec(`CREATE INDEX IF NOT EXISTS memories_vec_${EMBEDDING_DIM}_idx ON memories(libsql_vector_idx(${VECTOR_COL}))`);
    recreated++;

    db.exec(`ALTER TABLE episodes ADD COLUMN ${VECTOR_COL} FLOAT32(${EMBEDDING_DIM})`);
    db.exec(`CREATE INDEX IF NOT EXISTS episodes_vec_${EMBEDDING_DIM}_idx ON episodes(libsql_vector_idx(${VECTOR_COL}))`);
    recreated++;

    // Re-prepare the vector update statements (old ones reference dropped columns)
    updateMemoryVec = db.prepare(`UPDATE memories SET ${VECTOR_COL} = vector(?) WHERE id = ?`);
    updateEpisodeVec = db.prepare(`UPDATE episodes SET ${VECTOR_COL} = vector(?) WHERE id = ?`);

    // Phase 2: Repopulate from BLOB embeddings (batched, in transaction)
    const BATCH = 100;
    let memoryErrors = 0, episodeErrors = 0;

    // Repopulate memories
    let offset = 0;
    while (true) {
      const rows = db.prepare(
        `SELECT id, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY id LIMIT ? OFFSET ?`
      ).all(BATCH, offset) as Array<{ id: number; embedding: Buffer }>;
      if (!rows || rows.length === 0) break;
      const batchWrite = db.transaction(() => {
        for (const row of rows) {
          try {
            const buf = row.embedding instanceof Buffer ? row.embedding : Buffer.from(row.embedding as any);
            const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
            if (f32.length === EMBEDDING_DIM) {
              updateMemoryVec.run(embeddingToVectorJSON(f32), row.id);
              repopulated++;
            }
          } catch (e: any) {
            memoryErrors++;
            if (memoryErrors <= 5) log.warn({ msg: "vector_rebuild_row_skip", table: "memories", id: row.id, error: e.message });
          }
        }
      });
      batchWrite();
      offset += BATCH;
    }

    // Repopulate episodes
    offset = 0;
    while (true) {
      const rows = db.prepare(
        `SELECT id, embedding FROM episodes WHERE embedding IS NOT NULL ORDER BY id LIMIT ? OFFSET ?`
      ).all(BATCH, offset) as Array<{ id: number; embedding: Buffer }>;
      if (!rows || rows.length === 0) break;
      const batchWrite = db.transaction(() => {
        for (const row of rows) {
          try {
            const buf = row.embedding instanceof Buffer ? row.embedding : Buffer.from(row.embedding as any);
            const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
            if (f32.length === EMBEDDING_DIM) {
              updateEpisodeVec.run(embeddingToVectorJSON(f32), row.id);
              repopulated++;
            }
          } catch (e: any) {
            episodeErrors++;
            if (episodeErrors <= 5) log.warn({ msg: "vector_rebuild_row_skip", table: "episodes", id: row.id, error: e.message });
          }
        }
      });
      batchWrite();
      offset += BATCH;
    }

    log.warn({ msg: "vector_rebuild_complete", dropped, recreated, repopulated, memory_errors: memoryErrors, episode_errors: episodeErrors, ms: Date.now() - t0 });
  } catch (e: any) {
    log.error({ msg: "vector_rebuild_fatal", error: e.message, phase: "rebuild" });
    throw e; // Let caller know rebuild failed
  } finally {
    _rebuildInProgress = false;
  }

  return { dropped, recreated, repopulated };
}

export const getAllEmbeddings = db.prepare(
  `SELECT id, user_id, content, category, importance, embedding, is_latest, is_forgotten, is_static, source_count, source
   FROM memories WHERE embedding IS NOT NULL AND is_forgotten = 0`
);

export const getLatestEmbeddings = db.prepare(
  `SELECT id, content, category, importance, embedding, is_static, source_count
   FROM memories WHERE embedding IS NOT NULL AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND status = 'approved'`
);

export const searchMemoriesFTS = db.prepare(
  `SELECT m.id, m.content, m.category, m.source, m.session_id, m.importance, m.created_at,
     m.version, m.is_latest, m.parent_memory_id, m.root_memory_id, m.source_count,
     m.is_static, m.is_forgotten, m.is_inference, m.model,
     rank as fts_rank
   FROM memories_fts f
   JOIN memories m ON f.rowid = m.id
   WHERE memories_fts MATCH ? AND m.is_forgotten = 0 AND m.user_id = ?
   ORDER BY rank
   LIMIT ?`
);

export const listRecent = db.prepare(
  `SELECT id, content, category, source, session_id, importance, created_at,
     version, is_latest, parent_memory_id, root_memory_id, source_count,
     is_static, is_forgotten, is_inference, forget_after, is_archived, status, model
   FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND status != 'pending' AND user_id = ? ORDER BY created_at DESC LIMIT ?`
);

export const listByCategory = db.prepare(
  `SELECT id, content, category, source, session_id, importance, created_at,
     version, is_latest, parent_memory_id, root_memory_id, source_count,
     is_static, is_forgotten, is_inference, forget_after, is_archived, status, model
   FROM memories WHERE category = ? AND is_forgotten = 0 AND is_archived = 0 AND status != 'pending' AND user_id = ? ORDER BY created_at DESC LIMIT ?`
);

const nullifyParentRefs = db.prepare(`UPDATE memories SET parent_memory_id = NULL WHERE parent_memory_id = ?`);
const nullifyRootRefs = db.prepare(`UPDATE memories SET root_memory_id = NULL WHERE root_memory_id = ?`);
export const deleteMemory = db.transaction((id: number) => {
  nullifyParentRefs.run(id);
  nullifyRootRefs.run(id);
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
});
export const getMemory = db.prepare(`SELECT id, content, category, source, session_id, importance, embedding, version, is_latest, parent_memory_id, root_memory_id, source_count, is_static, is_forgotten, forget_after, forget_reason, is_inference, is_archived, created_at, updated_at, model, last_accessed_at, access_count, tags, episode_id, decay_score, confidence, sync_id, status, fsrs_stability, fsrs_difficulty, fsrs_storage_strength, fsrs_retrieval_strength, fsrs_learning_state, fsrs_reps, fsrs_lapses, fsrs_last_review_at, user_id, space_id, recall_hits, recall_misses, adaptive_score FROM memories WHERE id = ?`);

export const getMemoryWithoutEmbedding = db.prepare(
  `SELECT id, user_id, content, category, source, session_id, importance, created_at, updated_at,
     version, is_latest, parent_memory_id, root_memory_id, source_count,
     is_static, is_forgotten, forget_after, forget_reason, is_inference, is_archived, status, model,
     tags, episode_id, access_count, last_accessed_at, confidence
   FROM memories WHERE id = ?`
);

// Version chain queries
export const getVersionChain = db.prepare(
  `SELECT id, content, category, version, is_latest, created_at, source_count
   FROM memories WHERE root_memory_id = ? OR id = ?
   ORDER BY version ASC`
);

export const markSuperseded = db.prepare(
  `UPDATE memories SET is_latest = 0, updated_at = datetime('now') WHERE id = ?`
);

export const incrementSourceCount = db.prepare(
  `UPDATE memories SET source_count = source_count + 1, updated_at = datetime('now') WHERE id = ?`
);

// Forgetting
export const markForgotten = db.prepare(
  `UPDATE memories SET is_forgotten = 1, updated_at = datetime('now') WHERE id = ?`
);

export const markArchived = db.prepare(
  `UPDATE memories SET is_archived = 1, updated_at = datetime('now') WHERE id = ?`
);

export const markUnarchived = db.prepare(
  `UPDATE memories SET is_archived = 0, updated_at = datetime('now') WHERE id = ?`
);

export const getExpiredMemories = db.prepare(
  `SELECT id, content, forget_reason FROM memories
   WHERE forget_after IS NOT NULL AND forget_after <= datetime('now')
   AND is_forgotten = 0`
);

// Memory links - v3 typed
export const insertLink = db.prepare(
  `INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, type) VALUES (?, ?, ?, ?)`
);

export const getLinksFor = db.prepare(
  `SELECT ml.target_id as id, ml.similarity, ml.type, m.content, m.category, m.importance, m.created_at,
     m.is_latest, m.is_forgotten, m.version, m.source_count, m.model, m.source
   FROM memory_links ml
   JOIN memories m ON ml.target_id = m.id
   WHERE ml.source_id = ?
   UNION
   SELECT ml.source_id as id, ml.similarity, ml.type, m.content, m.category, m.importance, m.created_at,
     m.is_latest, m.is_forgotten, m.version, m.source_count, m.model, m.source
   FROM memory_links ml
   JOIN memories m ON ml.source_id = m.id
   WHERE ml.target_id = ?
   ORDER BY similarity DESC`
);

// User-scoped variants for search module
export const getLinksForUser = db.prepare(
  `SELECT ml.target_id as id, ml.similarity, ml.type, m.content, m.category, m.importance, m.created_at,
     m.is_latest, m.is_forgotten, m.version, m.source_count, m.model, m.source
   FROM memory_links ml
   JOIN memories m ON ml.target_id = m.id
   WHERE ml.source_id = ? AND m.user_id = ?
   UNION
   SELECT ml.source_id as id, ml.similarity, ml.type, m.content, m.category, m.importance, m.created_at,
     m.is_latest, m.is_forgotten, m.version, m.source_count, m.model, m.source
   FROM memory_links ml
   JOIN memories m ON ml.source_id = m.id
   WHERE ml.target_id = ? AND m.user_id = ?
   ORDER BY similarity DESC`
);

export const getVersionChainForUser = db.prepare(
  `SELECT id, content, category, version, is_latest, created_at, source_count
   FROM memories WHERE (root_memory_id = ? OR id = ?) AND user_id = ?
   ORDER BY version ASC`
);

// Batch link queries to eliminate N+1 in search
export function getLinksForUserBatch(
  ids: number[], userId: number
): Map<number, Array<{ from_id: number; id: number; similarity: number; type: string; content: string; category: string; importance: number; created_at: string; is_latest: number; is_forgotten: number; version: number; source_count: number; model: string | null; source: string | null }>> {
  if (ids.length === 0) return new Map();
  const ph = ids.map(() => "?").join(",");
  const sql = `
    SELECT ml.source_id as from_id, ml.target_id as id, ml.similarity, ml.type,
      m.content, m.category, m.importance, m.created_at,
      m.is_latest, m.is_forgotten, m.version, m.source_count, m.model, m.source
    FROM memory_links ml JOIN memories m ON ml.target_id = m.id
    WHERE ml.source_id IN (${ph}) AND m.user_id = ?
    UNION ALL
    SELECT ml.target_id as from_id, ml.source_id as id, ml.similarity, ml.type,
      m.content, m.category, m.importance, m.created_at,
      m.is_latest, m.is_forgotten, m.version, m.source_count, m.model, m.source
    FROM memory_links ml JOIN memories m ON ml.source_id = m.id
    WHERE ml.target_id IN (${ph}) AND m.user_id = ?
    ORDER BY similarity DESC`;
  const rows = db.prepare(sql).all(...ids, userId, ...ids, userId) as any[];
  const result = new Map<number, Array<any>>();
  for (const row of rows) {
    if (!result.has(row.from_id)) result.set(row.from_id, []);
    result.get(row.from_id)!.push(row);
  }
  return result;
}

export function getVersionChainBatch(
  rootIds: number[], userId: number
): Map<number, Array<{ id: number; content: string; category: string; version: number; is_latest: number; created_at: string; source_count: number }>> {
  if (rootIds.length === 0) return new Map();
  const unique = [...new Set(rootIds)];
  const ph = unique.map(() => "?").join(",");
  const sql = `
    SELECT root_memory_id, id, content, category, version, is_latest, created_at, source_count
    FROM memories WHERE (root_memory_id IN (${ph}) OR id IN (${ph})) AND user_id = ?
    ORDER BY version ASC`;
  const rows = db.prepare(sql).all(...unique, ...unique, userId) as any[];
  const result = new Map<number, Array<any>>();
  for (const row of rows) {
    const key = row.root_memory_id || row.id;
    if (!result.has(key)) result.set(key, []);
    result.get(key)!.push(row);
  }
  return result;
}

export const countNoEmbedding = db.prepare(
  `SELECT COUNT(*) as count FROM memories WHERE embedding IS NULL`
);
export const countNoEmbeddingForUser = db.prepare(
  `SELECT COUNT(*) as count FROM memories WHERE embedding IS NULL AND user_id = ?`
);
export const getNoEmbedding = db.prepare(
  `SELECT id, content FROM memories WHERE embedding IS NULL LIMIT ?`
);
export const getNoEmbeddingForUser = db.prepare(
  `SELECT id, content FROM memories WHERE embedding IS NULL AND user_id = ? LIMIT ?`
);

// Profile queries
export const getStaticMemories = db.prepare(
  `SELECT id, content, category, source_count, created_at, updated_at, model, source
   FROM memories WHERE is_static = 1 AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND status = 'approved' AND user_id = ?
   ORDER BY source_count DESC, updated_at DESC`
);

// Access tracking + FSRS review processing
export const trackAccess = db.prepare(
  `UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?`
);
export const updateFSRS = db.prepare(
  `UPDATE memories SET fsrs_stability = ?, fsrs_difficulty = ?, fsrs_storage_strength = ?,
   fsrs_retrieval_strength = ?, fsrs_learning_state = ?, fsrs_reps = ?, fsrs_lapses = ?,
   fsrs_last_review_at = ? WHERE id = ?`
);
export const getFSRS = db.prepare(
  `SELECT fsrs_stability, fsrs_difficulty, fsrs_storage_strength, fsrs_retrieval_strength,
   fsrs_learning_state, fsrs_reps, fsrs_lapses, fsrs_last_review_at, last_accessed_at, created_at
   FROM memories WHERE id = ?`
);

/** Track access AND process as FSRS review (Grade: Good=recall, Again=forget) */
export function trackAccessWithFSRS(memoryId: number, grade: FSRSRating = FSRSRating.Good): void {
  trackAccess.run(memoryId);
  const row = getFSRS.get(memoryId) as any;
  if (!row) return;

  const state: FSRSMemoryState | null = row.fsrs_stability != null ? {
    stability: row.fsrs_stability, difficulty: row.fsrs_difficulty,
    storage_strength: row.fsrs_storage_strength ?? 1, retrieval_strength: row.fsrs_retrieval_strength ?? 1,
    learning_state: row.fsrs_learning_state ?? 0, reps: row.fsrs_reps ?? 0, lapses: row.fsrs_lapses ?? 0,
    last_review_at: row.fsrs_last_review_at ?? row.created_at,
  } : null;

  const refTime = state?.last_review_at || row.last_accessed_at || row.created_at;
  const elapsed = (Date.now() - new Date(refTime + "Z").getTime()) / 86400000;
  const newState = fsrsProcessReview(state, grade, elapsed);

  updateFSRS.run(
    newState.stability, newState.difficulty, newState.storage_strength,
    newState.retrieval_strength, newState.learning_state, newState.reps, newState.lapses,
    newState.last_review_at, memoryId
  );
}

export function updateDecayScores(userId?: number): number {
  const query = userId != null
    ? `SELECT id, importance, created_at, access_count, last_accessed_at, is_static, source_count, fsrs_stability
       FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?`
    : `SELECT id, importance, created_at, access_count, last_accessed_at, is_static, source_count, fsrs_stability
       FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1`;
  const memories = (userId != null
    ? db.prepare(query).all(userId)
    : db.prepare(query).all()) as Array<any>;

  let updated = 0;
  let promoted = 0;
  const updateDecay = db.prepare(`UPDATE memories SET decay_score = ? WHERE id = ?`);
  const promoteToStatic = db.prepare(`UPDATE memories SET is_static = 1 WHERE id = ?`);

  // Core memory auto-promotion thresholds (from Letta/MemGPT pattern)
  // A memory qualifies for core tier if it's accessed frequently AND reinforced by multiple sources
  const PROMOTE_ACCESS_THRESHOLD = 8;   // accessed 8+ times
  const PROMOTE_SOURCE_THRESHOLD = 3;   // stored by 3+ different sources
  const PROMOTE_STABILITY_THRESHOLD = 5; // FSRS stability > 5 (well-learned)

  const batch = db.transaction(() => {
    for (const m of memories) {
      const score = calculateDecayScore(
        m.importance, m.created_at, m.access_count, m.last_accessed_at,
        !!m.is_static, m.source_count, m.fsrs_stability
      );
      if (!Number.isFinite(score)) {
        log.warn({ msg: "decay_score_nan_skipped", id: m.id, importance: m.importance });
        continue;
      }
      updateDecay.run(Math.round(score * 1000) / 1000, m.id);
      updated++;

      // Auto-promote to core memory if not already static and meets thresholds
      if (!m.is_static && m.access_count >= PROMOTE_ACCESS_THRESHOLD
          && m.source_count >= PROMOTE_SOURCE_THRESHOLD
          && (m.fsrs_stability || 0) >= PROMOTE_STABILITY_THRESHOLD) {
        promoteToStatic.run(m.id);
        promoted++;
      }
    }
  });
  batch();

  if (promoted > 0) {
    log.info({ msg: "core_memory_auto_promoted", count: promoted });
  }

  return updated;
}

// Tags
export const getByTag = db.prepare(
  `SELECT id, content, category, source, importance, created_at, tags, access_count, episode_id
   FROM memories WHERE tags LIKE ? ESCAPE '\\' AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
   ORDER BY created_at DESC LIMIT ?`
);

export const getAllTags = db.prepare(
  `SELECT DISTINCT tags FROM memories WHERE tags IS NOT NULL AND is_forgotten = 0 AND is_archived = 0 AND user_id = ?`
);

// Inbox / Review queue prepared statements
export const listPending = db.prepare(
  `SELECT id, content, category, source, session_id, importance, created_at, tags, confidence, decay_score, status, model
   FROM memories WHERE status = 'pending' AND is_forgotten = 0 AND user_id = ?
   ORDER BY created_at DESC LIMIT ? OFFSET ?`
);
export const countPending = db.prepare(
  `SELECT COUNT(*) as count FROM memories WHERE status = 'pending' AND is_forgotten = 0 AND user_id = ?`
);
export const approveMemory = db.prepare(
  `UPDATE memories SET status = 'approved', updated_at = datetime('now') WHERE id = ? AND user_id = ?`
);
export const rejectMemory = db.prepare(
  `UPDATE memories SET status = 'rejected', is_archived = 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
);

// Episodes
export const insertEpisode = db.prepare(
  `INSERT INTO episodes (title, session_id, agent, user_id) VALUES (?, ?, ?, ?) RETURNING id, started_at`
);
export const updateEpisode = db.prepare(
  `UPDATE episodes SET title = COALESCE(?, title), summary = COALESCE(?, summary),
   ended_at = COALESCE(?, ended_at), memory_count = (SELECT COUNT(*) FROM memories WHERE episode_id = episodes.id)
   WHERE id = ?`
);
export const updateEpisodeForUser = db.prepare(
  `UPDATE episodes SET title = COALESCE(?, title), summary = COALESCE(?, summary),
   ended_at = COALESCE(?, ended_at), memory_count = (SELECT COUNT(*) FROM memories WHERE episode_id = episodes.id)
   WHERE id = ? AND user_id = ?`
);
export const getEpisode = db.prepare(`SELECT * FROM episodes WHERE id = ?`);
export const getEpisodeBySession = db.prepare(
  `SELECT * FROM episodes WHERE session_id = ? AND agent = ? AND user_id = ? ORDER BY started_at DESC LIMIT 1`
);
export const listEpisodes = db.prepare(
  `SELECT * FROM episodes WHERE user_id = ? ORDER BY started_at DESC LIMIT ?`
);
export const getEpisodeMemories = db.prepare(
  `SELECT id, content, category, source, importance, created_at, tags, access_count
   FROM memories WHERE episode_id = ? AND user_id = ? AND is_forgotten = 0 ORDER BY created_at ASC`
);
export const assignToEpisode = db.prepare(
  `UPDATE memories SET episode_id = ? WHERE id = ?`
);
export const assignToEpisodeForUser = db.prepare(
  `UPDATE memories SET episode_id = ? WHERE id = ? AND user_id = ?`
);

// Episode embedding + search
export const updateEpisodeEmbedding = db.prepare(
  `UPDATE episodes SET embedding = ? WHERE id = ?`
);
export let updateEpisodeVec = db.prepare(
  `UPDATE episodes SET ${VECTOR_COL} = vector(?) WHERE id = ?`
);
export const searchEpisodesFTS = db.prepare(
  `SELECT e.*, rank FROM episodes_fts f JOIN episodes e ON e.id = f.rowid
   WHERE episodes_fts MATCH ? AND e.user_id = ? ORDER BY rank LIMIT ?`
);
export const listEpisodesByTimeRange = db.prepare(
  `SELECT * FROM episodes WHERE user_id = ? AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC LIMIT ?`
);
export const getAllEpisodeEmbeddings = db.prepare(
  `SELECT id, user_id, summary, embedding FROM episodes WHERE embedding IS NOT NULL`
);

// Consolidation queries
export const getClusterCandidates = db.prepare(
  `SELECT source_id, COUNT(*) as link_count FROM memory_links
   JOIN memories m ON memory_links.source_id = m.id
   WHERE m.user_id = ? AND m.is_forgotten = 0 AND m.is_archived = 0 AND m.is_latest = 1
   GROUP BY source_id HAVING link_count >= ?
   ORDER BY link_count DESC LIMIT 10`
);

export const getClusterMembers = db.prepare(
  `SELECT DISTINCT m.id, m.content, m.category, m.importance, m.created_at, m.access_count
   FROM memory_links ml
   JOIN memories center ON center.id = ?
   JOIN memories m ON (ml.target_id = m.id OR ml.source_id = m.id)
   WHERE center.user_id = ? AND (ml.source_id = center.id OR ml.target_id = center.id)
     AND m.user_id = ? AND m.is_forgotten = 0 AND m.is_archived = 0
   ORDER BY m.importance DESC, m.created_at DESC`
);

// Confidence updates
export const updateConfidence = db.prepare(
  `UPDATE memories SET confidence = ?, updated_at = datetime('now') WHERE id = ?`
);

// Webhook queries
export const insertWebhook = db.prepare(
  `INSERT INTO webhooks (url, events, secret, user_id) VALUES (?, ?, ?, ?) RETURNING id, created_at`
);
export const listWebhooks = db.prepare(
  `SELECT id, url, events, active, last_triggered_at, failure_count, created_at
   FROM webhooks WHERE user_id = ? ORDER BY created_at DESC`
);
export const deleteWebhook = db.prepare(`DELETE FROM webhooks WHERE id = ? AND user_id = ?`);
export const getActiveWebhooks = db.prepare(
  `SELECT id, url, events, secret FROM webhooks WHERE active = 1 AND user_id = ?`
);
export const webhookTriggered = db.prepare(
  `UPDATE webhooks SET last_triggered_at = datetime('now') WHERE id = ?`
);
export const webhookFailed = db.prepare(
  `UPDATE webhooks SET failure_count = failure_count + 1,
   active = CASE WHEN failure_count >= 9 THEN 0 ELSE active END WHERE id = ?`
);

// Sync queries
export const getChangesSince = db.prepare(
  `SELECT id, content, category, source, session_id, importance, tags, confidence,
     sync_id, is_static, is_forgotten, is_archived, version, created_at, updated_at
   FROM memories WHERE updated_at > ? AND user_id = ?
   ORDER BY updated_at ASC LIMIT ?`
);
export const getMemoryBySyncId = db.prepare(
  `SELECT id, updated_at FROM memories WHERE sync_id = ? AND user_id = ?`
);

// Entity queries
export const insertEntity = db.prepare(
  `INSERT INTO entities (name, type, description, aka, metadata, user_id)
   VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at`
);
export const getEntity = db.prepare(
  `SELECT e.*, GROUP_CONCAT(DISTINCT me.memory_id) as memory_ids
   FROM entities e LEFT JOIN memory_entities me ON me.entity_id = e.id
   WHERE e.id = ? GROUP BY e.id`
);
export const listEntities = db.prepare(
  `SELECT e.id, e.name, e.type, e.description, e.aka, e.created_at,
     (SELECT COUNT(*) FROM memory_entities WHERE entity_id = e.id) as memory_count
   FROM entities e WHERE e.user_id = ? ORDER BY e.name COLLATE NOCASE`
);
export const listEntitiesByType = db.prepare(
  `SELECT e.id, e.name, e.type, e.description, e.aka, e.created_at,
     (SELECT COUNT(*) FROM memory_entities WHERE entity_id = e.id) as memory_count
   FROM entities e WHERE e.user_id = ? AND e.type = ? ORDER BY e.name COLLATE NOCASE`
);
export const searchEntities = db.prepare(
  `SELECT e.id, e.name, e.type, e.description, e.aka, e.created_at,
     (SELECT COUNT(*) FROM memory_entities WHERE entity_id = e.id) as memory_count
   FROM entities e WHERE e.user_id = ? AND (e.name LIKE ? OR e.aka LIKE ? OR e.description LIKE ?)
   ORDER BY e.name COLLATE NOCASE LIMIT ?`
);
export const updateEntity = db.prepare(
  `UPDATE entities SET name = COALESCE(?, name), type = COALESCE(?, type),
   description = COALESCE(?, description), aka = COALESCE(?, aka),
   metadata = COALESCE(?, metadata), updated_at = datetime('now') WHERE id = ? AND user_id = ?`
);
export const deleteEntity = db.prepare(`DELETE FROM entities WHERE id = ? AND user_id = ?`);
export const linkMemoryEntity = db.prepare(
  `INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)`
);
export const unlinkMemoryEntity = db.prepare(
  `DELETE FROM memory_entities WHERE memory_id = ? AND entity_id = ?`
);
export const getEntityMemories = db.prepare(
  `SELECT m.id, m.content, m.category, m.importance, m.tags, m.created_at, m.decay_score, m.confidence
   FROM memories m JOIN memory_entities me ON me.memory_id = m.id
   WHERE me.entity_id = ? AND m.user_id = ? AND m.is_forgotten = 0 AND m.is_archived = 0
   ORDER BY m.created_at DESC LIMIT ?`
);
export const insertEntityRelationship = db.prepare(
  `INSERT OR IGNORE INTO entity_relationships (source_entity_id, target_entity_id, relationship) VALUES (?, ?, ?)`
);
export const deleteEntityRelationship = db.prepare(
  `DELETE FROM entity_relationships WHERE source_entity_id = ? AND target_entity_id = ? AND relationship = ?`
);
export const getEntityRelationships = db.prepare(
  `SELECT er.id, er.relationship, er.created_at,
     CASE WHEN er.source_entity_id = ? THEN er.target_entity_id ELSE er.source_entity_id END as related_entity_id,
     CASE WHEN er.source_entity_id = ? THEN 'outgoing' ELSE 'incoming' END as direction,
     e.name as related_entity_name, e.type as related_entity_type
   FROM entity_relationships er
   JOIN entities e ON e.id = CASE WHEN er.source_entity_id = ? THEN er.target_entity_id ELSE er.source_entity_id END
   WHERE er.source_entity_id = ? OR er.target_entity_id = ?`
);

// Project queries
export const insertProject = db.prepare(
  `INSERT INTO projects (name, description, status, metadata, user_id)
   VALUES (?, ?, ?, ?, ?) RETURNING id, created_at`
);
export const getProject = db.prepare(
  `SELECT p.*, GROUP_CONCAT(DISTINCT mp.memory_id) as memory_ids
   FROM projects p LEFT JOIN memory_projects mp ON mp.project_id = p.id
   WHERE p.id = ? GROUP BY p.id`
);
export const listProjects = db.prepare(
  `SELECT p.id, p.name, p.description, p.status, p.created_at,
     (SELECT COUNT(*) FROM memory_projects WHERE project_id = p.id) as memory_count
   FROM projects p WHERE p.user_id = ? ORDER BY p.status = 'active' DESC, p.name COLLATE NOCASE`
);
export const listProjectsByStatus = db.prepare(
  `SELECT p.id, p.name, p.description, p.status, p.created_at,
     (SELECT COUNT(*) FROM memory_projects WHERE project_id = p.id) as memory_count
   FROM projects p WHERE p.user_id = ? AND p.status = ? ORDER BY p.name COLLATE NOCASE`
);
export const updateProject = db.prepare(
  `UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description),
   status = COALESCE(?, status), metadata = COALESCE(?, metadata),
   updated_at = datetime('now') WHERE id = ? AND user_id = ?`
);
export const deleteProject = db.prepare(`DELETE FROM projects WHERE id = ? AND user_id = ?`);
export const linkMemoryProject = db.prepare(
  `INSERT OR IGNORE INTO memory_projects (memory_id, project_id) VALUES (?, ?)`
);
export const unlinkMemoryProject = db.prepare(
  `DELETE FROM memory_projects WHERE memory_id = ? AND project_id = ?`
);
export const getProjectMemories = db.prepare(
  `SELECT m.id, m.content, m.category, m.importance, m.tags, m.created_at, m.decay_score, m.confidence
   FROM memories m JOIN memory_projects mp ON mp.memory_id = m.id
   WHERE mp.project_id = ? AND m.user_id = ? AND m.is_forgotten = 0 AND m.is_archived = 0
   ORDER BY m.created_at DESC LIMIT ?`
);

export const getRecentDynamicMemories = db.prepare(
  `SELECT id, content, category, source_count, created_at, model, source
   FROM memories WHERE is_static = 0 AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
   ORDER BY created_at DESC LIMIT ?`
);

function changeCount(result: any): number {
  return Number(result?.rowsAffected ?? result?.changes ?? 0);
}

// TTL-aware upsert: caller passes TTL in minutes (default 30, max 1440 = 24h)
export const upsertScratchEntryWithTTL = db.prepare(
  `INSERT INTO scratchpad (user_id, session, agent, model, entry_key, value, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' minutes'))
   ON CONFLICT(user_id, session, entry_key) DO UPDATE SET
     agent = excluded.agent,
     model = excluded.model,
     value = excluded.value,
     updated_at = datetime('now'),
     expires_at = datetime('now', '+' || ? || ' minutes')`
);

// Legacy compat: 30-min default
export const upsertScratchEntry = db.prepare(
  `INSERT INTO scratchpad (user_id, session, agent, model, entry_key, value, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+30 minutes'))
   ON CONFLICT(user_id, session, entry_key) DO UPDATE SET
     agent = excluded.agent,
     model = excluded.model,
     value = excluded.value,
     updated_at = datetime('now'),
     expires_at = datetime('now', '+30 minutes')`
);

// Get all entries for a session (including expired, for session-end summarization)
export const getScratchSessionAll = db.prepare(
  `SELECT session, agent, model, entry_key, value, created_at, updated_at, expires_at
   FROM scratchpad
   WHERE user_id = ? AND session = ?
   ORDER BY created_at ASC`
);

export const listScratchEntries = db.prepare(
  `SELECT session, agent, model, entry_key, value, created_at, updated_at, expires_at
   FROM scratchpad
   WHERE user_id = ?
     AND expires_at > datetime('now')
     AND (? IS NULL OR agent = ?)
     AND (? IS NULL OR model = ?)
     AND (? IS NULL OR session = ?)
   ORDER BY updated_at DESC, agent, session, entry_key`
);

export const listScratchEntriesForContext = db.prepare(
  `SELECT session, agent, model, entry_key, value, updated_at
   FROM scratchpad
   WHERE user_id = ?
     AND expires_at > datetime('now')
     AND (? IS NULL OR session != ?)
   ORDER BY updated_at DESC, agent, session, entry_key
   LIMIT 20`
);

export const deleteScratchSession = db.prepare(
  `DELETE FROM scratchpad WHERE user_id = ? AND session = ?`
);

export const deleteScratchSessionKey = db.prepare(
  `DELETE FROM scratchpad WHERE user_id = ? AND session = ? AND entry_key = ?`
);

const purgeExpiredScratchEntriesStmt = db.prepare(
  `DELETE FROM scratchpad WHERE expires_at <= datetime('now')`
);

// Fetch expired entries grouped by session before purging (for summarization)
export const getExpiredScratchSessions = db.prepare(
  `SELECT user_id, session, agent, model, entry_key, value, created_at, updated_at
   FROM scratchpad
   WHERE expires_at <= datetime('now')
   ORDER BY user_id, session, created_at ASC`
);

export function purgeExpiredScratchpad(): number {
  return changeCount(purgeExpiredScratchEntriesStmt.run());
}

// Graph data
export const getAllMemoriesForGraph = db.prepare(
  `SELECT id, content, category, importance, is_latest, is_forgotten, is_static,
     is_inference, version, parent_memory_id, root_memory_id, source_count,
     forget_after, created_at, tags, access_count, episode_id, decay_score
   FROM memories WHERE user_id = ? ORDER BY created_at DESC`
);

export const getAllLinksForGraph = db.prepare(
  `SELECT ml.source_id, ml.target_id, ml.similarity, ml.type FROM memory_links ml
   JOIN memories m ON ml.source_id = m.id WHERE m.user_id = ?`
);

// ============================================================================
// PREPARED STATEMENTS - conversations (unchanged)
// ============================================================================

export const insertConversation = db.prepare(
  `INSERT INTO conversations (agent, session_id, title, metadata, user_id) VALUES (?, ?, ?, ?, ?) RETURNING id, started_at`
);
export const updateConversation = db.prepare(
  `UPDATE conversations SET title = COALESCE(?, title), metadata = COALESCE(?, metadata), updated_at = datetime('now') WHERE id = ? AND user_id = ?`
);
export const getConversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`);
export const getConversationForUser = db.prepare(`SELECT * FROM conversations WHERE id = ? AND user_id = ?`);
export const getConversationBySession = db.prepare(
  `SELECT * FROM conversations WHERE agent = ? AND session_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT 1`
);
export const listConversations = db.prepare(
  `SELECT c.id, c.agent, c.session_id, c.title, c.metadata, c.started_at, c.updated_at,
     (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
   FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC LIMIT ?`
);
export const listConversationsByAgent = db.prepare(
  `SELECT c.id, c.agent, c.session_id, c.title, c.metadata, c.started_at, c.updated_at,
     (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
   FROM conversations c WHERE c.user_id = ? AND c.agent = ? ORDER BY c.updated_at DESC LIMIT ?`
);
export const deleteConversation = db.prepare(`DELETE FROM conversations WHERE id = ? AND user_id = ?`);
export const insertMessage = db.prepare(
  `INSERT INTO messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?) RETURNING id, created_at`
);
export const getMessages = db.prepare(
  `SELECT id, role, content, metadata, created_at FROM messages
   WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`
);
export const searchMessages = db.prepare(
  `SELECT m.id, m.conversation_id, m.role, m.content, m.metadata, m.created_at,
     c.agent, c.title as conv_title
   FROM messages_fts f
   JOIN messages m ON f.rowid = m.id
   JOIN conversations c ON m.conversation_id = c.id
   WHERE messages_fts MATCH ? AND c.user_id = ?
   ORDER BY m.created_at DESC
   LIMIT ?`
);
export const touchConversation = db.prepare(
  `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
);

// Transaction-safe inserts (no RETURNING - avoids libsql "statements in progress" bug)
export const insertConversationTx = db.prepare(
  `INSERT INTO conversations (agent, session_id, title, metadata, user_id) VALUES (?, ?, ?, ?, ?)`
);
export const insertMessageTx = db.prepare(
  `INSERT INTO messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?)`
);
const getLastRowId = db.prepare(`SELECT last_insert_rowid() as id`);

export const bulkInsertConvo = db.transaction(
  (agent: string, sessionId: string | null, title: string | null, metadata: string | null, userId: number,
   msgs: Array<{ role: string; content: string; metadata?: string | null }>) => {
    insertConversationTx.run(agent, sessionId, title, metadata, userId);
    const { id } = getLastRowId.get() as { id: number };
    for (const msg of msgs) {
      insertMessageTx.run(id, msg.role, msg.content, msg.metadata || null);
    }
    const conv = getConversation.get(id) as { id: number; started_at: string };
    return conv;
  }
);

// ============================================================================
// AGENT IDENTITY - prepared statements
// ============================================================================

export const insertAgent = db.prepare(
  `INSERT INTO agents (user_id, name, category, description, code_hash) VALUES (?, ?, ?, ?, ?) RETURNING id, trust_score, created_at`
);

export const getAgent = db.prepare(
  `SELECT * FROM agents WHERE id = ? AND user_id = ?`
);

export const getAgentByName = db.prepare(
  `SELECT * FROM agents WHERE name = ? AND user_id = ?`
);

export const listAgents = db.prepare(
  `SELECT id, name, category, description, trust_score, total_ops, successful_ops, failed_ops, guard_allows, guard_warns, guard_blocks, is_active, last_seen_at, created_at FROM agents WHERE user_id = ? ORDER BY created_at DESC`
);

export const updateAgentTrust = db.prepare(
  `UPDATE agents SET trust_score = ?, total_ops = ?, successful_ops = ?, failed_ops = ?, guard_allows = ?, guard_warns = ?, guard_blocks = ?, last_seen_at = datetime('now') WHERE id = ?`
);

export const revokeAgent = db.prepare(
  `UPDATE agents SET is_active = 0, revoked_at = datetime('now'), revoke_reason = ?, trust_score = 0 WHERE id = ? AND user_id = ?`
);

export const getAgentByKeyId = db.prepare(
  `SELECT a.* FROM agents a JOIN api_keys ak ON ak.agent_id = a.id WHERE ak.id = ? AND a.is_active = 1`
);

export const linkKeyToAgent = db.prepare(
  `UPDATE api_keys SET agent_id = ? WHERE id = ? AND user_id = ?`
);

export const getAgentExecutions = db.prepare(
  `SELECT id, action, target_type, target_id, details, execution_hash, signature, created_at FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`
);

// ============================================================================
// USER-SCOPED LOOKUPS
// ============================================================================

export const getEpisodeForUser = db.prepare(`SELECT * FROM episodes WHERE id = ? AND user_id = ?`);

export const getFSRSForUser = db.prepare(
  `SELECT fsrs_stability, fsrs_difficulty, fsrs_storage_strength, fsrs_retrieval_strength,
   fsrs_learning_state, fsrs_reps, fsrs_lapses, fsrs_last_review_at, last_accessed_at, created_at
   FROM memories WHERE id = ? AND user_id = ?`
);

export const getEntityForUser = db.prepare(
  `SELECT e.*, GROUP_CONCAT(DISTINCT me.memory_id) as memory_ids
   FROM entities e LEFT JOIN memory_entities me ON me.entity_id = e.id
   WHERE e.id = ? AND e.user_id = ? GROUP BY e.id`
);

export const getProjectForUser = db.prepare(
  `SELECT p.*, GROUP_CONCAT(DISTINCT mp.memory_id) as memory_ids
   FROM projects p LEFT JOIN memory_projects mp ON mp.project_id = p.id
   WHERE p.id = ? AND p.user_id = ? GROUP BY p.id`
);

// ============================================================================
// PERSONALITY ENGINE - prepared statements
// ============================================================================

export const insertPersonalitySignal = db.prepare(
  `INSERT INTO personality_signals (memory_id, user_id, signal_type, subject, valence, intensity, reasoning, source_text)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

export const getPersonalitySignals = db.prepare(
  `SELECT * FROM personality_signals WHERE user_id = ? ORDER BY created_at DESC`
);

export const getPersonalitySignalCount = db.prepare(
  `SELECT COUNT(*) as count FROM personality_signals WHERE user_id = ?`
);

export const getCachedPersonalityProfile = db.prepare(
  `SELECT * FROM personality_profiles WHERE user_id = ? AND is_stale = 0`
);

export const getAnyPersonalityProfile = db.prepare(
  `SELECT profile, is_stale FROM personality_profiles WHERE user_id = ?`
);

export const upsertPersonalityProfile = db.prepare(
  `INSERT INTO personality_profiles (user_id, profile, signal_count, is_stale, updated_at)
   VALUES (?, ?, ?, 0, datetime('now'))
   ON CONFLICT(user_id) DO UPDATE SET profile = excluded.profile, signal_count = excluded.signal_count, is_stale = 0, updated_at = datetime('now')`
);

export const invalidatePersonalityProfile = db.prepare(
  `UPDATE personality_profiles SET is_stale = 1 WHERE user_id = ?`
);

// ============================================================================
// RATE LIMITS - prepared statements
// ============================================================================

export const upsertRateLimit = db.prepare(`
  INSERT INTO rate_limits (key, count, window_start, window_seconds)
  VALUES (?, 1, datetime('now'), ?)
  ON CONFLICT(key) DO UPDATE SET
    count = CASE
      WHEN datetime(rate_limits.window_start, '+' || rate_limits.window_seconds || ' seconds') < datetime('now')
      THEN 1
      ELSE rate_limits.count + 1
    END,
    window_start = CASE
      WHEN datetime(rate_limits.window_start, '+' || rate_limits.window_seconds || ' seconds') < datetime('now')
      THEN datetime('now')
      ELSE rate_limits.window_start
    END
  RETURNING count, window_start, window_seconds
`);

export const cleanupRateLimits = db.prepare(`
  DELETE FROM rate_limits
  WHERE datetime(window_start, '+' || (window_seconds * 2) || ' seconds') < datetime('now')
`);

// ============================================================================
// TENANT QUOTAS - prepared statements
// ============================================================================

export const getQuota = db.prepare(
  `SELECT * FROM tenant_quotas WHERE user_id = ?`
);

export const upsertQuota = db.prepare(`
  INSERT INTO tenant_quotas (user_id, max_memories, max_conversations, max_api_keys, max_spaces, max_memory_size_bytes, rate_limit_override)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    max_memories = excluded.max_memories,
    max_conversations = excluded.max_conversations,
    max_api_keys = excluded.max_api_keys,
    max_spaces = excluded.max_spaces,
    max_memory_size_bytes = excluded.max_memory_size_bytes,
    rate_limit_override = excluded.rate_limit_override,
    updated_at = datetime('now')
`);

export const getUserMemoryCount = db.prepare(
  `SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_forgotten = 0`
);

// ============================================================================
// USAGE EVENTS - prepared statements
// ============================================================================

export const recordUsage = db.prepare(
  `INSERT INTO usage_events (user_id, event_type, quantity, metadata) VALUES (?, ?, ?, ?)`
);

export const getUsageSummary = db.prepare(`
  SELECT event_type, SUM(quantity) as total, COUNT(*) as event_count
  FROM usage_events
  WHERE user_id = ? AND created_at > ?
  GROUP BY event_type
`);

export const getUsageTimeline = db.prepare(`
  SELECT date(created_at) as day, event_type, SUM(quantity) as total
  FROM usage_events
  WHERE user_id = ? AND created_at > ?
  GROUP BY day, event_type
  ORDER BY day DESC
`);

export const cleanupOldUsage = db.prepare(
  `DELETE FROM usage_events WHERE created_at < datetime('now', '-' || ? || ' days')`
);

// ============================================================================
// SKILLS - prepared statements
// ============================================================================

export const upsertSkill = db.prepare(`
  INSERT INTO skill_records (skill_id, name, description, path, content, category, origin, generation, lineage_change_summary, creator_id, first_seen, last_updated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(skill_id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    path = excluded.path,
    content = excluded.content,
    last_updated = datetime('now')
`);

export const getSkillById = db.prepare(`SELECT * FROM skill_records WHERE skill_id = ?`);
export const getSkillByPath = db.prepare(`SELECT * FROM skill_records WHERE path = ? AND is_active = 1 LIMIT 1`);

export const listSkillsStmt = db.prepare(`
  SELECT skill_id, name, description, path, category, origin, is_active,
    total_selections, total_applied, total_completions, first_seen, last_updated
  FROM skill_records WHERE is_active = 1
  ORDER BY last_updated DESC LIMIT ?
`);

export const searchSkillsFTSStmt = db.prepare(`
  SELECT sr.skill_id, sr.name, sr.description, sr.path, sr.category, sr.origin,
    rank as fts_rank
  FROM skills_fts f
  JOIN skill_records sr ON f.rowid = sr.rowid
  WHERE skills_fts MATCH ? AND sr.is_active = 1
  ORDER BY rank
  LIMIT ?
`);

export const getAllSkillEmbeddingsStmt = db.prepare(`
  SELECT skill_id, name, description, embedding
  FROM skill_records WHERE embedding IS NOT NULL AND is_active = 1
`);

export const updateSkillEmbeddingStmt = db.prepare(
  `UPDATE skill_records SET embedding = ? WHERE skill_id = ?`
);

// writeSkillVec: separate from writeVec (which is integer-keyed for memories)
export function writeSkillVec(skillId: string, emb: Float32Array): void {
  try {
    db.prepare(`UPDATE skill_records SET ${VECTOR_COL} = vector(?) WHERE skill_id = ?`)
      .run(embeddingToVectorJSON(emb), skillId);
  } catch (e: any) {
    log.warn({ msg: "skill_vec_write_failed", skill_id: skillId, error: e?.message });
  }
}

export const updateSkillContentStmt = db.prepare(`
  UPDATE skill_records SET content = ?, name = ?, description = ?, last_updated = datetime('now')
  WHERE skill_id = ?
`);

export const incrementSkillSelectionsStmt = db.prepare(
  `UPDATE skill_records SET total_selections = total_selections + 1 WHERE skill_id = ?`
);

export const softDeleteSkillStmt = db.prepare(
  `UPDATE skill_records SET is_active = 0, last_updated = datetime('now') WHERE skill_id = ?`
);

export const insertSkillTagStmt = db.prepare(
  `INSERT OR IGNORE INTO skill_tags (skill_id, tag) VALUES (?, ?)`
);

export const getSkillTagsStmt = db.prepare(
  `SELECT tag FROM skill_tags WHERE skill_id = ?`
);

export const insertSkillParentStmt = db.prepare(
  `INSERT OR IGNORE INTO skill_lineage_parents (skill_id, parent_skill_id) VALUES (?, ?)`
);

// ============================================================================
// SCHEMA UTILITIES (Phase 6.1)
// ============================================================================

export function getSchemaSnapshot(): Record<string, string> {
  const tables = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as Array<{ name: string; sql: string }>;
  const result: Record<string, string> = {};
  for (const t of tables) {
    result[t.name] = t.sql;
  }
  return result;
}

export function getExpectedTables(): string[] {
  return [
    "memories", "memories_fts", "memory_links", "memory_entities",
    "entities", "entity_relationships", "entity_cooccurrences",
    "episodes", "episodes_fts", "consolidations",
    "conversations", "messages", "messages_fts",
    "projects", "memory_projects", "scratchpad",
    "users", "api_keys", "spaces", "agents",
    "structured_facts", "current_state", "user_preferences",
    "webhooks", "digests", "audit_log",
    "personality_signals", "personality_profiles",
    "causal_chains", "causal_links", "reconsolidations", "temporal_patterns",
    "jobs", "scheduler_leases", "schema_versions",
    "rate_limits", "tenant_quotas",
    "skill_records", "skill_lineage_parents", "skill_tags", "skills_fts",
  ];
}

export function detectSchemaDrift(): { missing: string[]; extra: string[] } {
  const actual = new Set(Object.keys(getSchemaSnapshot()));
  const expected = new Set(getExpectedTables());
  const missing = [...expected].filter(t => !actual.has(t));
  const extra = [...actual].filter(t => !expected.has(t) && !t.endsWith("_fts") && !t.includes("_config") && !t.includes("_content") && !t.includes("_data") && !t.includes("_idx") && !t.includes("_docsize") && t !== "sqlite_sequence");
  return { missing, extra };
}

// ============================================================================
// TIER 4 - prepared statements
// ============================================================================

export const insertCausalChain = db.prepare(
  "INSERT INTO causal_chains (name, user_id) VALUES (?, ?) RETURNING id"
);
export const insertCausalLink = db.prepare(
  "INSERT OR IGNORE INTO causal_links (chain_id, memory_id, position, role) VALUES (?, ?, ?, ?)"
);
export const getCausalChainForMemory = db.prepare(
  `SELECT cc.id, cc.name, cc.created_at,
     GROUP_CONCAT(cl.memory_id || ':' || cl.position || ':' || cl.role, '|') as links
   FROM causal_chains cc
   JOIN causal_links cl ON cl.chain_id = cc.id
   WHERE cc.id IN (SELECT chain_id FROM causal_links WHERE memory_id = ?)
   GROUP BY cc.id ORDER BY cc.created_at DESC`
);
export const getCausalChainMemories = db.prepare(
  `SELECT cl.position, cl.role, m.id, m.content, m.category, m.importance, m.created_at,
     m.valence, m.dominant_emotion
   FROM causal_links cl
   JOIN memories m ON cl.memory_id = m.id
   WHERE cl.chain_id = ?
   ORDER BY cl.position ASC`
);

export const updateValence = db.prepare(
  "UPDATE memories SET valence = ?, arousal = ?, dominant_emotion = ? WHERE id = ?"
);

export const insertReconsolidation = db.prepare(
  "INSERT INTO reconsolidations (memory_id, old_importance, new_importance, old_confidence, new_confidence, reason) VALUES (?, ?, ?, ?, ?, ?)"
);
export const getReconsolidationHistory = db.prepare(
  "SELECT * FROM reconsolidations WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?"
);

export const updateAdaptiveScore = db.prepare(
  "UPDATE memories SET adaptive_score = ?, recall_hits = ?, recall_misses = ? WHERE id = ?"
);
export const getMemoriesForReconsolidation = db.prepare(
  `SELECT id, content, category, importance, confidence, created_at, access_count,
     fsrs_stability, fsrs_retrieval_strength, recall_hits, recall_misses, adaptive_score
   FROM memories
   WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
     AND (
       (adaptive_score IS NOT NULL AND adaptive_score < 0.3)
       OR (access_count > 5 AND recall_misses > recall_hits)
       OR (created_at < datetime('now', '-7 days') AND fsrs_stability IS NOT NULL AND fsrs_stability < 1.0)
     )
   ORDER BY RANDOM() LIMIT ?`
);

export const insertTemporalPattern = db.prepare(
  `INSERT INTO temporal_patterns (user_id, day_of_week, hour_of_day, category, project_id, access_count)
   VALUES (?, ?, ?, ?, ?, 1)
   ON CONFLICT(user_id, day_of_week, hour_of_day, category, project_id)
   DO UPDATE SET access_count = access_count + 1`
);
export const getTemporalPatterns = db.prepare(
  "SELECT * FROM temporal_patterns WHERE user_id = ? ORDER BY access_count DESC LIMIT ?"
);
export const getTemporalPatternsForNow = db.prepare(
  `SELECT tp.category, tp.project_id, tp.access_count, p.name as project_name
   FROM temporal_patterns tp
   LEFT JOIN projects p ON tp.project_id = p.id
   WHERE tp.user_id = ? AND tp.day_of_week = ? AND tp.hour_of_day = ?
   ORDER BY tp.access_count DESC LIMIT ?`
);

// ============================================================================
// PREPARED STATEMENTS - artifacts (v5.12)
// ============================================================================

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
