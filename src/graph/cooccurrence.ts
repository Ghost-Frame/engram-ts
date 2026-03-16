// ============================================================================
// ENTITY COOCCURRENCE GRAPH
// From Hindsight: entities that appear together in memories build weighted
// relationships. Score = name_similarity*0.2 + cooccurrence_frequency*0.5 +
// temporal_proximity*0.3. Auto-creates entity_relationships at threshold 0.6.
// ============================================================================

import { db } from "../db/index.ts";
import { log } from "../config/logger.ts";

const COOCCURRENCE_THRESHOLD = 0.6;

// ============================================================================
// INCREMENTAL UPDATE (called after memory-entity links are created)
// ============================================================================

// Update cooccurrence scores for all entity pairs linked to a given memory.
// Called incrementally each time a memory gets entity links.
export function updateCooccurrences(memoryId: number, userId: number): number {
  try {
    // Get all entities linked to this memory
    const entities = db.prepare(
      `SELECT e.id, e.name, e.type, e.created_at
       FROM entities e
       JOIN memory_entities me ON me.entity_id = e.id
       WHERE me.memory_id = ? AND e.user_id = ?`
    ).all(memoryId, userId) as Array<{
      id: number; name: string; type: string; created_at: string;
    }>;

    if (entities.length < 2) return 0;

    let updated = 0;

    const upsertCooccurrence = db.prepare(
      `INSERT INTO entity_cooccurrences (entity_a_id, entity_b_id, cooccurrence_count, score, last_memory_id, user_id)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(entity_a_id, entity_b_id, user_id) DO UPDATE SET
         cooccurrence_count = cooccurrence_count + 1,
         score = ?,
         last_memory_id = ?,
         updated_at = datetime('now')`
    );

    // For each pair of entities in this memory
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const a = entities[i];
        const b = entities[j];

        // Normalize ordering: lower ID first
        const [eA, eB] = a.id < b.id ? [a, b] : [b, a];

        // Calculate score components
        const nameSim = nameSimilarity(eA.name, eB.name);
        const sharedMemories = getSharedMemoryCount(eA.id, eB.id);
        const coocFreq = Math.min(sharedMemories / 10, 1.0); // normalize: 10+ cooccurrences = max
        const tempProx = temporalProximity(eA.created_at, eB.created_at);

        // Weighted score (adapted from Hindsight)
        const score = nameSim * 0.2 + coocFreq * 0.5 + tempProx * 0.3;

        upsertCooccurrence.run(eA.id, eB.id, score, memoryId, userId, score, memoryId);
        updated++;

        // Auto-create entity relationship if score exceeds threshold
        if (score >= COOCCURRENCE_THRESHOLD) {
          autoCreateRelationship(eA.id, eB.id, score);
        }
      }
    }

    return updated;
  } catch (e: any) {
    log.warn({ msg: "cooccurrence_update_failed", memoryId, error: e.message });
    return 0;
  }
}

// ============================================================================
// SCORE COMPONENTS
// ============================================================================

// Jaccard-like character bigram similarity between entity names
function nameSimilarity(a: string, b: string): number {
  const bigramsA = getBigrams(a.toLowerCase());
  const bigramsB = getBigrams(b.toLowerCase());
  if (bigramsA.size === 0 && bigramsB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  const union = bigramsA.size + bigramsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function getBigrams(s: string): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    bigrams.add(s.slice(i, i + 2));
  }
  return bigrams;
}

// Count memories that contain both entities
function getSharedMemoryCount(entityAId: number, entityBId: number): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM memory_entities a
       JOIN memory_entities b ON a.memory_id = b.memory_id
       WHERE a.entity_id = ? AND b.entity_id = ?`
    ).get(entityAId, entityBId) as { count: number };
    return row.count;
  } catch {
    return 0;
  }
}

// Temporal proximity: how close in time the entities were created/first seen
// Returns 1.0 for same day, decays exponentially with days apart
function temporalProximity(dateA: string, dateB: string): number {
  try {
    const a = new Date(dateA).getTime();
    const b = new Date(dateB).getTime();
    if (isNaN(a) || isNaN(b)) return 0.5;
    const daysDiff = Math.abs(a - b) / (1000 * 60 * 60 * 24);
    return Math.exp(-daysDiff / 30); // half-life of ~21 days
  } catch {
    return 0.5;
  }
}

// ============================================================================
// AUTO-RELATIONSHIP CREATION
// ============================================================================

function autoCreateRelationship(entityAId: number, entityBId: number, score: number): void {
  try {
    // Only create if no relationship exists yet
    const existing = db.prepare(
      `SELECT id FROM entity_relationships
       WHERE (source_entity_id = ? AND target_entity_id = ?)
          OR (source_entity_id = ? AND target_entity_id = ?)
       LIMIT 1`
    ).get(entityAId, entityBId, entityBId, entityAId);

    if (!existing) {
      db.prepare(
        `INSERT OR IGNORE INTO entity_relationships (source_entity_id, target_entity_id, relationship)
         VALUES (?, ?, ?)`
      ).run(entityAId, entityBId, "cooccurs_with");
      log.debug({ msg: "auto_relationship_created", entityA: entityAId, entityB: entityBId, score });
    }
  } catch {
    // Ignore - relationship may already exist with different type
  }
}

// ============================================================================
// FULL REBUILD (maintenance sweep)
// ============================================================================

// Rebuild all cooccurrence scores for a user from scratch.
// Useful after bulk imports or maintenance.
export function rebuildCooccurrences(userId: number): number {
  try {
    // Get all memories with 2+ entities
    const memories = db.prepare(
      `SELECT me.memory_id, GROUP_CONCAT(me.entity_id) as entity_ids
       FROM memory_entities me
       JOIN entities e ON e.id = me.entity_id
       WHERE e.user_id = ?
       GROUP BY me.memory_id
       HAVING COUNT(*) >= 2`
    ).all(userId) as Array<{ memory_id: number; entity_ids: string }>;

    // Clear existing cooccurrences for this user
    db.prepare("DELETE FROM entity_cooccurrences WHERE user_id = ?").run(userId);

    let total = 0;
    for (const m of memories) {
      total += updateCooccurrences(m.memory_id, userId);
    }

    log.info({ msg: "cooccurrences_rebuilt", userId, memories: memories.length, pairs: total });
    return total;
  } catch (e: any) {
    log.warn({ msg: "cooccurrence_rebuild_failed", error: e.message });
    return 0;
  }
}

// Get top cooccurring entities for a given entity
export function getCooccurringEntities(
  entityId: number,
  userId: number,
  limit: number = 10
): Array<{ entity_id: number; name: string; type: string; score: number; count: number }> {
  try {
    return db.prepare(
      `SELECT
         CASE WHEN ec.entity_a_id = ? THEN ec.entity_b_id ELSE ec.entity_a_id END as entity_id,
         e.name, e.type, ec.score, ec.cooccurrence_count as count
       FROM entity_cooccurrences ec
       JOIN entities e ON e.id = CASE WHEN ec.entity_a_id = ? THEN ec.entity_b_id ELSE ec.entity_a_id END
       WHERE (ec.entity_a_id = ? OR ec.entity_b_id = ?) AND ec.user_id = ?
       ORDER BY ec.score DESC
       LIMIT ?`
    ).all(entityId, entityId, entityId, entityId, userId, limit) as Array<{
      entity_id: number; name: string; type: string; score: number; count: number;
    }>;
  } catch (e: any) {
    log.warn({ msg: "get_cooccurrences_failed", error: e.message });
    return [];
  }
}
