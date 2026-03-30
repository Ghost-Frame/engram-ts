// ============================================================================
// INBOX DOMAIN -- Database prepared statements
// ============================================================================

import { db } from "../db/connection.ts";

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

export const getMemoryWithoutEmbedding = db.prepare(
  `SELECT id, user_id, content, category, source, session_id, importance, created_at, updated_at,
     version, is_latest, parent_memory_id, root_memory_id, source_count,
     is_static, is_forgotten, forget_after, forget_reason, is_inference, is_archived, status, model,
     tags, episode_id, access_count, last_accessed_at, confidence
   FROM memories WHERE id = ?`
);
