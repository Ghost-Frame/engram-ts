// ============================================================================
// PACK DOMAIN -- Greedy knapsack packing algorithm
// Selects memories from static + semantic + important sources, packs them
// into a token budget using a greedy highest-score-first strategy.
// ============================================================================

import { hybridSearch } from "../memory/search.ts";
import { getStaticMemories, trackAccessWithFSRS } from "../search/db.ts";
import { db } from "../db/connection.ts";

export type PackFormat = "text" | "json" | "xml";

export interface PackCandidate {
  id: number;
  content: string;
  category: string;
  importance: number;
  decay_score: number;
  confidence: number;
  score: number;
  source: string;
}

export interface PackResult {
  packed: string;
  memories_included: number;
  tokens_estimated: number;
  token_budget: number;
  utilization: string;
}

const getHighImportant = db.prepare(
  `SELECT id, content, category, importance, decay_score, confidence
   FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
   ORDER BY COALESCE(decay_score, importance) DESC LIMIT 30`,
);

/**
 * Pack memories from static + semantic + important sources into a token budget.
 * Uses a greedy algorithm: sort by effective score (score * confidence), then
 * fill until budget is exhausted.
 *
 * @param context  - Optional query string for semantic search (empty = skip)
 * @param tokenBudget - Maximum tokens to fill (~4 chars per token)
 * @param format   - Output format: "text", "json", or "xml"
 * @param userId   - User ID for memory ownership
 * @returns PackResult with formatted output and metadata
 */
export async function packMemories(
  context: string,
  tokenBudget: number,
  format: PackFormat,
  userId: number,
): Promise<PackResult> {
  const candidates: PackCandidate[] = [];

  // Layer 1: Static facts (always included, highest priority)
  const staticFacts = getStaticMemories.all(userId) as Array<any>;
  for (const sf of staticFacts) {
    candidates.push({
      ...sf,
      score: 100,
      source: "static",
      decay_score: sf.importance,
      confidence: sf.confidence || 1,
    });
  }

  // Layer 2: Semantic search results
  if (context.trim()) {
    const semantic = await hybridSearch(context, 50, false, true, true, userId);
    for (const sr of semantic) {
      if (!candidates.find(c => c.id === sr.id)) {
        candidates.push({
          id: sr.id,
          content: sr.content,
          category: sr.category,
          importance: sr.importance,
          decay_score: sr.decay_score || sr.importance,
          confidence: 1,
          score: sr.score * 50,
          source: "semantic",
        });
      }
    }
  }

  // Layer 3: High-importance memories
  const important = getHighImportant.all(userId) as Array<any>;
  for (const m of important) {
    if (!candidates.find(c => c.id === m.id)) {
      candidates.push({
        ...m,
        score: (m.decay_score || m.importance) * 2,
        source: "important",
      });
    }
  }

  // Sort by effective score (score * confidence), descending
  candidates.sort((a, b) => (b.score * (b.confidence || 1)) - (a.score * (a.confidence || 1)));

  // Greedy packing: ~4 chars per token, +10 overhead per memory for formatting
  const packed: PackCandidate[] = [];
  let tokensUsed = 0;
  for (const c of candidates) {
    const memTokens = Math.ceil(c.content.length / 4) + 10;
    if (tokensUsed + memTokens > tokenBudget) continue;
    packed.push(c);
    tokensUsed += memTokens;
  }

  // Track access via FSRS for all packed memories
  for (const p of packed) {
    trackAccessWithFSRS(p.id);
  }

  // Format output
  let output: string;
  if (format === "xml") {
    output = packed.map(p =>
      `<memory id="${p.id}" category="${p.category}" importance="${p.importance}">\n${p.content}\n</memory>`,
    ).join("\n");
  } else if (format === "json") {
    output = JSON.stringify(packed.map(p => ({
      id: p.id,
      content: p.content,
      category: p.category,
      importance: p.importance,
    })));
  } else {
    // text (default)
    output = packed.map(p => `[${p.category}] ${p.content}`).join("\n\n");
  }

  return {
    packed: output,
    memories_included: packed.length,
    tokens_estimated: tokensUsed,
    token_budget: tokenBudget,
    utilization: Math.round((tokensUsed / tokenBudget) * 100) + "%",
  };
}
