// ============================================================================
// CONTEXT DOMAIN - Progressive disclosure algorithm and token budget management
// ============================================================================

import type {
  ContextOptions,
  ContextResult,
  ContextBlock,
  ContextTiming,
  ContextStrategy,
} from "./types.ts";
import {
  DEFAULT_TOKEN_BUDGET,
  MAX_TOKEN_BUDGET,
  DEFAULT_MAX_MEMORY_TOKENS,
  DEFAULT_DEDUP_THRESHOLD,
  DEFAULT_MIN_RELEVANCE,
  DEFAULT_SEMANTIC_CEILING_BALANCED,
  DEFAULT_SEMANTIC_CEILING_PRECISION,
  DEFAULT_SEMANTIC_CEILING_BREADTH,
  STATIC_BUDGET_BALANCED,
  STATIC_BUDGET_PRECISION,
  RECENCY_BOOST_MS,
} from "./types.ts";

export type {
  ContextOptions,
  ContextResult,
  ContextBlock,
  ContextTiming,
  ContextStrategy,
} from "./types.ts";
export {
  DEFAULT_TOKEN_BUDGET,
  MAX_TOKEN_BUDGET,
  DEFAULT_MAX_MEMORY_TOKENS,
  DEFAULT_DEDUP_THRESHOLD,
  DEFAULT_MIN_RELEVANCE,
  RECENCY_BOOST_MS,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Mode preset resolution
// ---------------------------------------------------------------------------

/**
 * Mutates the options object to apply mode preset defaults.
 * Presets only set values that have not already been provided.
 */
export function applyContextMode(opts: Record<string, any>, mode: string | undefined): void {
  if (!mode) return;
  if (mode === "fast") {
    opts.depth = opts.depth ?? 1;
    opts.max_tokens = opts.max_tokens ?? 2000;
  } else if (mode === "balanced") {
    opts.depth = opts.depth ?? 2;
    opts.max_tokens = opts.max_tokens ?? 6000;
  } else if (mode === "deep") {
    opts.depth = opts.depth ?? 3;
    opts.max_tokens = opts.max_tokens ?? 16000;
    opts.include_inference = opts.include_inference ?? true;
  } else if (mode === "decision") {
    opts.depth = opts.depth ?? 3;
    opts.max_tokens = opts.max_tokens ?? 10000;
    opts.include_linked = true;
    opts.include_structured_facts = true;
  }
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: 1 token ~= 4 chars */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Sentence-boundary truncation
// ---------------------------------------------------------------------------

/**
 * Truncate content to fit within maxMemoryTokens.
 * Prefers sentence boundaries where possible.
 */
export function truncateToTokenBudget(content: string, maxMemoryTokens: number): string {
  if (estimateTokens(content) <= maxMemoryTokens) return content;
  const maxChars = maxMemoryTokens * 4;
  const cutPoint = content.lastIndexOf(". ", maxChars);
  if (cutPoint > maxChars * 0.6) return content.substring(0, cutPoint + 1) + " [truncated]";
  return content.substring(0, maxChars) + "... [truncated]";
}

// ---------------------------------------------------------------------------
// Cosine similarity (inline - avoids circular import on the embeddings domain)
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Attribution tag builder
// ---------------------------------------------------------------------------

export function buildAttribution(block: ContextBlock): string {
  const parts: string[] = [];
  if (block.model) parts.push(block.model);
  if (block.origin && block.origin !== "unknown") parts.push(`via ${block.origin}`);
  return parts.length > 0 ? ` (by ${parts.join(" ")})` : "";
}

// ---------------------------------------------------------------------------
// Context string assembly from blocks
// ---------------------------------------------------------------------------

/**
 * Assembles the final context string from layers of blocks plus supplementary
 * sections (working memory, current state, personality, preferences, facts).
 * This is the formatting step only - no DB calls here.
 */
export function assembleContextString(
  blocks: ContextBlock[],
  supplementary: { label: string; content: string }[],
): string {
  const parts: string[] = [];

  // Supplementary sections come first (working memory, current state, personality, etc.)
  for (const s of supplementary) {
    parts.push(s.content);
  }

  const staticBlocks = blocks.filter(b => b.source === "static");
  const semanticBlocks = blocks.filter(b => b.source === "semantic");
  const evolutionBlocks = blocks.filter(b => b.source === "evolution");
  const episodeBlocks = blocks.filter(b => b.source === "episode");
  const linkedBlocks = blocks.filter(b => b.source === "linked");
  const recentBlocks = blocks.filter(b => b.source === "recent");
  const inferenceBlocks = blocks.filter(b => b.source === "inference");

  if (staticBlocks.length > 0) {
    parts.push("## Permanent Facts\n" + staticBlocks.map(b => `- ${b.content}${buildAttribution(b)}`).join("\n"));
  }
  if (semanticBlocks.length > 0) {
    const factBlocks = semanticBlocks.filter(b => b.category === "fact");
    const nonFactBlocks = semanticBlocks.filter(b => b.category !== "fact");

    const lines: string[] = [];
    for (const b of nonFactBlocks) {
      lines.push(`- [${b.category}] ${b.content}${buildAttribution(b)}`);
    }

    // Group facts by parent ID for cleaner output
    if (factBlocks.length > 0) {
      const byParent = new Map<number, typeof factBlocks>();
      for (const b of factBlocks) {
        const parentId = b.parent_id || 0;
        if (!byParent.has(parentId)) byParent.set(parentId, []);
        byParent.get(parentId)!.push(b);
      }
      for (const [parentId, facts] of byParent) {
        if (parentId > 0) {
          lines.push(`- [facts from memory #${parentId}]`);
          for (const f of facts) lines.push(`  - ${f.content}`);
        } else {
          for (const f of facts) lines.push(`- [fact] ${f.content}`);
        }
      }
    }

    parts.push("## Relevant Memories\n" + lines.join("\n"));
  }
  if (evolutionBlocks.length > 0) {
    parts.push("## Preference/Fact Evolution\n" + evolutionBlocks.map(b => b.content).join("\n\n"));
  }
  if (episodeBlocks.length > 0) {
    parts.push("## Episode Context\n" + episodeBlocks.map(b => `- [${b.created_at || ""}] ${b.content}${buildAttribution(b)}`).join("\n"));
  }
  if (linkedBlocks.length > 0) {
    parts.push("## Related Context\n" + linkedBlocks.map(b => `- ${b.content}${buildAttribution(b)}`).join("\n"));
  }
  if (recentBlocks.length > 0) {
    parts.push("## Recent Activity\n" + recentBlocks.map(b => `- [${b.created_at || ""}] ${b.content}${buildAttribution(b)}`).join("\n"));
  }
  if (inferenceBlocks.length > 0) {
    parts.push("## Implicit Connections\n" + inferenceBlocks.map(b => b.content).join("\n"));
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Layer enable flags from options
// ---------------------------------------------------------------------------

export interface LayerFlags {
  includeStatic: boolean;
  includeRecent: boolean;
  includeEpisodes: boolean;
  includeLinked: boolean;
  includeInference: boolean;
  includeCurrentState: boolean;
  includePreferences: boolean;
  includeStructuredFacts: boolean;
  includeWorkingMemory: boolean;
  includePersonality: boolean;
}

export function resolveLayerFlags(opts: ContextOptions, depth: number): LayerFlags {
  return {
    includeStatic: opts.include_static !== false && depth >= 1,
    includeRecent: opts.include_recent !== false && depth >= 2,
    includeEpisodes: opts.include_episodes !== false && depth >= 3,
    includeLinked: opts.include_linked !== false && depth >= 3,
    includeInference: opts.include_inference === true && depth >= 3,
    includeCurrentState: opts.include_current_state !== false && depth >= 1,
    includePreferences: opts.include_preferences !== false && depth >= 2,
    includeStructuredFacts: opts.include_structured_facts !== false && depth >= 2,
    includeWorkingMemory: opts.include_working_memory !== false && depth >= 3,
    includePersonality: depth >= 2,
  };
}

// ---------------------------------------------------------------------------
// Semantic ceiling and limit resolution
// ---------------------------------------------------------------------------

export function resolveSemanticCeiling(strategy: ContextStrategy, override?: number): number {
  if (override != null) return Number(override);
  if (strategy === "precision") return DEFAULT_SEMANTIC_CEILING_PRECISION;
  if (strategy === "breadth") return DEFAULT_SEMANTIC_CEILING_BREADTH;
  return DEFAULT_SEMANTIC_CEILING_BALANCED;
}

export function resolveSemanticLimit(strategy: ContextStrategy, override?: number): number {
  if (override != null) return Number(override);
  if (strategy === "precision") return 30;
  if (strategy === "breadth") return 80;
  return 50;
}

export function resolveStaticBudgetFraction(strategy: ContextStrategy): number {
  return strategy === "precision" ? STATIC_BUDGET_PRECISION : STATIC_BUDGET_BALANCED;
}

// ---------------------------------------------------------------------------
// assembleContext - pure function (delegates DB calls via injected helpers)
// ---------------------------------------------------------------------------

/**
 * Dependencies injected by the route handler so the algorithm stays pure
 * and testable. All DB access happens through these callbacks.
 */
export interface ContextDeps {
  /** Embed query text; returns null on failure */
  embed(query: string): Promise<Float32Array | null>;
  /** Hybrid search for semantic results */
  hybridSearch(
    query: string,
    limit: number,
    expandRelationships: boolean,
    includeLinks: boolean,
    semanticOnly: boolean,
    userId: number,
    sessionId: undefined,
    queryEmb: Float32Array | null,
    sourceFilter: string | undefined,
  ): Promise<any[]>;
  /** Cross-encoder rerank (optional - only called when reranker is ready) */
  crossEncoderRerank?(query: string, results: any[], batchSize: number): Promise<any[]>;
  isRerankerReady(): boolean;
  /** Get all cached embeddings for deduplication */
  getCachedEmbeddings(all: boolean, userId: number): Array<{ id: number; embedding: Float32Array; user_id?: number }>;
  /** Get static memories for user */
  getStaticMemories(userId: number): any[];
  /** Get a single memory without embedding */
  getMemoryWithoutEmbedding(id: number): any;
  /** Get version chain for a root memory */
  getVersionChain(rootId: number, userId: number): Array<{ id: number; content: string; category: string; version: number; is_latest: boolean; created_at: string }>;
  /** Get episode record */
  getEpisode(epId: number, userId: number): any;
  /** Get linked memories */
  getLinks(memId: number, userId: number): any[];
  /** Get recent dynamic memories */
  getRecentDynamic(userId: number, limit: number): any[];
  /** Call LLM for inference */
  callLLM?(systemPrompt: string, userPrompt: string): Promise<string | null>;
  isLLMAvailable(): boolean;
  /** Working memory - scratch entries for context */
  listScratchEntriesForContext(userId: number, session: string | null): any[];
  buildWorkingMemoryBlock(rows: any[]): string | null;
  /** Current state KV pairs */
  getCurrentState(userId: number): Array<{ key: string; value: string; updated_count: number }>;
  /** Personality profile */
  getProfileForInjection(userId: number): { profile: string; isStale: boolean } | null;
  queueResynthesisIfStale(userId: number): void;
  /** User preferences */
  getUserPreferences(userId: number): Array<{ domain: string; preference: string; strength: number }>;
  /** Structured facts for a set of memory IDs */
  getStructuredFacts(memIds: number[]): any[];
  /** Track access for FSRS (deferred, fire-and-forget) */
  trackAccess(ids: number[]): void;
}

/**
 * Core progressive disclosure algorithm.
 *
 * Assembles context from 8 layers:
 *   1. Static facts (permanent, ranked by query relevance)
 *   2. Semantic search (hybrid vector + FTS, optional rerank)
 *   2.5a. Version chain evolution (preference/fact change history)
 *   2.5b. Episode context (summarized conversation episodes)
 *   3. Linked memories (graph expansion from semantic results)
 *   4. Recent memories (temporal context)
 *   5. Inference (LLM-generated implicit connections)
 *   + Supplementary: working memory, current state, personality, preferences, facts
 *
 * All token budgets are fractions of the total tokenBudget parameter.
 */
export async function assembleContext(
  opts: ContextOptions,
  userId: number,
  deps: ContextDeps,
): Promise<ContextResult> {
  // --- Apply mode preset ---
  const mutableOpts: Record<string, any> = { ...opts };
  applyContextMode(mutableOpts, opts.mode);

  // --- Resolve parameters ---
  const rawBudget =
    Number(mutableOpts.max_tokens) ||
    Number(mutableOpts.token_budget || opts.token_budget) ||
    Number(mutableOpts.budget || opts.budget) ||
    DEFAULT_TOKEN_BUDGET;
  const tokenBudget = Math.min(rawBudget, MAX_TOKEN_BUDGET);
  const contextStrategy: ContextStrategy = (mutableOpts.strategy as ContextStrategy) || "balanced";
  const depth = Math.max(1, Math.min(3, Number(mutableOpts.depth) || 3)) as 1 | 2 | 3;

  const MAX_MEMORY_TOKENS =
    mutableOpts.max_memory_tokens != null
      ? Number(mutableOpts.max_memory_tokens)
      : DEFAULT_MAX_MEMORY_TOKENS;
  const dedupThresh =
    mutableOpts.dedup_threshold != null
      ? Number(mutableOpts.dedup_threshold)
      : DEFAULT_DEDUP_THRESHOLD;

  const sourceFilter: string | undefined = mutableOpts.source || undefined;
  const workingMemorySession: string | null =
    typeof opts.session === "string" && opts.session.trim() ? opts.session.trim() : null;

  const flags = resolveLayerFlags(mutableOpts as ContextOptions, depth);
  const semanticCeiling = resolveSemanticCeiling(
    contextStrategy,
    mutableOpts.semantic_ceiling != null ? Number(mutableOpts.semantic_ceiling) : undefined,
  );
  const semanticLimit = resolveSemanticLimit(
    contextStrategy,
    mutableOpts.semantic_limit != null ? Number(mutableOpts.semantic_limit) : undefined,
  );
  const minRelev =
    mutableOpts.min_relevance != null ? Number(mutableOpts.min_relevance) : DEFAULT_MIN_RELEVANCE;

  const truncate = (content: string) => truncateToTokenBudget(content, MAX_MEMORY_TOKENS);

  // --- State ---
  const blocks: ContextBlock[] = [];
  let usedTokens = 0;
  const seenIds = new Set<number>();
  const t0 = Date.now();
  const timing: ContextTiming = {};

  // --- Embedding map for dedup ---
  const allCached = deps.getCachedEmbeddings(true, userId);
  const embMap = new Map<number, { embedding: Float32Array }>();
  for (const c of allCached) {
    if ((c as any).user_id === userId) embMap.set(c.id, c);
  }
  const blockEmbeddings: Float32Array[] = [];
  const memLookupCache = new Map<number, any>();

  const isDuplicate = (memId: number): boolean => {
    const cached = embMap.get(memId);
    if (!cached || blockEmbeddings.length === 0) return false;
    for (const existing of blockEmbeddings) {
      if (cosineSimilarity(cached.embedding, existing) > dedupThresh) return true;
    }
    return false;
  };

  // --- Embed query ---
  let queryEmb: Float32Array | null = null;
  try { queryEmb = await deps.embed(opts.query); } catch {}
  timing.embed_ms = Date.now() - t0;

  // ---- Phase 1: Static facts, ranked by query relevance ----
  if (flags.includeStatic) {
    let statics = deps.getStaticMemories(userId);
    if (sourceFilter) statics = statics.filter((s: any) => s.source && s.source.includes(sourceFilter));
    const scored: Array<{ mem: any; relevance: number }> = [];
    for (const s of statics) {
      let relevance = 0.5;
      if (queryEmb) {
        const cached = embMap.get(s.id);
        if (cached) relevance = cosineSimilarity(queryEmb, cached.embedding);
      }
      relevance += Math.min((s.source_count || 1) / 20, 0.1);
      scored.push({ mem: s, relevance });
    }
    scored.sort((a, b) => b.relevance - a.relevance);

    const staticBudgetFraction = resolveStaticBudgetFraction(contextStrategy);
    for (const { mem, relevance } of scored) {
      const truncated = truncate(mem.content);
      const tokens = estimateTokens(truncated);
      if (usedTokens + tokens > tokenBudget * staticBudgetFraction) break;
      blocks.push({
        id: mem.id, content: truncated, category: mem.category,
        score: relevance * 100, source: "static", tokens,
        model: mem.model || null, origin: mem.source || null,
      });
      seenIds.add(mem.id);
      usedTokens += tokens;
      const cached = embMap.get(mem.id);
      if (cached) blockEmbeddings.push(cached.embedding);
    }
  }
  timing.static_ms = Date.now() - t0 - (timing.embed_ms || 0);

  // ---- Phase 2: Semantic search ----
  const tSearch = Date.now();
  let semanticResults = await deps.hybridSearch(
    opts.query, semanticLimit, false, false, true,
    userId, undefined, queryEmb, sourceFilter,
  );
  timing.search_ms = Date.now() - tSearch;

  // Optional cross-encoder rerank
  if (deps.crossEncoderRerank && deps.isRerankerReady() && semanticResults.length > 3) {
    const tRerank = Date.now();
    semanticResults = await deps.crossEncoderRerank(opts.query, semanticResults, 8);
    timing.rerank_ms = Date.now() - tRerank;
  }

  for (const r of semanticResults) {
    if (seenIds.has(r.id)) continue;
    const truncated = truncate(r.content);
    const tokens = estimateTokens(truncated);
    if (usedTokens + tokens > tokenBudget * semanticCeiling) break;
    if (isDuplicate(r.id)) continue;

    const rawSemanticScore = r.semantic_score || r.score || 0;
    if (rawSemanticScore < minRelev) continue;
    const rawScore = r.combined_score || rawSemanticScore;

    // Recency boost: last 48h get +10%
    let score = rawScore;
    if (r.created_at) {
      const ageMs = Date.now() - new Date(r.created_at + "Z").getTime();
      if (ageMs < RECENCY_BOOST_MS) score *= 1.10;
    }

    blocks.push({
      id: r.id, content: truncated, category: r.category,
      score, source: "semantic", tokens,
      model: r.model || null, origin: r.source || null,
    });
    // Attach parent_id for fact grouping in assembly
    // Cache the lookup so the evolution phase below doesn't re-fetch
    const memForFact = deps.getMemoryWithoutEmbedding(r.id);
    if (memForFact?.is_fact && memForFact.parent_memory_id) {
      blocks[blocks.length - 1].parent_id = memForFact.parent_memory_id;
    }
    seenIds.add(r.id);
    usedTokens += tokens;
    const cachedEmb = embMap.get(r.id);
    if (cachedEmb) blockEmbeddings.push(cachedEmb.embedding);
    // Store in local cache for reuse in evolution phase
    if (memForFact) memLookupCache.set(r.id, memForFact);
  }

  timing.semantic_ms = Date.now() - t0 - Object.values(timing).reduce((a: number, b) => a + (b || 0), 0);

  // ---- Phase 2.5a: Version chain evolution ----
  const tEvolution = Date.now();
  if (depth >= 2 && usedTokens < tokenBudget * 0.72) {
    const semanticBlocksForEvolution = blocks.filter(b => b.source === "semantic").slice(0, 8);
    for (const b of semanticBlocksForEvolution) {
      if (usedTokens >= tokenBudget * 0.72) break;
      const mem = memLookupCache.get(b.id) || deps.getMemoryWithoutEmbedding(b.id);
      if (!mem) continue;
      const rootId = mem.root_memory_id || mem.id;
      const chain = deps.getVersionChain(rootId, userId);
      if (chain.length < 2) continue;
      const evolutionLines = chain.map(c =>
        `v${c.version} (${c.created_at?.slice(0, 10) || "?"}): ${c.content}`
      );
      const evolutionText = `[Evolution of memory #${rootId}]\n` + evolutionLines.join("\n");
      const truncated = truncate(evolutionText);
      const tokens = estimateTokens(truncated);
      if (usedTokens + tokens > tokenBudget * 0.75) break;
      blocks.push({
        id: -rootId, content: truncated, category: "evolution",
        score: 70, source: "evolution", tokens,
        created_at: chain[chain.length - 1].created_at,
      });
      for (const c of chain) seenIds.add(c.id);
      usedTokens += tokens;
    }
  }
  timing.evolution_ms = Date.now() - tEvolution;

  // ---- Phase 2.5b: Episode context ----
  const tEpisodes = Date.now();
  const seenEpisodeIds = new Set<number>();
  if (flags.includeEpisodes && usedTokens < tokenBudget * 0.75) {
    for (const b of blocks.filter(b => b.source === "semantic").slice(0, 5)) {
      const mem = deps.getMemoryWithoutEmbedding(b.id);
      const epId = mem?.episode_id;
      if (epId && !seenEpisodeIds.has(epId)) {
        seenEpisodeIds.add(epId);
        const ep = deps.getEpisode(epId, userId);
        if (ep?.summary) {
          const truncated = truncate(ep.summary);
          const tokens = estimateTokens(truncated);
          if (usedTokens + tokens <= tokenBudget * 0.8) {
            blocks.push({
              id: -epId, content: truncated, category: "episode",
              score: 75, source: "episode", tokens, created_at: ep.started_at,
            });
            usedTokens += tokens;
          }
        }
      }
    }
  }
  timing.episodes_ms = Date.now() - tEpisodes;

  // ---- Phase 3: Linked memories (graph expansion) ----
  const tLinked = Date.now();
  if (flags.includeLinked && contextStrategy !== "precision" && usedTokens < tokenBudget * 0.85) {
    const semanticIds = blocks.filter(b => b.source === "semantic").slice(0, 5).map(b => b.id);
    for (const sid of semanticIds) {
      if (usedTokens >= tokenBudget * 0.85) break;
      const linked = deps.getLinks(sid, userId);
      for (const l of linked) {
        if (seenIds.has(l.id) || l.is_forgotten) continue;
        const truncated = truncate(l.content);
        const tokens = estimateTokens(truncated);
        if (usedTokens + tokens > tokenBudget * 0.88) break;
        if (isDuplicate(l.id)) continue;
        blocks.push({
          id: l.id, content: truncated, category: l.category,
          score: (l.similarity || 0) * 50, source: "linked", tokens,
          model: l.model || null, origin: l.source || null,
        });
        seenIds.add(l.id);
        usedTokens += tokens;
        const cachedEmb = embMap.get(l.id);
        if (cachedEmb) blockEmbeddings.push(cachedEmb.embedding);
      }
    }
  }
  timing.linked_ms = Date.now() - tLinked;

  // ---- Phase 4: Recent memories (temporal context, capped at 12% of budget) ----
  const tRecent = Date.now();
  const recentCeiling = tokenBudget * 0.93;
  if (flags.includeRecent && usedTokens < recentCeiling) {
    const recent = deps.getRecentDynamic(userId, 5);
    for (const r of recent) {
      if (seenIds.has(r.id)) continue;
      const truncated = truncate(r.content);
      const tokens = estimateTokens(truncated);
      if (usedTokens + tokens > recentCeiling) break;
      if (isDuplicate(r.id)) continue;
      blocks.push({
        id: r.id, content: truncated, category: r.category,
        score: 10, source: "recent", tokens,
        model: r.model || null, origin: r.source || null,
      });
      seenIds.add(r.id);
      usedTokens += tokens;
      const cachedEmb = embMap.get(r.id);
      if (cachedEmb) blockEmbeddings.push(cachedEmb.embedding);
    }
  }
  timing.recent_ms = Date.now() - tRecent;

  // ---- Phase 5: Implicit connection inference (LLM post-processing) ----
  const tInference = Date.now();
  const semanticBlocksForInference = blocks.filter(b => b.source === "semantic");
  if (
    flags.includeInference &&
    deps.isLLMAvailable() &&
    deps.callLLM &&
    semanticBlocksForInference.length >= 2 &&
    usedTokens < tokenBudget * 0.95
  ) {
    try {
      const topFacts = semanticBlocksForInference.slice(0, 6)
        .map(b => `[${b.id}] ${b.content}`)
        .join("\n");
      const inferenceResult = await deps.callLLM(
        `You find implicit connections between memories that aren't directly stated. Given these memories, identify 0-3 implicit connections. For each, write a single sentence stating the connection. If none exist, return "none". Be concise. Only state connections that are genuinely useful and non-obvious.`,
        `Query: ${opts.query}\n\nMemories:\n${topFacts}`,
      );
      if (inferenceResult && !inferenceResult.toLowerCase().startsWith("none")) {
        const tokens = estimateTokens(inferenceResult);
        if (usedTokens + tokens <= tokenBudget) {
          blocks.push({
            id: 0, content: inferenceResult.trim(), category: "inference",
            score: 60, source: "inference", tokens,
          });
          usedTokens += tokens;
        }
      }
    } catch {}
  }
  timing.inference_ms = Date.now() - tInference;

  // ---- Assembly: supplementary sections ----
  const tAssembly = Date.now();
  const supplementary: { label: string; content: string }[] = [];

  // Working memory
  if (flags.includeWorkingMemory) {
    try {
      const scratchRows = deps.listScratchEntriesForContext(userId, workingMemorySession);
      const workingMemory = deps.buildWorkingMemoryBlock(scratchRows);
      if (workingMemory) supplementary.push({ label: "working_memory", content: workingMemory });
    } catch {}
  }

  // Current state
  let personalityBlockTokens = 0;
  if (flags.includeCurrentState) {
    try {
      const stateRows = deps.getCurrentState(userId);
      if (stateRows.length > 0) {
        const stateLines = stateRows.map(s =>
          `- ${s.key}: ${s.value}${s.updated_count > 1 ? ` (updated ${s.updated_count}x)` : ""}`
        );
        supplementary.push({ label: "current_state", content: "## Current State\n" + stateLines.join("\n") });
      }
    } catch {}
  }

  // Personality profile
  if (flags.includePersonality) {
    try {
      const pp = deps.getProfileForInjection(userId);
      if (pp) {
        if (pp.isStale) deps.queueResynthesisIfStale(userId);
        const tokens = estimateTokens(pp.profile);
        if (tokens <= tokenBudget * 0.10) {
          supplementary.push({ label: "personality", content: "## Personality\n" + pp.profile });
          personalityBlockTokens = tokens;
          usedTokens += tokens;
        }
      }
    } catch {}
  }

  // User preferences
  if (flags.includePreferences) {
    try {
      const prefRows = deps.getUserPreferences(userId);
      if (prefRows.length > 0) {
        const prefLines = prefRows.map(p => `- [${p.domain}] ${p.preference}`);
        supplementary.push({ label: "preferences", content: "## User Preferences\n" + prefLines.join("\n") });
      }
    } catch {}
  }

  // Structured facts
  if (flags.includeStructuredFacts) {
    try {
      const memIds = blocks.map(b => b.id);
      if (memIds.length > 0) {
        const sfRows = deps.getStructuredFacts(memIds);
        if (sfRows.length > 0) {
          const now = Date.now();
          const STALE_MS = 90 * 24 * 60 * 60 * 1000;
          const scored = sfRows.map((sf: any) => {
            let freshness = 0.5;
            if (sf.valid_at) {
              const ageMs = now - new Date(sf.valid_at).getTime();
              freshness = ageMs < 0 ? 1.0 : Math.max(0.1, 1.0 - ageMs / (365 * 24 * 60 * 60 * 1000));
            } else if (sf.date_approx) {
              const ageMs = now - new Date(sf.date_approx).getTime();
              freshness = ageMs < 0 ? 1.0 : Math.max(0.1, 1.0 - ageMs / (365 * 24 * 60 * 60 * 1000));
            }
            const isStale = sf.valid_at
              ? now - new Date(sf.valid_at).getTime() > STALE_MS
              : false;
            return { sf, freshness, isStale };
          });
          scored.sort((a, b) => b.freshness - a.freshness);

          const sfLines = scored.map(({ sf, isStale }: { sf: any; isStale: boolean }) => {
            let line = `- ${sf.subject} ${sf.verb}`;
            if (sf.object) line += ` ${sf.object}`;
            if (sf.quantity != null) line += ` (qty: ${sf.quantity}${sf.unit ? " " + sf.unit : ""})`;
            if (sf.valid_at) line += ` [${sf.valid_at}]`;
            else if (sf.date_approx) line += ` [${sf.date_approx}]`;
            else if (sf.date_ref) line += ` [${sf.date_ref}]`;
            if (isStale) line += ` [possibly outdated]`;
            return line;
          });
          supplementary.push({ label: "structured_facts", content: "## Extracted Facts\n" + sfLines.join("\n") });
        }
      }
    } catch {}
  }

  const contextString = assembleContextString(blocks, supplementary);
  timing.assembly_ms = Date.now() - tAssembly;
  timing.total_ms = Date.now() - t0;

  // Defer access tracking
  const blockIds = blocks.filter(b => b.id > 0).map(b => b.id);
  deps.trackAccess(blockIds);

  const staticBlocks = blocks.filter(b => b.source === "static");
  const semanticBlocksFinal = blocks.filter(b => b.source === "semantic");
  const evolutionBlocks = blocks.filter(b => b.source === "evolution");
  const episodeBlocks = blocks.filter(b => b.source === "episode");
  const linkedBlocks = blocks.filter(b => b.source === "linked");
  const recentBlocks = blocks.filter(b => b.source === "recent");
  const inferenceBlocks = blocks.filter(b => b.source === "inference");

  return {
    context: contextString,
    blocks: blocks.map(b => ({
      id: b.id,
      category: b.category,
      source: b.source,
      model: b.model || null,
      origin: b.origin || null,
      score: Math.round(b.score * 100) / 100,
      tokens: b.tokens,
    })),
    token_estimate: usedTokens,
    token_budget: tokenBudget,
    utilization: Math.round(usedTokens / tokenBudget * 100) / 100,
    strategy: contextStrategy,
    breakdown: {
      static: staticBlocks.length,
      semantic: semanticBlocksFinal.length,
      evolution: evolutionBlocks.length,
      episode: episodeBlocks.length,
      linked: linkedBlocks.length,
      recent: recentBlocks.length,
      inference: inferenceBlocks.length,
      personality: personalityBlockTokens > 0 ? 1 : 0,
    },
    timing,
  };
}
