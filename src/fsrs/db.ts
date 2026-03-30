// ============================================================================
// FSRS DOMAIN -- Database prepared statements
// ============================================================================

import { db } from "../db/connection.ts";

// -- FSRS state fetch (with user ownership check) ----------------------------

export const getFSRSForUser = db.prepare(
  `SELECT fsrs_stability, fsrs_difficulty, fsrs_storage_strength, fsrs_retrieval_strength,
   fsrs_learning_state, fsrs_reps, fsrs_lapses, fsrs_last_review_at, last_accessed_at, created_at
   FROM memories WHERE id = ? AND user_id = ?`
);

// -- FSRS state update -------------------------------------------------------

export const updateFSRS = db.prepare(
  `UPDATE memories SET fsrs_stability = ?, fsrs_difficulty = ?, fsrs_storage_strength = ?,
   fsrs_retrieval_strength = ?, fsrs_learning_state = ?, fsrs_reps = ?, fsrs_lapses = ?,
   fsrs_last_review_at = ? WHERE id = ?`
);

// -- Memory lookup (no embedding -- used for ownership check) ----------------

export const getMemoryWithoutEmbedding = db.prepare(
  `SELECT id, user_id, content, category, source, session_id, importance, created_at, updated_at,
     version, is_latest, parent_memory_id, root_memory_id, source_count,
     is_static, is_forgotten, forget_after, forget_reason, is_inference, is_archived, status, model,
     tags, episode_id, access_count, last_accessed_at, confidence, space_id,
     decay_score, fsrs_stability, fsrs_difficulty, fsrs_learning_state, fsrs_reps, fsrs_lapses
   FROM memories WHERE id = ?`
);

// -- Uninitialized memories (for /fsrs/init backfill) ------------------------

export function getUninitializedFSRS(userId: number): Array<{ id: number; created_at: string }> {
  return db.prepare(
    `SELECT id, created_at FROM memories WHERE user_id = ? AND fsrs_stability IS NULL AND is_forgotten = 0 AND is_latest = 1`
  ).all(userId) as any[];
}

// Re-export db for transaction support
export { db } from "../db/connection.ts";
