// ============================================================================
// MEMORY DOMAIN - Database prepared statements
// ============================================================================

import { db } from "../db/connection.ts";

// -- Core CRUD ---------------------------------------------------------------

export const insertMemoryStmt = db.prepare(
  `INSERT INTO memories (content, category, source, session_id, importance, embedding,
    version, is_latest, parent_memory_id, root_memory_id, source_count, is_static,
    is_forgotten, forget_after, forget_reason, is_inference, model, user_id, space_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   RETURNING id, created_at`
);

export function getMemoryById(id: number): any {
  return db.prepare(
    `SELECT id, user_id, content, category, source, session_id, importance, created_at, updated_at,
       version, is_latest, parent_memory_id, root_memory_id, source_count,
       is_static, is_forgotten, forget_after, forget_reason, is_inference, is_archived, status, model,
       tags, episode_id, access_count, last_accessed_at, confidence, space_id,
       decay_score, fsrs_stability, fsrs_difficulty
     FROM memories WHERE id = ?`
  ).get(id);
}

export function listRecentMemories(userId: number, limit: number): any[] {
  return db.prepare(
    `SELECT id, content, category, source, session_id, importance, created_at,
       version, is_latest, parent_memory_id, root_memory_id, source_count,
       is_static, is_forgotten, is_inference, forget_after, is_archived, status, model
     FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND status != 'pending' AND user_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(userId, limit);
}

export function listByCategoryMemories(category: string, userId: number, limit: number): any[] {
  return db.prepare(
    `SELECT id, content, category, source, session_id, importance, created_at,
       version, is_latest, parent_memory_id, root_memory_id, source_count,
       is_static, is_forgotten, is_inference, forget_after, is_archived, status, model
     FROM memories WHERE category = ? AND is_forgotten = 0 AND is_archived = 0 AND status != 'pending' AND user_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(category, userId, limit);
}

export function listBySourceMemories(source: string, userId: number, category: string | null, limit: number): any[] {
  if (category) {
    return db.prepare(
      `SELECT id, content, category, source, session_id, importance, created_at,
         version, is_latest, parent_memory_id, root_memory_id, source_count,
         is_static, is_forgotten, is_inference, forget_after, is_archived, status, model
       FROM memories WHERE source = ? AND is_forgotten = 0 AND is_archived = 0 AND status != 'pending' AND user_id = ?
         AND category = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(source, userId, category, limit);
  }
  return db.prepare(
    `SELECT id, content, category, source, session_id, importance, created_at,
       version, is_latest, parent_memory_id, root_memory_id, source_count,
       is_static, is_forgotten, is_inference, forget_after, is_archived, status, model
     FROM memories WHERE source = ? AND is_forgotten = 0 AND is_archived = 0 AND status != 'pending' AND user_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(source, userId, limit);
}

const nullifyParentRefs = db.prepare(`UPDATE memories SET parent_memory_id = NULL WHERE parent_memory_id = ?`);
const nullifyRootRefs = db.prepare(`UPDATE memories SET root_memory_id = NULL WHERE root_memory_id = ?`);

export const deleteMemoryById = db.transaction((id: number) => {
  nullifyParentRefs.run(id);
  nullifyRootRefs.run(id);
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
});

// -- State mutations ---------------------------------------------------------

export const markMemoryForgotten = db.prepare(
  `UPDATE memories SET is_forgotten = 1, updated_at = datetime('now') WHERE id = ?`
);

export const markMemoryArchived = db.prepare(
  `UPDATE memories SET is_archived = 1, updated_at = datetime('now') WHERE id = ?`
);

export const markMemoryUnarchived = db.prepare(
  `UPDATE memories SET is_archived = 0, updated_at = datetime('now') WHERE id = ?`
);

export const markMemorySuperseded = db.prepare(
  `UPDATE memories SET is_latest = 0, updated_at = datetime('now') WHERE id = ?`
);

export function updateMemoryForgetReason(id: number, reason: string): void {
  db.prepare("UPDATE memories SET forget_reason = ? WHERE id = ?").run(reason, id);
}

// -- Quota -------------------------------------------------------------------

export function getQuotaForUser(userId: number): any {
  return db.prepare(`SELECT * FROM tenant_quotas WHERE user_id = ?`).get(userId);
}

export function getUserMemoryCount(userId: number): number {
  return (db.prepare(`SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_forgotten = 0`).get(userId) as { count: number }).count;
}

export function countNoEmbeddingForUser(userId: number): number {
  return (db.prepare(`SELECT COUNT(*) as count FROM memories WHERE embedding IS NULL AND user_id = ?`).get(userId) as { count: number }).count;
}

// -- Usage tracking ----------------------------------------------------------

export const recordUsageEvent = db.prepare(
  `INSERT INTO usage_events (user_id, event_type, quantity, metadata) VALUES (?, ?, ?, ?)`
);

// -- Tags --------------------------------------------------------------------

export function getAllTagsForUser(userId: number): Array<{ tags: string }> {
  return db.prepare(
    `SELECT DISTINCT tags FROM memories WHERE tags IS NOT NULL AND is_forgotten = 0 AND is_archived = 0 AND user_id = ?`
  ).all(userId) as Array<{ tags: string }>;
}

export function getByTagForUser(tagPattern: string, userId: number, limit: number): any[] {
  return db.prepare(
    "SELECT id, content, category, source, importance, created_at, tags, access_count, episode_id FROM memories WHERE tags LIKE ? ESCAPE '\\' AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(tagPattern, userId, limit);
}

export function updateMemoryTags(id: number, tagsJson: string): void {
  db.prepare("UPDATE memories SET tags = ?, updated_at = datetime('now') WHERE id = ?").run(tagsJson, id);
}

// -- Version chain and links -------------------------------------------------

export function getVersionChainForUser(rootId: number, userId: number): any[] {
  return db.prepare(
    `SELECT id, content, category, version, is_latest, created_at, source_count
     FROM memories WHERE (root_memory_id = ? OR id = ?) AND user_id = ?
     ORDER BY version ASC`
  ).all(rootId, rootId, userId);
}

export function getLinksForMemory(id: number, userId: number): any[] {
  return db.prepare(
    `SELECT ml.target_id as id, ml.similarity, ml.type, m.content, m.category, m.importance, m.created_at,
       m.is_latest, m.is_forgotten, m.version, m.source_count, m.model, m.source
     FROM memory_links ml
     JOIN memories m ON m.id = ml.target_id
     WHERE ml.source_id = ? AND m.user_id = ?
     UNION
     SELECT ml.source_id as id, ml.similarity, ml.type, m.content, m.category, m.importance, m.created_at,
       m.is_latest, m.is_forgotten, m.version, m.source_count, m.model, m.source
     FROM memory_links ml
     JOIN memories m ON m.id = ml.source_id
     WHERE ml.target_id = ? AND m.user_id = ?`
  ).all(id, userId, id, userId);
}

export const insertMemoryLink = db.prepare(
  `INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, type) VALUES (?, ?, ?, ?)`
);

// -- Post-insert field patches -----------------------------------------------

export function updatePostInsertFields(
  id: number, tagsJson: string | null, episodeId: number | null, syncId: string, status: string,
): void {
  db.prepare(
    "UPDATE memories SET tags = ?, episode_id = ?, sync_id = ?, confidence = 1.0, status = ? WHERE id = ?"
  ).run(tagsJson, episodeId, syncId, status, id);
}

export function updateVersionChain(id: number, version: number, rootId: number, parentId: number): void {
  db.prepare(`UPDATE memories SET version = ?, root_memory_id = ?, parent_memory_id = ? WHERE id = ?`).run(version, rootId, parentId, id);
}

export function updateDecayAndFSRS(
  id: number, decayScore: number,
  fsrs: { stability: number; difficulty: number; storage_strength: number;
    retrieval_strength: number; learning_state: number; reps: number;
    lapses: number; last_review_at: string | null; },
): void {
  db.prepare(
    `UPDATE memories SET decay_score = ?, fsrs_stability = ?, fsrs_difficulty = ?,
     fsrs_storage_strength = ?, fsrs_retrieval_strength = ?, fsrs_learning_state = ?,
     fsrs_reps = ?, fsrs_lapses = ?, fsrs_last_review_at = ? WHERE id = ?`
  ).run(
    Math.round(decayScore * 1000) / 1000,
    fsrs.stability, fsrs.difficulty, fsrs.storage_strength,
    fsrs.retrieval_strength, fsrs.learning_state, fsrs.reps, fsrs.lapses,
    fsrs.last_review_at, id,
  );
}

export function updateMemorySourceCount(id: number, sourceCount: number): void {
  db.prepare("UPDATE memories SET source_count = ?, updated_at = datetime('now') WHERE id = ?").run(sourceCount, id);
}

export function updateExistingVersionFields(id: number, tags: string | null, episodeId: number | null, confidence: number): void {
  db.prepare("UPDATE memories SET tags = ?, episode_id = ?, confidence = ? WHERE id = ?")
    .run(tags, episodeId, confidence, id);
}

export function updateCorrectionTags(id: number, tagsJson: string): void {
  db.prepare("UPDATE memories SET tags = ?, status = 'approved' WHERE id = ?").run(tagsJson, id);
}

// -- Feedback ----------------------------------------------------------------

export function ensureFeedbackTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      memory_id INTEGER NOT NULL,
      signal TEXT NOT NULL CHECK(signal IN ('used', 'ignored', 'corrected', 'irrelevant', 'helpful')),
      context TEXT,
      agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (memory_id) REFERENCES memories(id)
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_user ON retrieval_feedback(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_memory ON retrieval_feedback(memory_id, signal);
  `);
}

export function insertFeedbackBatch(userId: number, items: Array<{ query: string; memory_id: number; signal: string; context?: string; agent?: string }>): void {
  const stmt = db.prepare(
    "INSERT INTO retrieval_feedback (user_id, query, memory_id, signal, context, agent) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const batch = db.transaction(() => {
    for (const fb of items) {
      stmt.run(userId, fb.query, fb.memory_id, fb.signal, fb.context || null, fb.agent || null);
    }
  });
  batch();
}

export function adjustImportance(memoryId: number, userId: number, delta: number): void {
  if (delta > 0) {
    db.prepare("UPDATE memories SET importance = MIN(importance + ?, 10) WHERE id = ? AND user_id = ?").run(delta, memoryId, userId);
  } else {
    db.prepare("UPDATE memories SET importance = MAX(importance + ?, 0) WHERE id = ? AND user_id = ?").run(delta, memoryId, userId);
  }
}

export function getFeedbackSignalCounts(userId: number, sinceDate: string): any[] {
  return db.prepare(
    `SELECT signal, COUNT(*) as count FROM retrieval_feedback
     WHERE user_id = ? AND created_at >= ? GROUP BY signal ORDER BY count DESC`
  ).all(userId, sinceDate);
}

export function getTopIrrelevant(userId: number, sinceDate: string): any[] {
  return db.prepare(
    `SELECT memory_id, COUNT(*) as count FROM retrieval_feedback
     WHERE user_id = ? AND signal = 'irrelevant' AND created_at >= ?
     GROUP BY memory_id ORDER BY count DESC LIMIT 10`
  ).all(userId, sinceDate);
}

export function getTopHelpful(userId: number, sinceDate: string): any[] {
  return db.prepare(
    `SELECT memory_id, COUNT(*) as count FROM retrieval_feedback
     WHERE user_id = ? AND signal = 'helpful' AND created_at >= ?
     GROUP BY memory_id ORDER BY count DESC LIMIT 10`
  ).all(userId, sinceDate);
}

// -- Memory health -----------------------------------------------------------

export function getStaleMemories(userId: number, staleDays: number, limit: number): any[] {
  return db.prepare(
    `SELECT id, content, category, importance, created_at, source_count,
            access_count, decay_score
     FROM memories
     WHERE user_id = ? AND is_forgotten = 0 AND is_static = 0 AND is_archived = 0
       AND importance >= 6
       AND created_at < datetime('now', '-' || ? || ' days')
       AND (access_count IS NULL OR access_count < 2)
     ORDER BY importance DESC, created_at ASC
     LIMIT ?`
  ).all(userId, staleDays, limit);
}

export function getUnlinkedHighValue(userId: number, limit: number): any[] {
  return db.prepare(
    `SELECT m.id, m.content, m.category, m.importance, m.created_at
     FROM memories m
     WHERE m.user_id = ? AND m.is_forgotten = 0 AND m.importance >= 7
       AND NOT EXISTS (
         SELECT 1 FROM memory_links ml
         WHERE ml.source_id = m.id OR ml.target_id = m.id
       )
     ORDER BY m.importance DESC
     LIMIT ?`
  ).all(userId, limit);
}

export function getContradictionHints(userId: number, limit: number): any[] {
  return db.prepare(
    `SELECT m.id, m.content, m.category, m.created_at
     FROM memories m
     WHERE m.user_id = ? AND m.is_forgotten = 0
       AND (m.content LIKE '%no longer%' OR m.content LIKE '%changed to%'
         OR m.content LIKE '%used to%' OR m.content LIKE '%instead now%'
         OR m.content LIKE '%but now%' OR m.content LIKE '%previously%')
     ORDER BY m.created_at DESC
     LIMIT ?`
  ).all(userId, limit);
}

// Re-export db for cases where routes need raw db access (e.g., inline queries)
export { db } from "../db/connection.ts";
