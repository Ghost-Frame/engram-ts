// ============================================================================
// CONTEXT DOMAIN - Dependency wiring
// Builds the ContextDeps object from existing module exports.
// ============================================================================

import type { ContextDeps } from "./index.ts";
import { embed, getCachedEmbeddings } from "../embeddings/index.ts";
import { hybridSearch } from "../memory/search.ts";
import { crossEncoderRerank, isRerankerReady } from "../reranker/index.ts";
import { isLLMAvailable, callLLM } from "../llm/index.ts";
import { getProfileForInjection, queueResynthesisIfStale } from "../intelligence/personality.ts";
import { buildWorkingMemoryBlock } from "../routes/types.ts";
import { db } from "../db/connection.ts";
import {
  getStaticMemories,
  getMemoryWithoutEmbedding,
  getVersionChainForUser,
  getLinksForUser,
  getRecentDynamicMemories,
  listScratchEntriesForContext,
  trackAccessWithFSRS,
  getEpisodeForUser,
} from "../db/index.ts";

export function buildContextDeps(): ContextDeps {
  return {
    embed: async (text: string) => {
      try { return await embed(text); }
      catch { return null; }
    },
    hybridSearch,
    crossEncoderRerank,
    isRerankerReady,
    getCachedEmbeddings: (all: boolean, userId: number) => getCachedEmbeddings(!all, userId),
    getStaticMemories: (userId: number) => getStaticMemories.all(userId) as any[],
    getMemoryWithoutEmbedding: (id: number) => getMemoryWithoutEmbedding.get(id) as any,
    getVersionChain: (rootId: number, userId: number) =>
      getVersionChainForUser.all(rootId, rootId, userId) as any[],
    getEpisode: (epId: number, userId: number) => getEpisodeForUser.get(epId, userId) as any,
    getLinks: (memId: number, userId: number) =>
      getLinksForUser.all(memId, userId, memId, userId) as any[],
    getRecentDynamic: (userId: number, limit: number) =>
      getRecentDynamicMemories.all(userId, limit) as any[],
    callLLM: async (systemPrompt: string, userPrompt: string) => {
      try { return await callLLM(systemPrompt, userPrompt); }
      catch { return null; }
    },
    isLLMAvailable,
    listScratchEntriesForContext: (userId: number, session: string | null) =>
      listScratchEntriesForContext.all(userId, session, session) as any[],
    buildWorkingMemoryBlock: (rows: any[]) => buildWorkingMemoryBlock(rows) || null,
    getCurrentState: (userId: number) =>
      db.prepare(
        "SELECT key, value, updated_count FROM current_state WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30"
      ).all(userId) as any[],
    getProfileForInjection,
    queueResynthesisIfStale,
    getUserPreferences: (userId: number) =>
      db.prepare(
        "SELECT domain, preference, strength FROM user_preferences WHERE user_id = ? AND strength >= 1.5 ORDER BY strength DESC LIMIT 15"
      ).all(userId) as any[],
    getStructuredFacts: (memIds: number[]) => {
      if (memIds.length === 0) return [];
      const placeholders = memIds.map(() => "?").join(",");
      return db.prepare(
        `SELECT subject, verb, object, quantity, unit, date_ref, date_approx, valid_at, invalid_at
         FROM structured_facts WHERE memory_id IN (${placeholders}) AND invalid_at IS NULL
         ORDER BY valid_at DESC NULLS LAST, date_approx DESC NULLS LAST`
      ).all(...memIds) as any[];
    },
    trackAccess: (ids: number[]) => {
      for (const id of ids) {
        try { trackAccessWithFSRS(id); } catch {}
      }
    },
  };
}
