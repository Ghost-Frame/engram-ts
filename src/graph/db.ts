// ============================================================================
// GRAPH DOMAIN -- Database prepared statements (entities, relationships, graph)
// ============================================================================

import { db } from "../db/connection.ts";

// -- Entity CRUD --------------------------------------------------------------

export const insertEntity = db.prepare(
  `INSERT INTO entities (name, type, description, aka, metadata, user_id)
   VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at`
);

export const getEntity = db.prepare(
  `SELECT e.*, GROUP_CONCAT(DISTINCT me.memory_id) as memory_ids
   FROM entities e LEFT JOIN memory_entities me ON me.entity_id = e.id
   WHERE e.id = ? GROUP BY e.id`
);

export const getEntityForUser = db.prepare(
  `SELECT e.*, GROUP_CONCAT(DISTINCT me.memory_id) as memory_ids
   FROM entities e LEFT JOIN memory_entities me ON me.entity_id = e.id
   WHERE e.id = ? AND e.user_id = ? GROUP BY e.id`
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

export const deleteEntity = db.prepare(
  `DELETE FROM entities WHERE id = ? AND user_id = ?`
);

// -- Memory-entity linking ----------------------------------------------------

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

// -- Entity relationships -----------------------------------------------------

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

// -- Graph data ---------------------------------------------------------------

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

// -- Scoped search helper -----------------------------------------------------

export const getEntityMemoryIds = db.prepare(
  `SELECT me.memory_id FROM memory_entities me
   JOIN memories m ON m.id = me.memory_id
   WHERE me.entity_id = ? AND m.user_id = ?`
);

// Re-export db for cases where routes need raw db access (dynamic SQL)
export { db } from "../db/connection.ts";
