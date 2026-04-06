// ============================================================================
// CONTEXT DOMAIN - Re-exports (thin coordinator)
// ============================================================================

// Types and constants from types.ts
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

// Budget utilities
export { estimateTokens, truncateToTokenBudget } from "./budget.ts";

// Scoring utilities
export { cosineSimilarity } from "./scoring.ts";

// Attribution
export { buildAttribution } from "./attribution.ts";

// Mode preset resolution and strategy helpers
export type { LayerFlags } from "./modes.ts";
export {
  applyContextMode,
  resolveLayerFlags,
  resolveSemanticCeiling,
  resolveSemanticLimit,
  resolveStaticBudgetFraction,
} from "./modes.ts";

// Assembly
export type { ContextDeps } from "./assembly.ts";
export { assembleContextString, assembleContext } from "./assembly.ts";
