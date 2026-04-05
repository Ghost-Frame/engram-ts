// ============================================================================
// EPISODES DOMAIN - Route handlers (thin wrappers)
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope, canAccessOwnedRow } from "../middleware/auth.ts";
import { json, errorResponse, safeError, sanitizeFTS } from "../helpers/index.ts";
import { log } from "../config/logger.ts";
import {
  insertEpisode,
  getEpisodeForUser,
  listEpisodes,
  listEpisodesByTimeRange,
  getEpisodeMemories,
  updateEpisodeForUser,
  updateEpisodeEmbedding,
  updateEpisodeVec,
  updateDurationSeconds,
  searchEpisodesFTS,
  assignToEpisodeForUser,
} from "./db.ts";
import {
  calculateDuration,
  buildFallbackSummary,
  formatMemoriesForLLM,
  nowTimestamp,
  EPISODE_SUMMARIZE_PROMPT,
  FINALIZE_SUMMARIZE_PROMPT,
  LLM_TEXT_LIMIT,
} from "./index.ts";
import type {
  CreateEpisodeBody,
  UpdateEpisodeBody,
  AssignMemoriesBody,
  InsertEpisodeResult,
  EpisodeMemoryRow,
} from "./types.ts";
import {
  embed,
  embedWithChunking,
  embeddingToBuffer,
  cosineSimilarity,
  episodeCache,
  refreshEmbeddingCache,
} from "../embeddings/index.ts";
import { embeddingToVectorJSON } from "../db/connection.ts";
import { callLocalModel, isLocalModelAvailable } from "../llm/local.ts";
import { getMemoryWithoutEmbedding } from "../db/index.ts";

export function registerEpisodeRoutes(router: Router): void {

  // POST /episodes - create a new episode
  router.post("/episodes", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = (getContext(req)).body as CreateEpisodeBody;
      const ep = insertEpisode.get(
        body.title || null, body.session_id || null, body.agent || null, auth.user_id,
      ) as InsertEpisodeResult;

      // If conversation text provided, generate narrative summary via LLM
      let summary = body.summary || null;
      if (body.conversation && isLocalModelAvailable() && !summary) {
        try {
          summary = await callLocalModel(
            EPISODE_SUMMARIZE_PROMPT,
            body.conversation.substring(0, LLM_TEXT_LIMIT),
            { priority: "background" },
          );
        } catch (e: any) {
          log.warn({ msg: "episode_summarization_failed", error: e.message });
        }
      }

      // Update with summary, timestamps, duration
      if (summary || body.ended_at) {
        updateEpisodeForUser.run(
          body.title || null, summary, body.ended_at || null, ep.id, auth.user_id,
        );
      }
      const dur = calculateDuration(body.started_at, body.ended_at);
      if (dur > 0) updateDurationSeconds(ep.id, dur);

      // Embed the summary for semantic search
      const textToEmbed = summary || body.title || body.conversation?.substring(0, 500) || "";
      if (textToEmbed) {
        try {
          const embArray = await embedWithChunking(textToEmbed);
          updateEpisodeEmbedding.run(embeddingToBuffer(embArray), ep.id);
          try { updateEpisodeVec.run(embeddingToVectorJSON(embArray), ep.id); } catch {}
          refreshEmbeddingCache();
        } catch (e: any) {
          log.warn({ msg: "episode_embed_failed", error: e.message });
        }
      }

      return json({ created: true, id: ep.id, started_at: ep.started_at, summary });
    } catch (e: any) {
      return safeError("create episode", e);
    }
  });

  // GET /episodes - list, search (temporal, semantic, FTS), or default recent
  router.get("/episodes", async (req) => {
    const { auth, url } = getContext(req);
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
    const query = url.searchParams.get("query");
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");

    // Temporal search
    if (after || before) {
      const from = after || "2000-01-01";
      const to = before || "2099-12-31";
      const episodes = listEpisodesByTimeRange.all(auth.user_id, from, to, limit) as any[];
      return json({ episodes });
    }

    // Semantic search over episodes
    if (query) {
      try {
        const queryEmb = await embed(query);
        const scored: Array<any & { score: number }> = [];

        // Vector search over episode cache
        for (const ep of episodeCache) {
          if (ep.user_id !== auth.user_id) continue;
          const sim = cosineSimilarity(queryEmb, ep.embedding);
          if (sim > 0.3) scored.push({ id: ep.id, summary: ep.summary, score: sim });
        }

        // FTS search
        try {
          const ftsHits = searchEpisodesFTS.all(sanitizeFTS(query), auth.user_id, limit) as any[];
          for (const hit of ftsHits) {
            const existing = scored.find((s) => s.id === hit.id);
            if (existing) { existing.score += 0.2; }
            else { scored.push({ ...hit, score: 0.3 }); }
          }
        } catch {}

        scored.sort((a, b) => b.score - a.score);
        const topIds = scored.slice(0, limit).map((s) => s.id);
        const episodes = topIds.map((id) => {
          const ep = getEpisodeForUser.get(id, auth.user_id) as any;
          const s = scored.find((x) => x.id === id);
          return ep ? { ...ep, score: Math.round((s?.score || 0) * 1000) / 1000 } : null;
        }).filter(Boolean);

        return json({ episodes });
      } catch (e: any) {
        return safeError("episode search", e);
      }
    }

    // Default: list recent
    const episodes = listEpisodes.all(auth.user_id, limit) as any[];
    return json({ episodes });
  });

  // GET /episodes/:id - get episode by id with its memories
  router.get("/episodes/:id", async (req, params) => {
    const { auth } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const episode = getEpisodeForUser.get(id, auth.user_id) as any;
    if (!episode) return errorResponse("Episode not found", 404);
    const memories = getEpisodeMemories.all(id, auth.user_id) as EpisodeMemoryRow[];
    for (const m of memories as any[]) {
      try { m.tags = JSON.parse(m.tags); } catch { m.tags = []; }
    }
    return json({ ...episode, memories });
  });

  // PATCH /episodes/:id - update episode fields
  router.patch("/episodes/:id", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const id = Number(params.id);
      if (isNaN(id)) return errorResponse("Invalid id");
      const episode = getEpisodeForUser.get(id, auth.user_id) as any;
      if (!episode) return errorResponse("Episode not found", 404);
      const body = (getContext(req)).body as UpdateEpisodeBody;
      updateEpisodeForUser.run(
        body.title || null, body.summary || null, body.ended_at || null, id, auth.user_id,
      );
      // Re-embed if summary changed
      if (body.summary) {
        try {
          const embArray = await embedWithChunking(body.summary);
          updateEpisodeEmbedding.run(embeddingToBuffer(embArray), id);
          try { updateEpisodeVec.run(embeddingToVectorJSON(embArray), id); } catch {}
          refreshEmbeddingCache();
        } catch {}
      }
      return json({ updated: true, id });
    } catch (e: any) {
      return safeError("update episode", e);
    }
  });

  // POST /episodes/:id/memories - assign memory IDs to an episode
  router.post("/episodes/:id/memories", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const episodeId = Number(params.id);
      if (isNaN(episodeId)) return errorResponse("Invalid id");
      const episode = getEpisodeForUser.get(episodeId, auth.user_id) as any;
      if (!episode) return errorResponse("Episode not found", 404);
      const body = (getContext(req)).body as AssignMemoriesBody;
      const memoryIds = body.memory_ids;
      if (!Array.isArray(memoryIds)) return errorResponse("memory_ids array required");
      let assigned = 0;
      for (const mid of memoryIds) {
        const mem = getMemoryWithoutEmbedding.get(mid) as any;
        if (!canAccessOwnedRow(mem, auth)) continue;
        assignToEpisodeForUser.run(episodeId, mid, auth.user_id);
        assigned++;
      }
      updateEpisodeForUser.run(null, null, null, episodeId, auth.user_id);
      return json({ assigned, episode_id: episodeId });
    } catch (e: any) {
      return safeError("assign memories", e);
    }
  });

  // POST /episodes/:id/finalize - generate summary, embed, set ended_at
  router.post("/episodes/:id/finalize", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const episodeId = Number(params.id);
      if (isNaN(episodeId)) return errorResponse("Invalid id");
      const ep = getEpisodeForUser.get(episodeId, auth.user_id) as any;
      if (!ep) return errorResponse("Episode not found", 404);

      const memories = getEpisodeMemories.all(episodeId, auth.user_id) as Array<{
        content: string; category: string; created_at: string;
      }>;
      if (memories.length === 0) return errorResponse("Episode has no memories", 400);

      let summary: string | null = ep.summary;
      if (!summary) {
        if (isLocalModelAvailable()) {
          try {
            const memText = formatMemoriesForLLM(memories);
            summary = await callLocalModel(FINALIZE_SUMMARIZE_PROMPT, memText, { priority: "background" });
          } catch (e: any) {
            log.warn({ msg: "episode_llm_summary_failed", error: e.message });
          }
        }
        if (!summary) {
          summary = buildFallbackSummary(memories);
        }
      }

      const endedAt = nowTimestamp();
      const titleFallback = "Session " + String(ep.session_id || ep.id);
      updateEpisodeForUser.run(
        ep.title || titleFallback, summary, endedAt, episodeId, auth.user_id,
      );

      // Calculate duration
      if (ep.started_at) {
        const dur = Math.round((Date.now() - new Date(ep.started_at).getTime()) / 1000);
        if (dur > 0) updateDurationSeconds(episodeId, dur);
      }

      // Embed the summary
      try {
        const embArray = await embedWithChunking(summary);
        updateEpisodeEmbedding.run(embeddingToBuffer(embArray), episodeId);
        try { updateEpisodeVec.run(embeddingToVectorJSON(embArray), episodeId); } catch {}
        refreshEmbeddingCache();
      } catch (e: any) {
        log.warn({ msg: "episode_finalize_embed_failed", error: e.message });
      }

      return json({ finalized: true, id: episodeId, summary, memory_count: memories.length });
    } catch (e: any) {
      return safeError("finalize episode", e);
    }
  });

} // end registerEpisodeRoutes
