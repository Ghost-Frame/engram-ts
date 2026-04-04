// ============================================================================
// CONTEXT DOMAIN - Type definitions
// ============================================================================

/** Context strategy modes */
export type ContextStrategy = "balanced" | "precision" | "breadth";

/** Context mode presets */
export type ContextMode = "fast" | "balanced" | "deep" | "decision";

/** Progressive disclosure depth: 1=core, 2=+semantic, 3=full */
export type ContextDepth = 1 | 2 | 3;

/** Source of a context block */
export type ContextBlockSource =
  | "static"
  | "semantic"
  | "evolution"
  | "episode"
  | "linked"
  | "recent"
  | "inference"
  | "working_memory";

/** A single assembled context block */
export interface ContextBlock {
  id: number;
  content: string;
  category: string;
  score: number;
  source: ContextBlockSource;
  tokens: number;
  created_at?: string;
  model?: string | null;
  origin?: string | null;
}

/** Per-source layer counts in the breakdown */
export interface ContextBreakdown {
  static: number;
  semantic: number;
  evolution: number;
  episode: number;
  linked: number;
  recent: number;
  inference: number;
  personality: number;
}

/** Timing info per phase (milliseconds) */
export interface ContextTiming {
  embed_ms?: number;
  static_ms?: number;
  search_ms?: number;
  rerank_ms?: number;
  semantic_ms?: number;
  evolution_ms?: number;
  episodes_ms?: number;
  linked_ms?: number;
  recent_ms?: number;
  inference_ms?: number;
  assembly_ms?: number;
  total_ms?: number;
  [key: string]: number | undefined;
}

/** Input options for context assembly */
export interface ContextOptions {
  query: string;
  /** Raw token budget alias - accepts max_tokens, token_budget, or budget */
  max_tokens?: number;
  token_budget?: number;
  budget?: number;
  /** Context strategy: balanced | precision | breadth */
  strategy?: ContextStrategy;
  /** Progressive disclosure depth (1-3) */
  depth?: number;
  /** Mode preset (overrides depth/max_tokens defaults) */
  mode?: ContextMode;

  // Layer toggles
  include_static?: boolean;
  include_recent?: boolean;
  include_episodes?: boolean;
  include_linked?: boolean;
  include_inference?: boolean;
  include_current_state?: boolean;
  include_preferences?: boolean;
  include_structured_facts?: boolean;
  include_working_memory?: boolean;

  // Benchmark/tuning overrides
  max_memory_tokens?: number;
  dedup_threshold?: number;
  min_relevance?: number;
  semantic_ceiling?: number;
  semantic_limit?: number;

  // Source filtering
  source?: string;
  /** Working memory session ID */
  session?: string;
}

/** The assembled context result */
export interface ContextResult {
  context: string;
  blocks: Array<{
    id: number;
    category: string;
    source: ContextBlockSource;
    model: string | null;
    origin: string | null;
    score: number;
    tokens: number;
  }>;
  token_estimate: number;
  token_budget: number;
  utilization: number;
  strategy: ContextStrategy;
  breakdown: ContextBreakdown;
  timing: ContextTiming;
}

/** Internal layer configuration */
export interface ContextLayerConfig {
  name: ContextBlockSource;
  budgetFraction: number;
  enabled: boolean;
}

/** Default token budget when none supplied */
export const DEFAULT_TOKEN_BUDGET = 8000;

/** Absolute cap on token budget */
export const MAX_TOKEN_BUDGET = 64000;

/** Default max tokens per individual memory block */
export const DEFAULT_MAX_MEMORY_TOKENS = 1500;

/** Default cosine similarity deduplication threshold */
export const DEFAULT_DEDUP_THRESHOLD = 0.88;

/** Default minimum relevance score for semantic results */
export const DEFAULT_MIN_RELEVANCE = 0.55;

/** Default semantic ceiling (fraction of total budget) */
export const DEFAULT_SEMANTIC_CEILING_BALANCED = 0.80;
export const DEFAULT_SEMANTIC_CEILING_PRECISION = 0.82;
export const DEFAULT_SEMANTIC_CEILING_BREADTH = 0.90;

/** Recency boost window: memories within this age get +10% score */
export const RECENCY_BOOST_MS = 48 * 60 * 60 * 1000;

/** Static fact budget fractions per strategy */
export const STATIC_BUDGET_BALANCED = 0.3;
export const STATIC_BUDGET_PRECISION = 0.2;
