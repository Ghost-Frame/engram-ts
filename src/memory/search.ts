// ============================================================================
// MEMORY SEARCH - Hybrid semantic + full-text
// ============================================================================

import { log } from "../config/logger.ts";
import {
  RERANKER_TOP_K,
  AUTO_LINK_THRESHOLD,
  AUTO_LINK_MAX,
  SEARCH_FACT_VECTOR_FLOOR,
  SEARCH_PREFERENCE_VECTOR_FLOOR,
  SEARCH_REASONING_VECTOR_FLOOR,
  SEARCH_GENERALIZATION_VECTOR_FLOOR,
  SEARCH_PERSONALITY_MIN_SCORE,
} from "../config/index.ts";
import { db, searchMemoriesFTS, getMemoryWithoutEmbedding, getVersionChainForUser, getLinksForUser, insertLink } from "../db/index.ts";
import { embed, cosineSimilarity, getCachedEmbeddings } from "../embeddings/index.ts";
import { calculateDecayScore } from "../fsrs/index.ts";
import { sanitizeFTS } from "../helpers/index.ts";

export type QuestionType = "fact_recall" | "preference" | "reasoning" | "generalization" | "temporal";

export interface RetrievalDiagnostics {
  question_type: QuestionType;
  reranked: boolean;
  reranker_ms: number;
  candidate_count: number;
}

export interface HybridSearchOptions {
  vectorFloor?: number;
  questionType?: QuestionType;
  question_type?: QuestionType;
  expandRelationships?: boolean;
  includePersonalitySignals?: boolean;
}

interface SearchResult {
  id: number;
  content: string;
  category: string;
  source?: string;
  model?: string | null;
  importance: number;
  created_at: string;
  score: number;
  decay_score?: number;
  version?: number;
  is_latest?: boolean;
  is_static?: boolean;
  source_count?: number;
  root_memory_id?: number;
  tags?: string[];
  access_count?: number;
  episode_id?: number;
  combined_score?: number;
  semantic_score?: number;
  ce_score?: number;
  rerank_score?: number;
  personality_signal_score?: number;
  question_type?: QuestionType;
  reranked?: boolean;
  reranker_ms?: number;
  candidate_count?: number;
  linked?: Array<{ id: number; content: string; category: string; similarity: number; type: string }>;
  version_chain?: Array<{ id: number; content: string; version: number; is_latest: boolean }>;
}

interface SearchStrategy {
  vectorFloor: number;
  vectorWeight: number;
  ftsWeight: number;
  candidateMultiplier: number;
  ftsLimitMultiplier: number;
  expandRelationships: boolean;
  relationshipSeedLimit: number;
  hop1Limit: number;
  hop2Limit: number;
  relationshipMultiplier: number;
  includePersonalitySignals: boolean;
  personalityLimit: number;
  personalityWeight: number;
}

interface PersonalitySignalCandidate {
  id: number;
  content: string;
  category: string;
  source: string;
  importance: number;
  created_at: string;
  version: number;
  is_latest: boolean;
  root_memory_id: number | null;
  source_count: number;
  is_static: boolean;
  model: string | null;
  signal_type: string;
  subject: string;
  valence: string;
  intensity: number;
  reasoning: string | null;
  source_text: string | null;
}

const DEFAULT_VECTOR_FLOOR = 0.15;

const QUESTION_STRATEGIES: Record<QuestionType, SearchStrategy> = {
  fact_recall: {
    vectorFloor: SEARCH_FACT_VECTOR_FLOOR,
    vectorWeight: 0.62,
    ftsWeight: 0.32,
    candidateMultiplier: 2,
    ftsLimitMultiplier: 2,
    expandRelationships: false,
    relationshipSeedLimit: 3,
    hop1Limit: 4,
    hop2Limit: 0,
    relationshipMultiplier: 0.75,
    includePersonalitySignals: false,
    personalityLimit: 0,
    personalityWeight: 0,
  },
  preference: {
    vectorFloor: SEARCH_PREFERENCE_VECTOR_FLOOR,
    vectorWeight: 0.52,
    ftsWeight: 0.30,
    candidateMultiplier: 3,
    ftsLimitMultiplier: 4,
    expandRelationships: true,
    relationshipSeedLimit: 5,
    hop1Limit: 8,
    hop2Limit: 4,
    relationshipMultiplier: 1.0,
    includePersonalitySignals: true,
    personalityLimit: 24,
    personalityWeight: 0.18,
  },
  reasoning: {
    vectorFloor: SEARCH_REASONING_VECTOR_FLOOR,
    vectorWeight: 0.5,
    ftsWeight: 0.26,
    candidateMultiplier: 4,
    ftsLimitMultiplier: 5,
    expandRelationships: true,
    relationshipSeedLimit: 6,
    hop1Limit: 10,
    hop2Limit: 6,
    relationshipMultiplier: 1.2,
    includePersonalitySignals: true,
    personalityLimit: 30,
    personalityWeight: 0.14,
  },
  generalization: {
    vectorFloor: SEARCH_GENERALIZATION_VECTOR_FLOOR,
    vectorWeight: 0.48,
    ftsWeight: 0.24,
    candidateMultiplier: 5,
    ftsLimitMultiplier: 6,
    expandRelationships: true,
    relationshipSeedLimit: 8,
    hop1Limit: 12,
    hop2Limit: 8,
    relationshipMultiplier: 1.35,
    includePersonalitySignals: true,
    personalityLimit: 36,
    personalityWeight: 0.2,
  },
  temporal: {
    vectorFloor: 0.10,             // low floor: cast wide net
    vectorWeight: 0.35,            // lower vector weight (date matching matters more)
    ftsWeight: 0.35,               // higher FTS (date terms appear in content)
    candidateMultiplier: 4,
    ftsLimitMultiplier: 5,
    expandRelationships: true,     // follow chains to find temporal sequences
    relationshipSeedLimit: 6,
    hop1Limit: 10,
    hop2Limit: 4,
    relationshipMultiplier: 1.2,
    includePersonalitySignals: false,
    personalityLimit: 0,
    personalityWeight: 0,
  },
};

let personalitySignalsTableAvailable: boolean | null = null;
let personalitySignalSearchStatement: ReturnType<typeof db.prepare> | null = null;

function hasPersonalitySignalsTable(): boolean {
  if (personalitySignalsTableAvailable != null) return personalitySignalsTableAvailable;
  try {
    const row = db.prepare(
      `SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = 'personality_signals' LIMIT 1`
    ).get() as { ok?: number } | undefined;
    personalitySignalsTableAvailable = !!row?.ok;
  } catch {
    personalitySignalsTableAvailable = false;
  }
  return personalitySignalsTableAvailable;
}

function getPersonalitySignalStatement() {
  if (!hasPersonalitySignalsTable()) return null;
  if (!personalitySignalSearchStatement) {
    personalitySignalSearchStatement = db.prepare(
      `SELECT ps.memory_id as id, m.content, m.category, m.source, m.importance, m.created_at,
         m.version, m.is_latest, m.root_memory_id, m.source_count, m.is_static, m.model,
         ps.signal_type, ps.subject, ps.valence, ps.intensity, ps.reasoning, ps.source_text
       FROM personality_signals ps
       JOIN memories m ON m.id = ps.memory_id
       WHERE ps.user_id = ?
         AND m.user_id = ?
         AND m.is_forgotten = 0
         AND m.is_archived = 0
         AND m.status != 'pending'
         AND (? = 0 OR m.is_latest = 1)
       ORDER BY ps.intensity DESC, m.created_at DESC
       LIMIT ?`
    );
  }
  return personalitySignalSearchStatement;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenizeQuery(query: string): string[] {
  return Array.from(new Set(
    normalizeText(query)
      .split(" ")
      .filter(token => token.length >= 3)
  ));
}

function mergeSearchOptions(
  expandRelationships: boolean,
  vectorFloorOrOptions: number | HybridSearchOptions | undefined,
  query: string,
): { questionType: QuestionType; strategy: SearchStrategy } {
  const options = typeof vectorFloorOrOptions === "number"
    ? { vectorFloor: vectorFloorOrOptions }
    : (vectorFloorOrOptions || {});
  const questionType = options.questionType || options.question_type || classifyQuestion(query);
  const base = QUESTION_STRATEGIES[questionType];
  const strategy: SearchStrategy = {
    ...base,
    vectorFloor: options.vectorFloor ?? base.vectorFloor ?? DEFAULT_VECTOR_FLOOR,
    expandRelationships: (options.expandRelationships ?? expandRelationships) && base.expandRelationships,
    includePersonalitySignals: options.includePersonalitySignals ?? base.includePersonalitySignals,
  };
  return { questionType, strategy };
}

function applyDiagnostics(results: SearchResult[], diagnostics: RetrievalDiagnostics): SearchResult[] {
  for (const result of results) {
    result.question_type = diagnostics.question_type;
    result.reranked = diagnostics.reranked;
    result.reranker_ms = diagnostics.reranker_ms;
    result.candidate_count = diagnostics.candidate_count;
  }
  return results;
}

function scoreSignalMatch(query: string, signal: PersonalitySignalCandidate): number {
  const haystack = normalizeText([
    signal.subject,
    signal.reasoning || "",
    signal.source_text || "",
    signal.content,
  ].join(" "));
  const normalizedQuery = normalizeText(query);
  const tokens = tokenizeQuery(query);
  if (!haystack) return 0;

  let score = 0;
  if (normalizedQuery && haystack.includes(normalizedQuery)) score += 0.45;
  const normalizedSubject = normalizeText(signal.subject || "");
  if (normalizedSubject && normalizedQuery && normalizedSubject.split(" ").some(token => token && normalizedQuery.includes(token))) {
    score += 0.05;
  }

  if (tokens.length > 0) {
    const matched = tokens.filter(token => haystack.includes(token)).length;
    score += (matched / tokens.length) * 0.35;
  }

  score += Math.max(0, Math.min(signal.intensity || 0, 1)) * 0.2;

  return Math.min(score, 1);
}

async function searchPersonalitySignals(
  query: string,
  userId: number,
  latestOnly: boolean,
  limit: number,
): Promise<Array<SearchResult & { personality_signal_score: number }>> {
  const stmt = getPersonalitySignalStatement();
  if (!stmt || limit <= 0) return [];

  try {
    const rawRows = stmt.all(userId, userId, latestOnly ? 1 : 0, Math.max(limit * 3, 24)) as PersonalitySignalCandidate[];
    const deduped = new Map<number, SearchResult & { personality_signal_score: number }>();

    for (const row of rawRows) {
      const relevance = scoreSignalMatch(query, row);
      if (relevance < SEARCH_PERSONALITY_MIN_SCORE) continue;

      const existing = deduped.get(row.id);
      const scored: SearchResult & { personality_signal_score: number } = {
        id: row.id,
        content: row.content,
        category: row.category,
        source: row.source,
        model: row.model || undefined,
        importance: row.importance,
        created_at: row.created_at,
        score: relevance,
        version: row.version,
        is_latest: !!row.is_latest,
        is_static: !!row.is_static,
        source_count: row.source_count || 1,
        root_memory_id: row.root_memory_id || undefined,
        personality_signal_score: relevance,
      };

      if (!existing || scored.personality_signal_score > existing.personality_signal_score) {
        deduped.set(row.id, scored);
      }
    }

    return Array.from(deduped.values())
      .sort((a, b) => b.personality_signal_score - a.personality_signal_score)
      .slice(0, limit);
  } catch (e: any) {
    log.warn({ msg: "personality_signal_search_failed", error: e.message });
    return [];
  }
}

// Extract date reference from a query (for temporal boost)
export function extractQueryDate(query: string): string | null {
  const q = query.toLowerCase();

  // Absolute dates: "march 2026", "2026-03-16", "03/16", "january 15"
  const isoMatch = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  const monthDayMatch = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/);
  if (monthDayMatch) {
    const months: Record<string, string> = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };
    const year = monthDayMatch[3] || new Date().getFullYear().toString();
    return `${year}-${months[monthDayMatch[1]]}-${monthDayMatch[2].padStart(2, "0")}`;
  }

  // Relative: "yesterday", "last week", "2 days ago", etc.
  const now = new Date();
  if (/\byesterday\b/.test(q)) { now.setDate(now.getDate() - 1); return now.toISOString().slice(0, 10); }
  if (/\blast week\b/.test(q)) { now.setDate(now.getDate() - 7); return now.toISOString().slice(0, 10); }
  if (/\blast month\b/.test(q)) { now.setMonth(now.getMonth() - 1); return now.toISOString().slice(0, 10); }
  if (/\btoday\b/.test(q)) return now.toISOString().slice(0, 10);

  const agoMatch = q.match(/\b(\d+)\s+(days?|weeks?|months?)\s+ago\b/);
  if (agoMatch) {
    const num = parseInt(agoMatch[1]);
    const unit = agoMatch[2];
    if (unit.startsWith("day")) now.setDate(now.getDate() - num);
    else if (unit.startsWith("week")) now.setDate(now.getDate() - num * 7);
    else if (unit.startsWith("month")) now.setMonth(now.getMonth() - num);
    return now.toISOString().slice(0, 10);
  }

  return null;
}

export function classifyQuestion(query: string): QuestionType {
  const q = query.toLowerCase();

  // Temporal queries: explicit time references or sequence questions
  if (/\b(when did|when was|what happened (?:on|in|during|before|after)|timeline|sequence|history of|over the past|between .* and|from .* to|at what time|how long ago|since when)\b/.test(q)) {
    return "temporal";
  }
  // Also temporal if the query contains a date reference
  if (extractQueryDate(query) !== null && /\b(what|who|how|which|did)\b/.test(q)) {
    return "temporal";
  }

  if (/\b(recently|attended|joined|last time|went to|visited|started|stopped|what happened first|what happened after)\b/.test(q)) {
    return "fact_recall";
  }
  if (/\b(why did|what made|decided|reasons?|because|why do|why does)\b/.test(q)) {
    return "reasoning";
  }
  if (/\b(should i|do you think|considering|would i|could i|is it .* for me|does it make sense for me)\b/.test(q)) {
    return "generalization";
  }
  if (/\b(suggest|recommend|what would|ideas|what .* try|what .* explore|weekend|fit me|aligned)\b/.test(q)) {
    return "preference";
  }
  return "preference";
}

export async function hybridSearch(
  query: string,
  limit: number = 10,
  includeLinks: boolean = false,
  expandRelationships: boolean = false,
  latestOnly: boolean = true,
  userId: number = 1,
  vectorFloorOrOptions: number | HybridSearchOptions = DEFAULT_VECTOR_FLOOR,
): Promise<SearchResult[]> {
  const results = new Map<number, SearchResult>();
  const { questionType, strategy } = mergeSearchOptions(expandRelationships, vectorFloorOrOptions, query);
  const candidateTarget = Math.max(
    limit,
    Math.min(200, Math.max(limit * strategy.candidateMultiplier, RERANKER_TOP_K))
  );
  const ftsLimit = Math.max(limit, Math.min(250, limit * strategy.ftsLimitMultiplier));

  // Ranked lists for RRF fusion - each source produces its own ranked list
  const vectorRanked: Array<{ id: number; rawScore: number }> = [];
  const ftsRanked: Array<{ id: number; rawScore: number }> = [];
  const personalityRanked: Array<{ id: number; rawScore: number }> = [];
  const graphRanked: Array<{ id: number; rawScore: number }> = [];

  // 1. Vector search - in-memory cosine similarity (<1ms for 800 memories)
  try {
    const queryEmb = await embed(query);
    const cached = getCachedEmbeddings(latestOnly, userId);
    for (const mem of cached) {
      if (mem.user_id !== userId) continue;
      const sim = cosineSimilarity(queryEmb, mem.embedding);
      if (sim > strategy.vectorFloor) {
        vectorRanked.push({ id: mem.id, rawScore: sim });
        if (!results.has(mem.id)) {
          results.set(mem.id, {
            id: mem.id,
            content: mem.content,
            category: mem.category,
            importance: mem.importance,
            created_at: "",
            score: 0,
            semantic_score: sim,
            is_static: !!mem.is_static,
            source_count: mem.source_count || 1,
          });
        }
      }
    }
  } catch (e: any) {
    log.error({ msg: "vector_search_failed", error: e.message });
  }

  // Sort vector results by similarity descending for RRF ranking
  vectorRanked.sort((a, b) => b.rawScore - a.rawScore);

  // 2. FTS5 keyword search
  const sanitized = sanitizeFTS(query);
  if (sanitized) {
    try {
      const ftsResults = searchMemoriesFTS.all(sanitized, userId, Math.max(candidateTarget, ftsLimit)) as Array<{
        id: number;
        content: string;
        category: string;
        source: string;
        session_id: string;
        importance: number;
        created_at: string;
        fts_rank: number;
        version: number;
        is_latest: boolean;
        parent_memory_id: number;
        root_memory_id: number;
        source_count: number;
        is_static: boolean;
        is_forgotten: boolean;
        is_inference: boolean;
        model: string | null;
      }>;

      for (const r of ftsResults) {
        if (latestOnly && !r.is_latest) continue;
        ftsRanked.push({ id: r.id, rawScore: Math.abs(r.fts_rank) });
        const existing = results.get(r.id);
        if (existing) {
          existing.created_at = r.created_at;
          existing.source = r.source;
          existing.model = r.model || undefined;
          existing.version = r.version;
          existing.is_latest = !!r.is_latest;
          existing.root_memory_id = r.root_memory_id;
        } else {
          results.set(r.id, {
            id: r.id,
            content: r.content,
            category: r.category,
            source: r.source,
            model: r.model || undefined,
            importance: r.importance,
            created_at: r.created_at,
            score: 0,
            version: r.version,
            is_latest: !!r.is_latest,
            is_static: !!r.is_static,
            source_count: r.source_count || 1,
            root_memory_id: r.root_memory_id,
          });
        }
      }
    } catch {
      // best effort
    }
  }

  // FTS results already ranked by BM25 rank (fts_rank) from SQLite, preserve order
  // ftsRanked is already in descending relevance order from FTS5

  // 3. Personality signal supplementation
  if (strategy.includePersonalitySignals) {
    const personalityResults = await searchPersonalitySignals(query, userId, latestOnly, strategy.personalityLimit);
    for (const signalResult of personalityResults) {
      personalityRanked.push({ id: signalResult.id, rawScore: signalResult.personality_signal_score });
      const existing = results.get(signalResult.id);
      if (existing) {
        existing.personality_signal_score = Math.max(existing.personality_signal_score || 0, signalResult.personality_signal_score);
        existing.created_at = existing.created_at || signalResult.created_at;
        existing.source = existing.source || signalResult.source;
        existing.model = existing.model || signalResult.model;
        existing.version = existing.version || signalResult.version;
        existing.is_latest = existing.is_latest ?? signalResult.is_latest;
        existing.is_static = existing.is_static ?? signalResult.is_static;
        existing.source_count = Math.max(existing.source_count || 1, signalResult.source_count || 1);
        existing.root_memory_id = existing.root_memory_id || signalResult.root_memory_id;
      } else {
        results.set(signalResult.id, {
          ...signalResult,
          score: 0,
          combined_score: 0,
        });
      }
    }
  }

  // personalityRanked already sorted by score from searchPersonalitySignals

  // 4. RRF Fusion: score(d) = sum_over_sources(1 / (k + rank))
  // k=60 is the standard constant from the RRF paper (Cormack et al. 2009)
  const RRF_K = 60;

  // Build rank maps from each source
  const rrfScores = new Map<number, number>();

  for (let rank = 0; rank < vectorRanked.length; rank++) {
    const id = vectorRanked[rank].id;
    rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (RRF_K + rank + 1));
  }
  for (let rank = 0; rank < ftsRanked.length; rank++) {
    const id = ftsRanked[rank].id;
    rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (RRF_K + rank + 1));
  }
  for (let rank = 0; rank < personalityRanked.length; rank++) {
    const id = personalityRanked[rank].id;
    rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (RRF_K + rank + 1));
  }

  // Temporal boost: extract date from query for temporal question types
  const queryDate = questionType === "temporal" ? extractQueryDate(query) : null;

  // Apply RRF scores + decay/importance boosts
  for (const r of results.values()) {
    const rrf = rrfScores.get(r.id) || 0;

    const decayScore = calculateDecayScore(
      r.importance,
      r.created_at,
      (r as any).access_count || 0,
      null,
      !!r.is_static,
      r.source_count || 1,
    );
    r.decay_score = Math.round(decayScore * 1000) / 1000;

    // RRF base score + small multiplicative boosts for decay, source_count, static
    const decayBoost = 1 + (decayScore / 10) * 0.1;
    const sourceBoost = 1 + Math.min((r.source_count || 1) / 10, 1) * 0.05;
    const staticBoost = r.is_static ? 1.03 : 1;

    // Temporal proximity boost: memories created near the query date get boosted
    let temporalBoost = 1.0;
    if (queryDate && r.created_at) {
      try {
        const qd = new Date(queryDate).getTime();
        const md = new Date(r.created_at).getTime();
        if (!isNaN(qd) && !isNaN(md)) {
          const daysDiff = Math.abs(qd - md) / (1000 * 60 * 60 * 24);
          // Gaussian-like boost: 1.5x for same day, decays to 1.0x at ~14 days
          temporalBoost = 1.0 + 0.5 * Math.exp(-(daysDiff * daysDiff) / (2 * 7 * 7));
        }
      } catch {}
    }

    r.score = rrf * decayBoost * sourceBoost * staticBoost * temporalBoost;
    r.combined_score = r.score;
  }

  // 5. Relationship expansion (2-hop) - feeds into graph RRF channel
  if (strategy.expandRelationships) {
    const topIds = Array.from(results.entries())
      .sort((a, b) => (b[1].combined_score || b[1].score) - (a[1].combined_score || a[1].score))
      .slice(0, strategy.relationshipSeedLimit)
      .map(([id]) => id);

    const hop1Ids: number[] = [];
    for (const id of topIds) {
      const links = getLinksForUser.all(id, userId, id, userId) as Array<{
        id: number;
        similarity: number;
        type: string;
        content: string;
        category: string;
        importance: number;
        created_at: string;
        is_latest: boolean;
        is_forgotten: boolean;
        version: number;
        source_count: number;
        model?: string | null;
        source?: string;
      }>;

      let added = 0;
      for (const link of links) {
        if (added >= strategy.hop1Limit) break;
        if (link.is_forgotten) continue;
        // Type-aware weighting: causal/update links score higher than similarity
        const typeWeight = link.type === "caused_by" || link.type === "causes"
          ? 2.0
          : link.type === "updates" || link.type === "corrects"
            ? 1.5
            : link.type === "extends" || link.type === "contradicts"
              ? 1.3
              : 1.0;
        const graphScore = link.similarity * typeWeight * strategy.relationshipMultiplier;
        graphRanked.push({ id: link.id, rawScore: graphScore });
        if (!results.has(link.id)) {
          results.set(link.id, {
            id: link.id,
            content: link.content,
            category: link.category,
            source: link.source,
            model: link.model || undefined,
            importance: link.importance,
            created_at: link.created_at,
            score: 0,
            combined_score: 0,
            version: link.version,
            is_latest: !!link.is_latest,
            source_count: link.source_count || 1,
          });
          hop1Ids.push(link.id);
          added++;
        }
      }
    }

    for (const id of hop1Ids.slice(0, strategy.hop2Limit)) {
      const links2 = getLinksForUser.all(id, userId, id, userId) as Array<{
        id: number;
        similarity: number;
        type: string;
        content: string;
        category: string;
        importance: number;
        created_at: string;
        is_latest: boolean;
        is_forgotten: boolean;
        version: number;
        source_count: number;
        model?: string | null;
        source?: string;
      }>;
      for (const link of links2) {
        if (link.is_forgotten) continue;
        const typeWeight = link.type === "caused_by" || link.type === "causes" ? 2.0
          : link.type === "updates" || link.type === "corrects" ? 1.5
            : 1.0;
        const graphScore = link.similarity * typeWeight * strategy.relationshipMultiplier * 0.5; // 2nd hop penalty
        graphRanked.push({ id: link.id, rawScore: graphScore });
        if (!results.has(link.id)) {
          results.set(link.id, {
            id: link.id,
            content: link.content,
            category: link.category,
            source: link.source,
            model: link.model || undefined,
            importance: link.importance,
            created_at: link.created_at,
            score: 0,
            combined_score: 0,
            version: link.version,
            is_latest: !!link.is_latest,
            source_count: link.source_count || 1,
          });
        }
      }
    }

    // Sort graph results by score and apply RRF for graph channel
    graphRanked.sort((a, b) => b.rawScore - a.rawScore);
    for (let rank = 0; rank < graphRanked.length; rank++) {
      const id = graphRanked[rank].id;
      const r = results.get(id);
      if (r) {
        r.score += 1 / (RRF_K + rank + 1);
        r.combined_score = r.score;
      }
    }
  }

  // 6. Guard against NaN scores, sort, and limit
  for (const r of results.values()) {
    if (Number.isNaN(r.score)) r.score = 0;
    if (r.decay_score != null && Number.isNaN(r.decay_score)) r.decay_score = 0;
    r.combined_score = Number.isNaN(r.combined_score as number) ? r.score : (r.combined_score || r.score);
  }

  const sortedAll = Array.from(results.values()).sort((a, b) => (b.combined_score || b.score) - (a.combined_score || a.score));
  const candidateCount = sortedAll.length;
  let sorted = sortedAll.slice(0, limit);

  // 7. Fill missing fields (always fetch model since it's not in the embedding cache)
  for (const r of sorted) {
    if (!r.created_at || !r.version || r.model === undefined) {
      const mem = getMemoryWithoutEmbedding.get(r.id) as any;
      if (mem) {
        r.created_at = r.created_at || mem.created_at;
        r.source = r.source || mem.source;
        r.model = mem.model || null;
        r.version = r.version || mem.version;
        r.is_latest = r.is_latest ?? !!mem.is_latest;
        r.is_static = r.is_static ?? !!mem.is_static;
        r.source_count = r.source_count || mem.source_count;
        r.root_memory_id = r.root_memory_id || mem.root_memory_id;
      }
    }
  }

  // 8. Include linked memories + version chain
  if (includeLinks) {
    for (const r of sorted) {
      const links = getLinksForUser.all(r.id, userId, r.id, userId) as Array<{
        id: number;
        similarity: number;
        type: string;
        content: string;
        category: string;
        importance: number;
        created_at: string;
        is_latest: boolean;
        is_forgotten: boolean;
        version: number;
        source_count: number;
      }>;
      if (links.length > 0) {
        r.linked = links
          .filter(l => !l.is_forgotten)
          .map(l => ({
            id: l.id,
            content: l.content,
            category: l.category,
            similarity: Math.round(l.similarity * 1000) / 1000,
            type: l.type,
          }));
      }

      const rootId = r.root_memory_id || r.id;
      const chain = getVersionChainForUser.all(rootId, rootId, userId) as Array<{
        id: number;
        content: string;
        category: string;
        version: number;
        is_latest: boolean;
        created_at: string;
        source_count: number;
      }>;
      if (chain.length > 1) {
        r.version_chain = chain.map(c => ({
          id: c.id,
          content: c.content,
          version: c.version,
          is_latest: !!c.is_latest,
        }));
      }
    }
  }

  return applyDiagnostics(sorted, {
    question_type: questionType,
    reranked: false,
    reranker_ms: 0,
    candidate_count: candidateCount,
  });
}

// ============================================================================
// AUTO-LINKING
// ============================================================================

export async function autoLink(memoryId: number, embedding: Float32Array, userId?: number): Promise<number> {
  const similarities: Array<{ id: number; similarity: number }> = [];
  const ownerId = userId ?? (getMemoryWithoutEmbedding.get(memoryId) as any)?.user_id;
  const cached = getCachedEmbeddings(true, ownerId);
  for (const mem of cached) {
    if (mem.id === memoryId) continue;
    const sim = cosineSimilarity(embedding, mem.embedding);
    if (sim >= AUTO_LINK_THRESHOLD) similarities.push({ id: mem.id, similarity: sim });
  }

  similarities.sort((a, b) => b.similarity - a.similarity);
  const toLink = similarities.slice(0, AUTO_LINK_MAX);

  let linked = 0;
  for (const { id, similarity } of toLink) {
    insertLink.run(memoryId, id, similarity, "similarity");
    insertLink.run(id, memoryId, similarity, "similarity");
    linked++;
  }

  return linked;
}

// ============================================================================
