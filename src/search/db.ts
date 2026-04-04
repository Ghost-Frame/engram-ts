// ============================================================================
// SEARCH DOMAIN - Database prepared statements
// ============================================================================

import { db } from "../db/connection.ts";

// Re-export FSRS/decay functions from the main db module (not duplicated)
export { trackAccessWithFSRS, updateDecayScores } from "../db/index.ts";

// -- Static memories (for recall layer 1) -----------------------------------

export const getStaticMemories = db.prepare(
  `SELECT id, content, category, source_count, created_at, updated_at, model, source
   FROM memories WHERE is_static = 1 AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND status = 'approved' AND user_id = ?
   ORDER BY source_count DESC, updated_at DESC`
);

// - Recent important (for recall layer 3: high-importance weighted by decay) -

export const getRecentImportant = db.prepare(
  `SELECT id, content, category, source, importance, created_at, source_count, is_static,
     access_count, last_accessed_at, decay_score, tags, episode_id
   FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
   ORDER BY COALESCE(decay_score, importance) DESC, created_at DESC LIMIT ?`
);

// -- Recent activity (for recall layer 4) -----------------------------------

export const listRecent = db.prepare(
  `SELECT id, content, category, source, session_id, importance, created_at,
     version, is_latest, parent_memory_id, root_memory_id, source_count,
     is_static, is_forgotten, is_inference, forget_after, is_archived, status, model
   FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND status != 'pending' AND user_id = ?
   ORDER BY created_at DESC LIMIT ?`
);

// -- Memory without embedding (for tag/episode filtering) -------------------

export const getMemoryWithoutEmbedding = db.prepare(
  `SELECT id, content, category, source, session_id, importance, created_at, updated_at,
     version, is_latest, parent_memory_id, root_memory_id, source_count,
     is_static, is_forgotten, forget_after, forget_reason, is_inference, is_archived, status, model,
     tags, episode_id, access_count, last_accessed_at, confidence, decay_score, space_id,
     fsrs_stability, fsrs_difficulty, source_count, user_id
   FROM memories WHERE id = ?`
);

// -- Episode lookups --------------------------------------------------------

export const getEpisode = db.prepare(`SELECT * FROM episodes WHERE id = ?`);

export const getEpisodeForUser = db.prepare(`SELECT * FROM episodes WHERE id = ? AND user_id = ?`);

// -- Decay scores query -----------------------------------------------------

export function getDecayScoreRows(userId: number, limit: number, order: "ASC" | "DESC"): any[] {
  return db.prepare(
    `SELECT id, content, category, importance, decay_score, access_count, last_accessed_at,
       created_at, is_static, source_count, confidence,
       fsrs_stability, fsrs_difficulty, fsrs_storage_strength, fsrs_retrieval_strength,
       fsrs_learning_state, fsrs_reps, fsrs_lapses, fsrs_last_review_at
     FROM memories WHERE user_id = ? AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1
     ORDER BY COALESCE(decay_score, importance) ${order} LIMIT ?`
  ).all(userId, limit) as any[];
}

// -- Working memory (scratchpad for recall) ---------------------------------

export const listScratchEntriesForContext = db.prepare(
  `SELECT session, agent, model, entry_key, value, updated_at
   FROM scratchpad
   WHERE user_id = ?
     AND expires_at > datetime('now')
     AND (? IS NULL OR session != ?)
   ORDER BY updated_at DESC, agent, session, entry_key
   LIMIT 20`
);

// Re-export db for inline queries in routes
export { db } from "../db/connection.ts";
