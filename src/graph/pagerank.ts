// ============================================================================
// PAGERANK -- iterative weighted PageRank for memory graph
// Ranks memories by structural importance: a memory linked to by important
// memories is itself more important. Uses type-aware edge weights.
// ============================================================================

import { db } from "../db/index.ts";
import { log } from "../config/logger.ts";

let pagerankColumnExists: boolean | null = null;

export function ensurePageRankColumn(): boolean {
  if (pagerankColumnExists === true) return true;
  if (pagerankColumnExists === false) return false;
  try {
    const row = db.prepare(
      "SELECT 1 FROM pragma_table_info('memories') WHERE name = 'pagerank_score'"
    ).get();
    if (row) { pagerankColumnExists = true; return true; }
    db.exec("ALTER TABLE memories ADD COLUMN pagerank_score REAL DEFAULT 0");
    pagerankColumnExists = true;
    log.info({ msg: "pagerank_score_column_added" });
    return true;
  } catch (e: any) {
    log.warn({ msg: "pagerank_column_check_failed", error: e.message });
    pagerankColumnExists = false;
    return false;
  }
}

// Type-aware edge weights (matches communities.ts)
function edgeWeight(type: string, similarity: number): number {
  const tw = type === "caused_by" || type === "causes" ? 2.0
    : type === "updates" || type === "corrects" ? 1.5
    : type === "extends" || type === "contradicts" ? 1.3
    : type === "consolidates" ? 0.5
    : 1.0;
  return similarity * tw;
}

export function computePageRank(
  userId: number,
  damping: number = 0.85,
  maxIterations: number = 25
): { scores: Map<number, number>; iterations: number } {
  const memories = db.prepare(
    `SELECT id FROM memories
     WHERE user_id = ? AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1`
  ).all(userId) as Array<{ id: number }>;

  const edges = db.prepare(
    `SELECT ml.source_id, ml.target_id, ml.similarity, ml.type
     FROM memory_links ml
     JOIN memories ms ON ms.id = ml.source_id
     JOIN memories mt ON mt.id = ml.target_id
     WHERE ms.user_id = ? AND mt.user_id = ?
       AND ms.is_forgotten = 0 AND mt.is_forgotten = 0
       AND ms.is_archived = 0 AND mt.is_archived = 0`
  ).all(userId, userId) as Array<{ source_id: number; target_id: number; similarity: number; type: string }>;

  const N = memories.length;
  if (N === 0) return { scores: new Map(), iterations: 0 };

  const pr = new Map<number, number>();
  const outW = new Map<number, number>();
  const inLinks = new Map<number, Array<{ from: number; weight: number }>>();

  for (const m of memories) {
    pr.set(m.id, 1 / N);
    outW.set(m.id, 0);
    inLinks.set(m.id, []);
  }

  for (const e of edges) {
    if (!pr.has(e.source_id) || !pr.has(e.target_id)) continue;
    const w = edgeWeight(e.type, e.similarity);
    outW.set(e.source_id, (outW.get(e.source_id) || 0) + w);
    inLinks.get(e.target_id)?.push({ from: e.source_id, weight: w });
  }

  let convergedAt = maxIterations;
  for (let iter = 0; iter < maxIterations; iter++) {
    let maxDelta = 0;
    const newPr = new Map<number, number>();

    for (const m of memories) {
      const incoming = inLinks.get(m.id) || [];
      let sum = 0;
      for (const link of incoming) {
        const fromRank = pr.get(link.from) || 0;
        const fromOutW = outW.get(link.from) || 1;
        sum += (fromRank * link.weight) / fromOutW;
      }
      const rank = (1 - damping) / N + damping * sum;
      newPr.set(m.id, rank);
      maxDelta = Math.max(maxDelta, Math.abs(rank - (pr.get(m.id) || 0)));
    }

    for (const [id, rank] of newPr) pr.set(id, rank);
    if (maxDelta < 1e-6) { convergedAt = iter + 1; break; }
  }

  return { scores: pr, iterations: convergedAt };
}

export function updatePageRankScores(userId: number): { memories: number; iterations: number } {
  if (!ensurePageRankColumn()) return { memories: 0, iterations: 0 };

  const { scores, iterations } = computePageRank(userId);
  if (scores.size === 0) return { memories: 0, iterations };

  let maxRank = 0;
  for (const rank of scores.values()) if (rank > maxRank) maxRank = rank;
  if (maxRank === 0) return { memories: scores.size, iterations };

  const stmt = db.prepare("UPDATE memories SET pagerank_score = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const [id, rank] of scores) stmt.run(rank / maxRank, id);
  });
  tx();

  log.info({
    msg: "pagerank_updated", user_id: userId,
    memories: scores.size, iterations, max_raw: maxRank.toFixed(6)
  });
  return { memories: scores.size, iterations };
}
