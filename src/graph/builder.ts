// ============================================================================
// GRAPH DOMAIN -- Graph builder (BFS frontier, batch fetch, construction)
// ============================================================================

import { db } from "../db/connection.ts";
import { graphCache, setGraphCache } from "../embeddings/index.ts";
import { hybridSearch } from "../memory/search.ts";
import { log } from "../config/logger.ts";
import type { GNode, GEdge, GraphResult, GraphBuildOptions } from "./types.ts";
import { CHUNK_SIZE } from "./types.ts";

/**
 * Build a graph from the user memory space.
 *
 * Phase 1: Collect memory IDs (BFS from center, context search, or top-scored)
 * Phase 2: Batch fetch all memories
 * Phase 3: Batch fetch all links between graph nodes
 * Phase 4: Batch fetch entities (optional)
 * Phase 5: Fetch projects
 * Phase 6: Prune orphan memory nodes (no edges)
 */
export async function buildGraphData(opts: GraphBuildOptions): Promise<GraphResult> {
  const { center, depth, maxNodes, includeEntities, context, userId, cacheKey } = opts;

  // 30s response cache
  if (graphCache && graphCache.key === cacheKey && Date.now() - graphCache.ts < 30_000) {
    return graphCache.data as GraphResult;
  }

  const nodes: Map<string, GNode> = new Map();
  const edges: GEdge[] = [];

  // -- Phase 1: Collect memory IDs --------------------------------------------
  let memoryIds: number[];

  if (center) {
    const visited = new Set<number>([Number(center)]);
    let frontier = [Number(center)];
    for (let d = 0; d < depth && frontier.length > 0 && visited.size < maxNodes; d++) {
      const ph = frontier.map(() => "?").join(",");
      const linked = db.prepare(
        "SELECT DISTINCT CASE WHEN source_id IN (" + ph + ") THEN target_id ELSE source_id END as linked_id " +
        "FROM memory_links ml " +
        "JOIN memories ms ON ms.id = ml.source_id " +
        "JOIN memories mt ON mt.id = ml.target_id " +
        "WHERE (source_id IN (" + ph + ") OR target_id IN (" + ph + ")) " +
        "AND ms.user_id = ? AND mt.user_id = ?"
      ).all(...frontier, ...frontier, ...frontier, userId, userId) as any[];
      frontier = [];
      for (const r of linked) {
        if (!visited.has(r.linked_id) && visited.size < maxNodes) {
          visited.add(r.linked_id);
          frontier.push(r.linked_id);
        }
      }
    }
    memoryIds = [...visited];
  } else if (context) {
    const results = await hybridSearch(context, maxNodes, false, true, true, userId);
    memoryIds = results.map((r: any) => r.id);
  } else {
    const rows = db.prepare(
      "SELECT id FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ? " +
      "ORDER BY COALESCE(decay_score, importance) DESC LIMIT ?"
    ).all(userId, maxNodes) as any[];
    memoryIds = rows.map((r: any) => r.id);
  }

  if (memoryIds.length === 0) {
    const empty: GraphResult = { nodes: [], edges: [], links: [], node_count: 0, edge_count: 0 };
    setGraphCache({ key: cacheKey, data: empty, ts: Date.now() });
    return empty;
  }

  // -- Phase 2: Batch fetch all memories --------------------------------------
  const allMems: any[] = [];
  for (let i = 0; i < memoryIds.length; i += CHUNK_SIZE) {
    const chunk = memoryIds.slice(i, i + CHUNK_SIZE);
    const ph = chunk.map(() => "?").join(",");
    const rows = db.prepare(
      "SELECT id, content, category, source, importance, confidence, created_at, " +
      "is_static, is_forgotten, is_archived, parent_memory_id, source_count, " +
      "version, forget_after, pagerank_score " +
      "FROM memories WHERE id IN (" + ph + ") AND user_id = ? AND is_forgotten = 0"
    ).all(...chunk, userId) as any[];
    allMems.push(...rows);
  }

  for (const mem of allMems) {
    nodes.set("m" + mem.id, {
      id: "m" + mem.id,
      label: mem.content.substring(0, 60) + (mem.content.length > 60 ? "\u2026" : ""),
      type: "memory", category: mem.category, importance: mem.importance,
      confidence: mem.confidence, group: mem.category,
      size: Math.max(3, (mem.importance || 5) * 1.5 + (mem.pagerank_score || 0) * 5),
      source: mem.source, created_at: mem.created_at, is_static: mem.is_static,
      is_forgotten: mem.is_forgotten, is_archived: mem.is_archived,
      parent_memory_id: mem.parent_memory_id, source_count: mem.source_count,
      content: mem.content, version: mem.version,
      forget_after: mem.forget_after, pagerank_score: mem.pagerank_score || 0,
    });
  }

  // -- Phase 3: Batch fetch all links -----------------------------------------
  const validIds = allMems.map((m: any) => m.id);
  for (let i = 0; i < validIds.length; i += CHUNK_SIZE) {
    const chunk = validIds.slice(i, i + CHUNK_SIZE);
    const ph = chunk.map(() => "?").join(",");
    const linkRows = db.prepare(
      "SELECT ml.source_id, ml.target_id, ml.similarity, ml.type FROM memory_links ml " +
      "JOIN memories ms ON ms.id = ml.source_id " +
      "JOIN memories mt ON mt.id = ml.target_id " +
      "WHERE (ml.source_id IN (" + ph + ") OR ml.target_id IN (" + ph + ")) " +
      "AND ms.user_id = ? AND mt.user_id = ?"
    ).all(...chunk, ...chunk, userId, userId) as any[];
    const validSet = new Set(validIds);
    for (const link of linkRows) {
      if (validSet.has(link.source_id) && validSet.has(link.target_id)) {
        edges.push({
          source: "m" + link.source_id, target: "m" + link.target_id,
          type: link.type || "related", weight: link.similarity,
        });
      }
    }
  }

  // -- Phase 4: Entities (batch) ----------------------------------------------
  if (includeEntities && validIds.length > 0) {
    for (let i = 0; i < validIds.length; i += CHUNK_SIZE) {
      const chunk = validIds.slice(i, i + CHUNK_SIZE);
      const ph = chunk.map(() => "?").join(",");
      const meRows = db.prepare(
        "SELECT me.memory_id, e.id, e.name, e.type FROM entities e " +
        "JOIN memory_entities me ON me.entity_id = e.id WHERE me.memory_id IN (" + ph + ") AND e.user_id = ?"
      ).all(...chunk, userId) as any[];
      for (const ent of meRows) {
        const entNodeId = "e" + ent.id;
        if (!nodes.has(entNodeId)) {
          nodes.set(entNodeId, { id: entNodeId, label: ent.name, type: "entity", group: ent.type, size: 8 });
        }
        edges.push({ source: "m" + ent.memory_id, target: entNodeId, type: "about", weight: 1.0 });
      }
    }
    const entityIds = [...nodes.entries()].filter(([k]) => k.startsWith("e")).map(([k]) => Number(k.slice(1)));
    if (entityIds.length > 0) {
      const eph = entityIds.map(() => "?").join(",");
      const rels = db.prepare(
        "SELECT er.source_entity_id, er.target_entity_id, er.relationship FROM entity_relationships er " +
        "JOIN entities es ON es.id = er.source_entity_id " +
        "JOIN entities et ON et.id = er.target_entity_id " +
        "WHERE (er.source_entity_id IN (" + eph + ") OR er.target_entity_id IN (" + eph + ")) " +
        "AND es.user_id = ? AND et.user_id = ?"
      ).all(...entityIds, ...entityIds, userId, userId) as any[];
      for (const r of rels) {
        edges.push({ source: "e" + r.source_entity_id, target: "e" + r.target_entity_id, type: r.relationship, weight: 0.9 });
      }
    }
  }

  // -- Phase 5: Projects ------------------------------------------------------
  const projectNodes = db.prepare(
    "SELECT DISTINCT p.id, p.name, p.status FROM projects p " +
    "JOIN memory_projects mp ON mp.project_id = p.id " +
    "JOIN memories m ON m.id = mp.memory_id " +
    "WHERE p.user_id = ? AND m.is_forgotten = 0"
  ).all(userId) as any[];
  for (const proj of projectNodes) {
    const projNodeId = "p" + proj.id;
    nodes.set(projNodeId, { id: projNodeId, label: proj.name, type: "project", group: "project", size: 10 });
    const projMems = db.prepare(
      "SELECT mp.memory_id FROM memory_projects mp " +
      "JOIN memories m ON m.id = mp.memory_id " +
      "WHERE mp.project_id = ? AND m.user_id = ?"
    ).all(proj.id, userId) as any[];
    for (const pm of projMems) {
      if (nodes.has("m" + (pm as any).memory_id)) {
        edges.push({ source: projNodeId, target: "m" + (pm as any).memory_id, type: "contains", weight: 0.8 });
      }
    }
  }

  // -- Phase 6: Prune orphan memory nodes -------------------------------------
  if (!center) {
    const connectedIds = new Set<string>();
    for (const e of edges) {
      connectedIds.add(String(e.source));
      connectedIds.add(String(e.target));
    }
    for (const [id] of nodes) {
      if (id.startsWith("m") && !connectedIds.has(id)) {
        nodes.delete(id);
      }
    }
  }

  const result: GraphResult = {
    nodes: [...nodes.values()],
    edges,
    links: edges.slice(),
    node_count: nodes.size,
    edge_count: edges.length,
  };
  setGraphCache({ key: cacheKey, data: result, ts: Date.now() });
  log.info({ msg: "graph_built", nodes: nodes.size, edges: edges.length });
  return result;
}
