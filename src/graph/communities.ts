// ============================================================================
// COMMUNITY DETECTION via Label Propagation
// From Graphiti/Zep: detect memory clusters using iterative label propagation
// on the memory_links graph. Each memory starts with its own label; in each
// iteration, it adopts the most common label among its neighbors (weighted by
// link similarity). Converges in ~5-10 iterations for typical graphs.
// ============================================================================

import { db } from "../db/index.ts";
import { log } from "../config/logger.ts";

// Ensure community_id column exists on memories
let communityColumnExists: boolean | null = null;

function ensureCommunityColumn(): boolean {
  if (communityColumnExists === true) return true;
  if (communityColumnExists === false) return false;
  try {
    const row = db.prepare(
      "SELECT 1 FROM pragma_table_info('memories') WHERE name = 'community_id'"
    ).get();
    if (row) {
      communityColumnExists = true;
      return true;
    }
    db.exec("ALTER TABLE memories ADD COLUMN community_id INTEGER DEFAULT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_community ON memories(community_id) WHERE community_id IS NOT NULL");
    communityColumnExists = true;
    log.info({ msg: "community_id_column_added" });
    return true;
  } catch (e: any) {
    log.warn({ msg: "community_column_check_failed", error: e.message });
    communityColumnExists = false;
    return false;
  }
}

interface MemoryNode {
  id: number;
  label: number;
}

interface MemoryEdge {
  source_id: number;
  target_id: number;
  similarity: number;
  type: string;
}

// Type-aware edge weights (same as search.ts)
function edgeWeight(type: string, similarity: number): number {
  const typeWeight = type === "caused_by" || type === "causes" ? 2.0
    : type === "updates" || type === "corrects" ? 1.5
      : type === "extends" || type === "contradicts" ? 1.3
        : type === "consolidates" ? 0.5
          : 1.0;
  return similarity * typeWeight;
}

// Run label propagation community detection for a user's memory graph.
// Returns the number of communities detected.
export function detectCommunities(
  userId: number,
  maxIterations: number = 15
): { communities: number; memories: number } {
  if (!ensureCommunityColumn()) return { communities: 0, memories: 0 };

  try {
    // Load all active memories
    const memories = db.prepare(
      `SELECT id FROM memories
       WHERE user_id = ? AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1`
    ).all(userId) as Array<{ id: number }>;

    if (memories.length === 0) return { communities: 0, memories: 0 };

    // Load all edges
    const edges = db.prepare(
      `SELECT ml.source_id, ml.target_id, ml.similarity, ml.type
       FROM memory_links ml
       JOIN memories ms ON ms.id = ml.source_id
       JOIN memories mt ON mt.id = ml.target_id
       WHERE ms.user_id = ? AND mt.user_id = ?
         AND ms.is_forgotten = 0 AND mt.is_forgotten = 0
         AND ms.is_archived = 0 AND mt.is_archived = 0`
    ).all(userId, userId) as MemoryEdge[];

    // Build adjacency list
    const neighbors = new Map<number, Array<{ id: number; weight: number }>>();
    for (const m of memories) {
      neighbors.set(m.id, []);
    }
    for (const e of edges) {
      const w = edgeWeight(e.type, e.similarity);
      neighbors.get(e.source_id)?.push({ id: e.target_id, weight: w });
      neighbors.get(e.target_id)?.push({ id: e.source_id, weight: w });
    }

    // Initialize: each node gets its own label
    const labels = new Map<number, number>();
    for (const m of memories) {
      labels.set(m.id, m.id);
    }

    // Iterative label propagation
    const nodeIds = memories.map(m => m.id);
    for (let iter = 0; iter < maxIterations; iter++) {
      let changed = 0;

      // Shuffle node order for randomization (Fisher-Yates)
      for (let i = nodeIds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [nodeIds[i], nodeIds[j]] = [nodeIds[j], nodeIds[i]];
      }

      for (const nodeId of nodeIds) {
        const nbrs = neighbors.get(nodeId);
        if (!nbrs || nbrs.length === 0) continue;

        // Weighted vote: sum weights for each neighbor label
        const labelWeights = new Map<number, number>();
        for (const nbr of nbrs) {
          const nbrLabel = labels.get(nbr.id);
          if (nbrLabel != null) {
            labelWeights.set(nbrLabel, (labelWeights.get(nbrLabel) || 0) + nbr.weight);
          }
        }

        // Pick the label with highest total weight
        let bestLabel = labels.get(nodeId)!;
        let bestWeight = -1;
        for (const [label, weight] of labelWeights) {
          if (weight > bestWeight) {
            bestWeight = weight;
            bestLabel = label;
          }
        }

        if (bestLabel !== labels.get(nodeId)) {
          labels.set(nodeId, bestLabel);
          changed++;
        }
      }

      // Convergence check
      if (changed === 0) {
        log.debug({ msg: "label_propagation_converged", iterations: iter + 1 });
        break;
      }
    }

    // Normalize labels to consecutive IDs
    const labelMap = new Map<number, number>();
    let nextCommunity = 0;
    for (const [, label] of labels) {
      if (!labelMap.has(label)) {
        labelMap.set(label, nextCommunity++);
      }
    }

    // Write community IDs to database
    const updateCommunity = db.prepare("UPDATE memories SET community_id = ? WHERE id = ?");
    const batch = db.transaction(() => {
      for (const [nodeId, label] of labels) {
        const communityId = labelMap.get(label)!;
        updateCommunity.run(communityId, nodeId);
      }
    });
    batch();

    // Count community sizes
    const communitySizes = new Map<number, number>();
    for (const [, label] of labels) {
      const cid = labelMap.get(label)!;
      communitySizes.set(cid, (communitySizes.get(cid) || 0) + 1);
    }

    const communities = communitySizes.size;
    log.info({
      msg: "communities_detected",
      communities,
      memories: memories.length,
      largest: Math.max(...communitySizes.values()),
      isolated: [...communitySizes.values()].filter(s => s === 1).length,
    });

    return { communities, memories: memories.length };
  } catch (e: any) {
    log.warn({ msg: "community_detection_failed", error: e.message });
    return { communities: 0, memories: 0 };
  }
}

// Get memories in a specific community
export function getCommunityMembers(
  communityId: number,
  userId: number,
  limit: number = 50
): Array<{ id: number; content: string; category: string; importance: number; created_at: string }> {
  if (!ensureCommunityColumn()) return [];
  try {
    return db.prepare(
      `SELECT id, content, category, importance, created_at
       FROM memories
       WHERE community_id = ? AND user_id = ? AND is_forgotten = 0 AND is_archived = 0
       ORDER BY importance DESC, created_at DESC
       LIMIT ?`
    ).all(communityId, userId, limit) as Array<{
      id: number; content: string; category: string; importance: number; created_at: string;
    }>;
  } catch {
    return [];
  }
}

// Get community summary stats
export function getCommunityStats(userId: number): Array<{
  community_id: number; count: number; avg_importance: number; categories: string;
}> {
  if (!ensureCommunityColumn()) return [];
  try {
    return db.prepare(
      `SELECT community_id, COUNT(*) as count, ROUND(AVG(importance), 1) as avg_importance,
              GROUP_CONCAT(DISTINCT category) as categories
       FROM memories
       WHERE user_id = ? AND community_id IS NOT NULL AND is_forgotten = 0 AND is_archived = 0
       GROUP BY community_id
       ORDER BY count DESC
       LIMIT 50`
    ).all(userId) as Array<{
      community_id: number; count: number; avg_importance: number; categories: string;
    }>;
  } catch {
    return [];
  }
}
