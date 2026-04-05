// ============================================================================
// INTELLIGENCE FALLBACK DISPATCHER - Tier routing for LLM-free operation
// Routes decomposition, signal extraction, and profile synthesis to the
// appropriate tier based on ENGRAM_INTELLIGENCE_TIER env var or auto-detection.
//
// Tier chain: LLM -> Gemini CLI -> Rule-based NLP (Tier 2) -> Template (Tier 3)
// ============================================================================

import { isLocalModelAvailable } from "../llm/local.ts";
import { log } from "../config/logger.ts";
import { INTELLIGENCE_TIER } from "../config/index.ts";
import type { DecompositionResult } from "./decomposition.ts";
import type { PersonalitySignal } from "./personality.ts";
import { decomposeTemplate, decomposeRuleBased } from "./decomposition-fallback.ts";
import {
  extractSignalsTemplate,
  extractSignalsRuleBased,
  synthesizeProfileTemplate,
  synthesizeProfileRuleBased,
} from "./personality-fallback.ts";

export type IntelligenceTier = "auto" | "llm" | "rules" | "template";

function currentTier(): "llm" | "rules" | "template" {
  if (INTELLIGENCE_TIER === "llm") return "llm";
  if (INTELLIGENCE_TIER === "rules") return "rules";
  if (INTELLIGENCE_TIER === "template") return "template";
  // auto: try LLM first, fall through
  if (isLocalModelAvailable()) return "llm";
  return "rules"; // Default to rules when LLM unavailable
}

/**
 * Get the model tag for quality tracking.
 */
export function tierModelTag(): string {
  const tier = currentTier();
  if (tier === "llm") return "llm";
  if (tier === "rules") return "tier2-rules";
  return "tier3-template";
}

/**
 * Fallback decomposition. Called when LLM + Gemini CLI both fail.
 * Returns null only if content is truly undecomposable.
 */
export function getFallbackDecomposition(content: string): DecompositionResult | null {
  const tier = currentTier();

  if (tier === "rules") {
    try {
      const result = decomposeRuleBased(content);
      if (!result.skip && result.facts.length > 0) {
        log.debug({ msg: "decomposition_fallback_tier2", facts: result.facts.length });
        return result;
      }
    } catch (e: any) {
      log.warn({ msg: "decomposition_tier2_failed", error: e.message });
    }
  }

  // Tier 3 fallback (or if tier === "template")
  try {
    const result = decomposeTemplate(content);
    log.debug({ msg: "decomposition_fallback_tier3", facts: result.facts.length, skip: result.skip });
    return result;
  } catch (e: any) {
    log.warn({ msg: "decomposition_tier3_failed", error: e.message });
    return null;
  }
}

/**
 * Fallback signal extraction. Called when LLM is unavailable.
 */
export function getFallbackSignals(content: string): PersonalitySignal[] {
  const tier = currentTier();

  if (tier === "rules") {
    try {
      const signals = extractSignalsRuleBased(content);
      log.debug({ msg: "signals_fallback_tier2", count: signals.length });
      return signals;
    } catch (e: any) {
      log.warn({ msg: "signals_tier2_failed", error: e.message });
    }
  }

  // Tier 3 fallback
  try {
    const signals = extractSignalsTemplate(content);
    log.debug({ msg: "signals_fallback_tier3", count: signals.length });
    return signals;
  } catch (e: any) {
    log.warn({ msg: "signals_tier3_failed", error: e.message });
    return [];
  }
}

/**
 * Fallback profile synthesis. Called when LLM is unavailable.
 */
export function getFallbackProfile(
  signals: Array<{
    signal_type: string;
    subject: string;
    valence: string;
    intensity: number;
    reasoning: string | null;
    source_text: string | null;
  }>,
  preferences: Array<{ domain: string; preference: string; strength: number }>,
  facts: Array<{ subject: string; verb: string; object: string }>,
  staticMemories: Array<{ content: string }>,
): string {
  const tier = currentTier();
  const input = { signals, preferences, facts, staticMemories };

  if (tier === "rules") {
    try {
      const profile = synthesizeProfileRuleBased(input);
      log.debug({ msg: "profile_fallback_tier2", length: profile.length });
      return profile;
    } catch (e: any) {
      log.warn({ msg: "profile_tier2_failed", error: e.message });
    }
  }

  // Tier 3 fallback
  try {
    const profile = synthesizeProfileTemplate(input);
    log.debug({ msg: "profile_fallback_tier3", length: profile.length });
    return profile;
  } catch (e: any) {
    log.warn({ msg: "profile_tier3_failed", error: e.message });
    return "Profile synthesis unavailable.";
  }
}
