// ============================================================================
// SEARCH DOMAIN -- Business logic (pure functions, no Request/Response)
// ============================================================================

import { SEARCH_MODES, type SearchMode, type SearchModeConfig, type RecallEntry, type RecallSource, type RecallBreakdown } from "./types.ts";

// Re-export types for convenience
export { SEARCH_MODES, type SearchMode, type SearchModeConfig, type RecallEntry, type RecallSource, type RecallBreakdown } from "./types.ts";

// ---------------------------------------------------------------------------
// Search mode preset resolution
// ---------------------------------------------------------------------------

export function applySearchMode(body: Record<string, any>, mode: string | undefined): void {
  if (!mode || !(mode in SEARCH_MODES)) return;
  const config = SEARCH_MODES[mode as SearchMode];
  if (config.temporal_sort !== undefined) body.temporal_sort = body.temporal_sort ?? config.temporal_sort;
  if (config.limit !== undefined) body.limit = body.limit ?? config.limit;
  if (config.vector_floor !== undefined) body.vector_floor = body.vector_floor ?? config.vector_floor;
  if (config.include_episodes !== undefined) body.include_episodes = body.include_episodes ?? config.include_episodes;
  if (config.expand_relationships !== undefined) body.expand_relationships = body.expand_relationships ?? config.expand_relationships;
  if (config.include_links !== undefined) body.include_links = body.include_links ?? config.include_links;
}

// ---------------------------------------------------------------------------
// Temporal sort
// ---------------------------------------------------------------------------

export function applyTemporalSort(results: Array<{ created_at?: string; [k: string]: any }>, direction: "asc" | "desc"): void {
  const dir = direction === "asc" ? 1 : -1;
  results.sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return (ta - tb) * dir;
  });
}

// ---------------------------------------------------------------------------
// Search explainability
// ---------------------------------------------------------------------------

export function buildExplainObject(r: any): { result: any; explain: Record<string, any> } {
  const explain: Record<string, any> = {};
  if (r.semantic_score != null) explain.vector = Math.round(r.semantic_score * 1000) / 1000;
  if (r.fts_score != null) explain.fts = Math.round(r.fts_score * 1000) / 1000;
  if (r.graph_score != null) explain.graph = Math.round(r.graph_score * 1000) / 1000;
  if (r.personality_signal_score != null) explain.personality = Math.round(r.personality_signal_score * 1000) / 1000;
  if (r.ce_score != null) explain.reranker = Math.round(r.ce_score * 1000) / 1000;
  if (r.combined_score != null) explain.rrf = Math.round(r.combined_score * 1000) / 1000;
  if (r.decay_score != null) explain.decay = Math.round(r.decay_score * 100) / 100;
  if (r.temporal_boost != null) explain.temporal_boost = r.temporal_boost;
  if (r.is_static) explain.static = true;
  if (r._pagerank_score > 0) explain.pagerank = Math.round(r._pagerank_score * 1000) / 1000;
  if (r.source_count && r.source_count > 1) explain.corroborated = r.source_count;
  if (r.question_type) explain.question_type = r.question_type;
  if (r._channels && r._channels.length > 0) explain.channels = r._channels;

  const reasons: string[] = [];
  if (explain.vector && explain.vector > 0.7) reasons.push("strong semantic match");
  else if (explain.vector && explain.vector > 0.5) reasons.push("moderate semantic match");
  if (explain.fts != null) reasons.push("full-text match");
  if (explain.graph != null) reasons.push("graph hop");
  if (explain.personality != null) reasons.push("personality signal");
  if (explain.temporal_boost != null) reasons.push("temporal proximity boost");
  if (explain.reranker && explain.reranker > 0.9) reasons.push("high reranker confidence");
  if (explain.static) reasons.push("permanent fact");
  if (explain.pagerank && explain.pagerank > 0.5) reasons.push("structurally important (hub memory)");
  if (explain.corroborated) reasons.push("corroborated " + explain.corroborated + "x");
  if (r.importance >= 8) reasons.push("high importance");
  explain.reasons = reasons;

  const { _channels, _pagerank_score, fts_score, graph_score, temporal_boost, ...rest } = r;
  return { result: rest, explain };
}

// ---------------------------------------------------------------------------
// Recall layer stacking
// ---------------------------------------------------------------------------

export function capStaticMemories(statics: any[], limit: number): any[] {
  const cap = Math.max(1, Math.ceil(limit * 0.25));
  return statics.length > cap ? statics.slice(0, cap) : statics;
}

export function buildRecallLayers(params: {
  staticFacts: any[];
  semanticResults: any[];
  importantResults: any[];
  recentResults: any[];
  limit: number;
  sourceFilter?: string;
  includeTags?: string[];
  getMemoryWithoutEmbedding: (id: number) => any;
}): { sorted: RecallEntry[]; breakdown: RecallBreakdown } {
  const { staticFacts, semanticResults, importantResults, recentResults, limit, sourceFilter, includeTags, getMemoryWithoutEmbedding } = params;
  const results = new Map<number, RecallEntry>();

  let filteredStatics = sourceFilter
    ? staticFacts.filter((s: any) => s.source && s.source.includes(sourceFilter))
    : staticFacts;
  filteredStatics = capStaticMemories(filteredStatics, limit);
  for (const sf of filteredStatics) {
    results.set(sf.id, { memory: sf, score: 100, source: "static" });
  }

  for (const sr of semanticResults) {
    if (!results.has(sr.id)) {
      const decayMultiplier = sr.decay_score ? (sr.decay_score / sr.importance) : 1;
      results.set(sr.id, { memory: sr, score: sr.score * 50 * decayMultiplier, source: "semantic" });
    }
  }

  for (const ri of importantResults) {
    if (!results.has(ri.id)) {
      const effectiveScore = ri.decay_score || ri.importance;
      results.set(ri.id, { memory: ri, score: effectiveScore * 2, source: "important" });
    }
  }

  for (const r of recentResults) {
    if (!results.has(r.id)) {
      results.set(r.id, { memory: r, score: 1, source: "recent" });
    }
  }

  if (includeTags && includeTags.length > 0) {
    for (const [id, entry] of results) {
      const mem = getMemoryWithoutEmbedding(id);
      if (mem?.tags) {
        try {
          const memTags = JSON.parse(mem.tags) as string[];
          const overlap = includeTags.filter(t => memTags.includes(t)).length;
          if (overlap > 0) entry.score *= (1 + overlap * 0.2);
        } catch {}
      }
    }
  }

  const sorted = Array.from(results.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const breakdown: RecallBreakdown = {
    static: sorted.filter(s => s.source === "static").length,
    semantic: sorted.filter(s => s.source === "semantic").length,
    important: sorted.filter(s => s.source === "important").length,
    recent: sorted.filter(s => s.source === "recent").length,
  };

  return { sorted, breakdown };
}
