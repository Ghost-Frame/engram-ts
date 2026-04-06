// ============================================================================
// CONTEXT DOMAIN - Mode preset resolution and strategy helpers
// ============================================================================

import type { ContextOptions, ContextStrategy } from "./types.ts";
import {
  DEFAULT_SEMANTIC_CEILING_BALANCED,
  DEFAULT_SEMANTIC_CEILING_PRECISION,
  DEFAULT_SEMANTIC_CEILING_BREADTH,
  STATIC_BUDGET_BALANCED,
  STATIC_BUDGET_PRECISION,
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
