// ============================================================================
// EPISODES DOMAIN - Database prepared statements
// ============================================================================

import { db, embeddingToVectorJSON, VECTOR_COL } from "../db/connection.ts";

// -- Core CRUD ---------------------------------------------------------------

export const insertEpisode = db.prepare(
  `INSERT INTO episodes (title, session_id, agent, user_id) VALUES (?, ?, ?, ?) RETURNING id, started_at`
);

export const getEpisode = db.prepare(`SELECT * FROM episodes WHERE id = ?`);

export const getEpisodeForUser = db.prepare(
  `SELECT * FROM episodes WHERE id = ? AND user_id = ?`
);

export const getEpisodeBySession = db.prepare(
  `SELECT * FROM episodes WHERE session_id = ? AND agent = ? AND user_id = ? ORDER BY started_at DESC LIMIT 1`
);

export const listEpisodes = db.prepare(
  `SELECT * FROM episodes WHERE user_id = ? ORDER BY started_at DESC LIMIT ?`
);

export const listEpisodesByTimeRange = db.prepare(
  `SELECT * FROM episodes WHERE user_id = ? AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC LIMIT ?`
);

// -- Update ------------------------------------------------------------------

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

/** Update duration_seconds for a given episode */
export function updateDurationSeconds(episodeId: number, seconds: number): void {
  db.prepare("UPDATE episodes SET duration_seconds = ? WHERE id = ?").run(seconds, episodeId);
}

// -- Memory assignment -------------------------------------------------------

export const assignToEpisode = db.prepare(
  `UPDATE memories SET episode_id = ? WHERE id = ?`
);

export const assignToEpisodeForUser = db.prepare(
  `UPDATE memories SET episode_id = ? WHERE id = ? AND user_id = ?`
);

export const getEpisodeMemories = db.prepare(
  `SELECT id, content, category, source, importance, created_at, tags, access_count
   FROM memories WHERE episode_id = ? AND user_id = ? AND is_forgotten = 0 ORDER BY created_at ASC`
);

// -- Embedding + search ------------------------------------------------------

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

export const getAllEpisodeEmbeddings = db.prepare(
  `SELECT id, user_id, summary, embedding FROM episodes WHERE embedding IS NOT NULL`
);

// Re-export db for cases where routes need raw db access
export { db } from "../db/connection.ts";
