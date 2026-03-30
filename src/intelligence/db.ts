// ============================================================================
// INTELLIGENCE DOMAIN -- Database prepared statements
// ============================================================================

import { db } from "../db/connection.ts";

// -- Reflections -------------------------------------------------------------

export const getRecentReflection = db.prepare(
  `SELECT id, content, themes, created_at FROM reflections
   WHERE user_id = ? AND period_start >= ? ORDER BY created_at DESC LIMIT 1`
);

export const insertReflection = db.prepare(
  `INSERT INTO reflections (user_id, content, themes, period_start, period_end, memory_count, source_memory_ids)
   VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
);

export const listReflections = db.prepare(
  `SELECT id, content, themes, period_start, period_end, memory_count, created_at
   FROM reflections WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
);

// -- Period memories (for reflection) ----------------------------------------

export const getPeriodMemories = db.prepare(
  `SELECT id, content, category, importance, tags, created_at, is_static, confidence
   FROM memories WHERE created_at >= ? AND created_at <= ? AND is_forgotten = 0 AND user_id = ?
   ORDER BY importance DESC, created_at DESC LIMIT 100`
);

// -- Contradictions ----------------------------------------------------------

export const getKnownContradictions = db.prepare(
  `SELECT ml.source_id, ml.target_id, ml.similarity,
     ms.content as source_content, ms.category as source_category, ms.created_at as source_created,
     mt.content as target_content, mt.category as target_category, mt.created_at as target_created
   FROM memory_links ml
   JOIN memories ms ON ml.source_id = ms.id
   JOIN memories mt ON ml.target_id = mt.id
   WHERE ml.type = 'contradicts' AND ms.user_id = ? AND mt.user_id = ? AND ms.is_forgotten = 0 AND mt.is_forgotten = 0
   ORDER BY ml.created_at DESC LIMIT ?`
);

// -- Consolidations ----------------------------------------------------------

export const listConsolidations = db.prepare(
  `SELECT c.id, c.summary_memory_id, c.source_memory_ids, c.cluster_label, c.created_at,
    m.content as summary_content
    FROM consolidations c JOIN memories m ON c.summary_memory_id = m.id
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC LIMIT 50`
);

// Re-export db for dynamic queries
export { db } from "../db/connection.ts";
