// ============================================================================
// GRAPH DOMAIN -- Route handlers (entities, graph, facts, cooccurrences)
// ============================================================================

import { readFile } from "fs/promises";
import { resolve } from "path";
import type { Router } from "../router/types.ts";
import { getContext, hasScope, canAccessOwnedRow } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { DATA_DIR } from "../config/index.ts";
import { db } from "../db/connection.ts";
import { getMemoryWithoutEmbedding, trackAccessWithFSRS } from "../db/index.ts";
import { hybridSearch } from "../memory/search.ts";
import { getCooccurringEntities } from "./cooccurrence.ts";
import { buildGraphData } from "./builder.ts";
import {
  insertEntity,
  getEntityForUser,
  listEntities,
  listEntitiesByType,
  searchEntities,
  getEntityMemories,
  getEntityRelationships,
  updateEntity,
  deleteEntity,
  linkMemoryEntity,
  unlinkMemoryEntity,
  insertEntityRelationship,
  deleteEntityRelationship,
  getAllMemoriesForGraph,
  getAllLinksForGraph,
  getEntityMemoryIds,
} from "./db.ts";
import { VALID_ENTITY_TYPES } from "./types.ts";

export function registerGraphRoutes(router: Router): void {

  // -- Graph visualization ----------------------------------------------------

  // GET /graph -- build graph with BFS + caching
  router.get("/graph", async (req) => {
    const { auth, url } = getContext(req);
    try {
      const center = url.searchParams.get("center");
      const depth = Math.min(Number(url.searchParams.get("depth") || 2), 4);
      const maxNodes = Math.min(Number(url.searchParams.get("max") || 1000), 2000);
      const includeEntities = url.searchParams.get("entities") !== "0";
      const context = url.searchParams.get("q");
      const cacheKey = "graph:" + auth.user_id + ":" + (center || "") + ":" + depth + ":" + maxNodes + ":" + (includeEntities ? 1 : 0) + ":" + (context || "");
      const result = await buildGraphData({ center, depth, maxNodes, includeEntities, context, userId: auth.user_id, cacheKey });
      return json(result);
    } catch (e: any) {
      return safeError("Graph", e);
    }
  });

  // GET /graph/raw -- raw dump of all memories and links
  router.get("/graph/raw", async (req) => {
    const { auth } = getContext(req);
    const memories = getAllMemoriesForGraph.all(auth.user_id);
    const links = getAllLinksForGraph.all(auth.user_id);
    return json({ memories, links });
  });

  // GET /graph/view -- serve the graph visualization HTML page
  router.get("/graph/view", async (_req) => {
    const graphHtml = await readFile(resolve(DATA_DIR, "..", "engram-graph.html"), "utf-8").catch(() => null);
    if (!graphHtml) return errorResponse("Graph view not found. Place engram-graph.html in the project root", 404);
    return new Response(graphHtml, { headers: { "Content-Type": "text/html" } });
  });

  // -- Entities CRUD ----------------------------------------------------------

  // POST /entities -- create entity
  router.post("/entities", async (req) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const b = body as any;
      if (!b.name?.trim()) return errorResponse("name is required");
      const type = VALID_ENTITY_TYPES.includes(b.type) ? b.type : "generic";
      const result = insertEntity.get(
        b.name.trim(), type, b.description || null,
        b.aka || null, b.metadata ? JSON.stringify(b.metadata) : null,
        auth.user_id,
      ) as { id: number; created_at: string };
      return json({ created: true, id: result.id, name: b.name.trim(), type, created_at: result.created_at });
    } catch (e: any) {
      return safeError("create entity", e);
    }
  });

  // GET /entities -- list entities (optionally filtered by type or search query)
  router.get("/entities", async (req) => {
    const { auth, url } = getContext(req);
    const type = url.searchParams.get("type");
    const q = url.searchParams.get("q");
    let entities: any[];
    if (q) {
      const like = "%" + q + "%";
      entities = searchEntities.all(auth.user_id, like, like, like, 100) as any[];
    } else if (type) {
      entities = listEntitiesByType.all(auth.user_id, type) as any[];
    } else {
      entities = listEntities.all(auth.user_id) as any[];
    }
    for (const e of entities) {
      try { if (e.metadata) e.metadata = JSON.parse(e.metadata); } catch {}
    }
    return json({ entities, count: entities.length });
  });

  // GET /entities/:id -- get single entity with details
  router.get("/entities/:id", async (req, params) => {
    const { auth, url } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const entity = getEntityForUser.get(id, auth.user_id) as any;
    if (!entity) return errorResponse("Entity not found", 404);
    try { if (entity.metadata) entity.metadata = JSON.parse(entity.metadata); } catch {}
    entity.memory_ids = entity.memory_ids ? entity.memory_ids.split(",").map(Number) : [];
    entity.relationships = (getEntityRelationships.all(id, id, id, id, id) as any[])
      .filter((rel) => !!getEntityForUser.get(rel.related_entity_id, auth.user_id));
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
    entity.memories = getEntityMemories.all(id, auth.user_id, limit) as any[];
    for (const m of entity.memories) {
      try { if (m.tags) m.tags = JSON.parse(m.tags); } catch { m.tags = []; }
    }
    return json(entity);
  });

  // PUT /entities/:id -- update entity
  router.put("/entities/:id", async (req, params) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const id = Number(params.id);
      if (isNaN(id)) return errorResponse("Invalid id");
      const b = body as any;
      updateEntity.run(
        b.name || null, b.type || null, b.description || null,
        b.aka || null, b.metadata ? JSON.stringify(b.metadata) : null,
        id, auth.user_id,
      );
      return json({ updated: true, id });
    } catch (e: any) {
      return safeError("Update", e);
    }
  });

  // DELETE /entities/:id -- delete entity
  router.delete("/entities/:id", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    deleteEntity.run(id, auth.user_id);
    return json({ deleted: true, id });
  });

  // -- Memory-entity linking --------------------------------------------------

  // PUT /entities/:eid/memories/:mid -- link memory to entity
  router.put("/entities/:eid/memories/:mid", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const entityId = Number(params.eid);
    const memoryId = Number(params.mid);
    if (isNaN(entityId) || isNaN(memoryId)) return errorResponse("Invalid id");
    if (!getEntityForUser.get(entityId, auth.user_id)) return errorResponse("Entity not found", 404);
    const mem = getMemoryWithoutEmbedding.get(memoryId) as any;
    if (!canAccessOwnedRow(mem, auth)) return errorResponse("Memory not found", 404);
    linkMemoryEntity.run(memoryId, entityId);
    return json({ linked: true, entity_id: entityId, memory_id: memoryId });
  });

  // DELETE /entities/:eid/memories/:mid -- unlink memory from entity
  router.delete("/entities/:eid/memories/:mid", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const entityId = Number(params.eid);
    const memoryId = Number(params.mid);
    if (isNaN(entityId) || isNaN(memoryId)) return errorResponse("Invalid id");
    if (!getEntityForUser.get(entityId, auth.user_id)) return errorResponse("Entity not found", 404);
    const mem = getMemoryWithoutEmbedding.get(memoryId) as any;
    if (!canAccessOwnedRow(mem, auth)) return errorResponse("Memory not found", 404);
    unlinkMemoryEntity.run(memoryId, entityId);
    return json({ unlinked: true, entity_id: entityId, memory_id: memoryId });
  });

  // -- Entity relationships ---------------------------------------------------

  // POST /entities/:id/relationships -- create relationship
  router.post("/entities/:id/relationships", async (req, params) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const entityId = Number(params.id);
      if (isNaN(entityId)) return errorResponse("Invalid id");
      const b = body as any;
      if (!b.target_id || !b.relationship) return errorResponse("target_id and relationship required");
      if (!getEntityForUser.get(entityId, auth.user_id) || !getEntityForUser.get(Number(b.target_id), auth.user_id)) {
        return errorResponse("Entity not found", 404);
      }
      insertEntityRelationship.run(entityId, b.target_id, b.relationship);
      return json({ linked: true, source: entityId, target: b.target_id, relationship: b.relationship });
    } catch (e: any) {
      return safeError("Relationship", e);
    }
  });

  // DELETE /entities/:id/relationships -- delete relationship
  router.delete("/entities/:id/relationships", async (req, params) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const entityId = Number(params.id);
      if (isNaN(entityId)) return errorResponse("Invalid id");
      const b = body as any;
      if (!b.target_id || !b.relationship) return errorResponse("target_id and relationship required");
      if (!getEntityForUser.get(entityId, auth.user_id) || !getEntityForUser.get(Number(b.target_id), auth.user_id)) {
        return errorResponse("Entity not found", 404);
      }
      deleteEntityRelationship.run(entityId, b.target_id, b.relationship);
      return json({ unlinked: true, source: entityId, target: b.target_id, relationship: b.relationship });
    } catch (e: any) {
      return safeError("Unlink", e);
    }
  });

  // -- Entity-scoped search ---------------------------------------------------

  // POST /entities/:id/search -- search memories within an entity
  router.post("/entities/:id/search", async (req, params) => {
    const { auth } = getContext(req);
    try {
      const entityId = Number(params.id);
      if (isNaN(entityId)) return errorResponse("Invalid id");
      if (!getEntityForUser.get(entityId, auth.user_id)) return errorResponse("Entity not found", 404);
      const body = (getContext(req)).body as { query?: string; limit?: number };
      const query = body.query;
      if (!query) return errorResponse("query is required");
      const limit = Math.min(Number(body.limit || 20), 100);

      const entityMemIds = (getEntityMemoryIds.all(entityId, auth.user_id) as any[]).map(r => r.memory_id);
      if (entityMemIds.length === 0) return json({ results: [], count: 0, entity_id: entityId });

      const allResults = await hybridSearch(query, limit * 3, false, true, true, auth.user_id);
      const scoped = allResults.filter(r => entityMemIds.includes(r.id)).slice(0, limit);
      for (const r of scoped) trackAccessWithFSRS(r.id);
      return json({ results: scoped, count: scoped.length, entity_id: entityId });
    } catch (e: any) {
      return safeError("Entity search", e);
    }
  });

  // -- Entity cooccurrences ---------------------------------------------------

  // GET /entities/:id/cooccurrences -- get co-occurring entities
  router.get("/entities/:id/cooccurrences", async (req, params) => {
    const { auth, url } = getContext(req);
    try {
      const entityId = Number(params.id);
      if (isNaN(entityId)) return errorResponse("Invalid id");
      const limit = Math.min(Number(url.searchParams.get("limit") || 10), 50);
      const cooccurrences = getCooccurringEntities(entityId, auth.user_id, limit);
      return json({ entity_id: entityId, cooccurrences, count: cooccurrences.length });
    } catch (e: any) {
      return safeError("Entity cooccurrences", e);
    }
  });

  // -- Structured facts -------------------------------------------------------

  // GET /facts -- query extracted quantifiable facts
  router.get("/facts", async (req) => {
    const { auth, url } = getContext(req);
    try {
      const subject = url.searchParams.get("subject");
      const verb = url.searchParams.get("verb");
      const includeInvalid = url.searchParams.get("include_invalid") === "true";
      const validAt = url.searchParams.get("valid_at");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);

      let query = "SELECT * FROM structured_facts WHERE user_id = ?";
      const params: any[] = [auth.user_id];
      if (subject) { query += " AND subject LIKE ?"; params.push("%" + subject + "%"); }
      if (verb) { query += " AND verb = ?"; params.push(verb); }
      if (!includeInvalid) { query += " AND invalid_at IS NULL"; }
      if (validAt) {
        query += " AND (valid_at IS NULL OR valid_at <= ?) AND (invalid_at IS NULL OR invalid_at > ?)";
        params.push(validAt, validAt);
      }
      query += " ORDER BY valid_at DESC NULLS LAST, created_at DESC LIMIT ?";
      params.push(limit);

      const facts = db.prepare(query).all(...params);
      return json({ facts, count: (facts as any[]).length });
    } catch (e: any) {
      return safeError("Facts query", e);
    }
  });

} // end registerGraphRoutes
