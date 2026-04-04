// ============================================================================
// SEARCH DOMAIN - Route handlers (thin wrappers)
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { log, opsCounters } from "../config/logger.ts";
import { SEARCH_MIN_SCORE, RERANKER_ENABLED } from "../config/index.ts";
import { hybridSearch } from "../memory/search.ts";
import { crossEncoderRerank, isRerankerReady } from "../reranker/index.ts";
import { rerank } from "../llm/index.ts";
import { getProfileForInjection, queueResynthesisIfStale } from "../intelligence/personality.ts";
import { buildWorkingMemoryBlock, type ScratchEntryRow } from "../routes/types.ts";
import {
  getStaticMemories, getRecentImportant, listRecent,
  getMemoryWithoutEmbedding, getEpisode, getEpisodeForUser,
  listScratchEntriesForContext, getDecayScoreRows,
  trackAccessWithFSRS, updateDecayScores, db,
} from "./db.ts";
import { recordUsage, getArtifactsByMemory } from "../db/index.ts";
import {
  applySearchMode, applyTemporalSort, buildExplainObject,
  buildRecallLayers,
} from "./index.ts";

export function registerSearchRoutes(router: Router): void {

  // POST /search, /memories/search
  const searchHandler = async (req: Request) => {
    try {
      const _searchT0 = performance.now();
      const { auth, body: rawBody } = getContext(req);
      const body = rawBody as any;

      applySearchMode(body, body.mode);

      const { query, limit, include_links, expand_relationships, latest_only, tag,
              episode_id: filterEpisode, temporal_sort, vector_floor, source } = body;
      const factsOnly = body.facts_only === true;
      const excludeFacts = body.exclude_facts === true;
      if (!query || typeof query !== "string") return errorResponse("query is required");

      // Fetch more candidates when post-hoc filtering is active
      const hasPostFilter = !!tag || !!filterEpisode || factsOnly || excludeFacts;
      const baseLimit = Math.min(limit || 10, 50);
      const effectiveLimit = source ? Math.min(baseLimit * 5, 200)
        : hasPostFilter ? Math.min(baseLimit * 5, 200)
        : baseLimit;
      const _searchT1 = performance.now();
      let results = await hybridSearch(
        query, effectiveLimit, include_links || false, expand_relationships ?? true,
        latest_only ?? true, auth.user_id,
        vector_floor != null ? Number(vector_floor) : undefined, null, source || undefined,
      );
      if (source) results = results.slice(0, baseLimit);

      const _searchT2 = performance.now();
      log.info({ msg: "search_timing", phase: "hybridSearch", ms: (_searchT2 - _searchT1).toFixed(1) });

      // Cache memory lookups to avoid repeated DB hits per result
      const memCache = new Map<number, any>();
      const getMem = (id: number) => {
        let m = memCache.get(id);
        if (m === undefined) { m = getMemoryWithoutEmbedding.get(id) ?? null; memCache.set(id, m); }
        return m;
      };

      if (tag) {
        results = results.filter(r => {
          const mem = getMem(r.id);
          if (!mem?.tags) return false;
          try { return JSON.parse(mem.tags).includes(tag); } catch { return false; }
        });
      }

      if (filterEpisode) {
        results = results.filter(r => getMem(r.id)?.episode_id === filterEpisode);
      }

      if (factsOnly) {
        results = results.filter(r => getMem(r.id)?.is_fact === 1);
      }
      if (excludeFacts) {
        results = results.filter(r => !getMem(r.id)?.is_fact);
      }

      // Trim to requested limit after post-filters
      if (hasPostFilter) results = results.slice(0, baseLimit);

      const explicitOff = body.rerank === false;
      if (!explicitOff && RERANKER_ENABLED && isRerankerReady() && results.length > 3) {
        results = await crossEncoderRerank(query, results) as typeof results;
        results = results.slice(0, Math.min(limit || 10, 50));
      } else if (body.rerank === true && results.length > 3) {
        results = await rerank(query, results) as typeof results;
        results = results.slice(0, Math.min(limit || 10, 50));
      }

      if (temporal_sort) {
        applyTemporalSort(results, temporal_sort);
      }

      const resultIds = results.map(r => r.id);
      setTimeout(() => {
        try {
          const batch = db.transaction(() => {
            for (const id of resultIds) trackAccessWithFSRS(id);
          });
          batch();
        } catch {}
      }, 0);

      const episodeContext: Array<{ episode_id: number; title: string; summary: string; started_at: string }> = [];
      if (body.include_episodes) {
        const seenEpisodes = new Set<number>();
        for (const r of results) {
          const mem = getMem(r.id);
          const epId = mem?.episode_id;
          if (epId && !seenEpisodes.has(epId)) {
            seenEpisodes.add(epId);
            const ep = getEpisode.get(epId) as any;
            if (ep?.summary) {
              episodeContext.push({ episode_id: ep.id, title: ep.title || "", summary: ep.summary, started_at: ep.started_at });
            }
          }
        }
      }

      const _searchT3 = performance.now();
      log.info({ msg: "search_timing", total_ms: (_searchT3 - _searchT0).toFixed(1), hybrid_ms: (_searchT2 - _searchT1).toFixed(1), post_ms: (_searchT3 - _searchT2).toFixed(1), results: results.length });

      const topScore = results.length > 0 ? results[0].score : 0;
      const topSemanticScore = results.length > 0 ? (results[0].semantic_score || topScore) : 0;
      const minScore = body.min_score ?? SEARCH_MIN_SCORE;
      const abstained = results.length === 0 || topSemanticScore < minScore;

      const explainResults = body.explain !== false ? (abstained ? [] : results).map((r: any) => {
        const { result, explain } = buildExplainObject(r);
        return { ...result, explain };
      }) : (abstained ? [] : results);

      const _searchElapsed = _searchT3 - _searchT0;
      opsCounters.sla_search_total++;
      if (_searchElapsed < 200) opsCounters.sla_search_under_200ms++;
      try { recordUsage.run(auth.user_id, "memory.search", 1, null); } catch {}

      // Enrich search results with artifact metadata
      for (const r of explainResults) {
        const arts = getArtifactsByMemory.all(r.id) as Array<{ id: number; filename: string; mime_type: string; size_bytes: number }>;
        (r as any).artifacts = arts.map(({ id, filename, mime_type, size_bytes }) => ({ id, filename, mime_type, size_bytes }));
      }

      // Enrich with fact metadata
      for (const r of explainResults) {
        const mem = getMem(r.id);
        if (mem?.is_fact) {
          (r as any).is_fact = true;
          (r as any).parent_id = mem.parent_memory_id;
        }
      }

      return json({
        results: explainResults,
        abstained,
        top_score: Math.round(topScore * 1000) / 1000,
        ...(episodeContext.length > 0 ? { episodes: episodeContext } : {}),
        ...(body.mode ? { mode: body.mode } : {}),
      });
    } catch (e: any) {
      opsCounters.sla_errors_5xx++;
      return safeError("Search", e);
    }
  };
  router.post("/search", searchHandler);
  router.post("/memories/search", searchHandler);

  // POST /recall
  router.post("/recall", async (req) => {
    try {
      const { auth, body: rawBody } = getContext(req);
      const body = rawBody as any;
      const context = body.context || body.query || "";
      const limit = Math.min(Number(body.limit) || 20, 50);
      const includeTags = body.tags as string[] | undefined;
      const recallSourceFilter = body.source as string | undefined;
      const workingMemorySession = typeof body.session === "string" && body.session.trim() ? body.session.trim() : null;

      const staticFacts = getStaticMemories.all(auth.user_id) as any[];
      const semanticResults = context.trim()
        ? await hybridSearch(context, limit, false, true, true, auth.user_id, undefined, null, recallSourceFilter)
        : [];
      const importantResults = getRecentImportant.all(auth.user_id, limit) as any[];
      const recentResults = listRecent.all(auth.user_id, Math.min(limit, 15)) as any[];

      const { sorted, breakdown } = buildRecallLayers({
        staticFacts,
        semanticResults,
        importantResults,
        recentResults,
        limit,
        sourceFilter: recallSourceFilter,
        includeTags,
        getMemoryWithoutEmbedding: (id) => getMemoryWithoutEmbedding.get(id) as any,
      });

      for (const s of sorted) {
        trackAccessWithFSRS(s.memory.id);
      }

      const episodeContext: Array<{ episode_id: number; title: string; memory_count: number }> = [];
      const seenEpisodes = new Set<number>();
      for (const s of sorted) {
        const mem = getMemoryWithoutEmbedding.get(s.memory.id) as any;
        if (mem?.episode_id && !seenEpisodes.has(mem.episode_id)) {
          seenEpisodes.add(mem.episode_id);
          const ep = getEpisodeForUser.get(mem.episode_id, auth.user_id) as any;
          if (ep) {
            episodeContext.push({
              episode_id: mem.episode_id,
              title: ep.title || ("Session " + (ep.session_id || ep.id)),
              memory_count: ep.memory_count,
            });
          }
        }
      }

      let workingMemory = "";
      try {
        const scratchRows = listScratchEntriesForContext.all(auth.user_id, workingMemorySession, workingMemorySession) as ScratchEntryRow[];
        workingMemory = buildWorkingMemoryBlock(scratchRows);
      } catch {}

      try { recordUsage.run(auth.user_id, "memory.recall", 1, null); } catch {}

      let personalityProfile: string | null = null;
      try {
        const pp = getProfileForInjection(auth.user_id);
        if (pp) {
          personalityProfile = pp.profile;
          if (pp.isStale) queueResynthesisIfStale(auth.user_id);
        }
      } catch {}

      // Enrich recall results with artifact and fact metadata
      const recallMemories = sorted.map(s => {
        const arts = getArtifactsByMemory.all(s.memory.id) as Array<{ id: number; filename: string; mime_type: string; size_bytes: number }>;
        const mem = getMemoryWithoutEmbedding.get(s.memory.id) as any;
        return {
          ...s.memory,
          recall_source: s.source,
          recall_score: Math.round(s.score * 100) / 100,
          tags: s.memory.tags ? (() => { try { return JSON.parse(s.memory.tags); } catch { return []; } })() : [],
          artifacts: arts.map(({ id, filename, mime_type, size_bytes }) => ({ id, filename, mime_type, size_bytes })),
          ...(mem?.is_fact ? { is_fact: true, parent_id: mem.parent_memory_id } : {}),
        };
      });

      return json({
        memories: recallMemories,
        breakdown,
        ...(episodeContext.length > 0 ? { episodes: episodeContext } : {}),
        profile: sorted.filter(s => s.source === "static").map(s => s.memory.content),
        recent: sorted.filter(s => s.source === "recent").map(s => ({
          id: s.memory.id, content: s.memory.content, category: s.memory.category,
          source: s.memory.source, createdAt: s.memory.created_at,
        })),
        results: sorted.filter(s => s.source === "semantic" || s.source === "important").map(s => ({
          id: s.memory.id, content: s.memory.content, category: s.memory.category,
          source: s.memory.source, score: s.score, createdAt: s.memory.created_at,
        })),
        ...(workingMemory ? { working_memory: workingMemory } : {}),
        personality_profile: personalityProfile,
        count: sorted.length,
      });
    } catch (e: any) {
      return safeError("Smart recall", e);
    }
  });

  // POST /decay/refresh
  router.post("/decay/refresh", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const updated = updateDecayScores(auth.user_id);
    return json({ refreshed: updated });
  });

  // GET /decay/scores
  router.get("/decay/scores", async (req) => {
    const { auth, url } = getContext(req);
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
    const order = url.searchParams.get("order") === "asc" ? "ASC" as const : "DESC" as const;
    const rows = getDecayScoreRows(auth.user_id, limit, order);
    return json({ memories: rows });
  });

} // end registerSearchRoutes
