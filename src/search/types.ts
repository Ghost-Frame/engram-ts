// ============================================================================
// SEARCH DOMAIN -- Type definitions and constants
// ============================================================================

/** Available search mode presets */
export type SearchMode = "fact" | "timeline" | "preference" | "decision" | "recent";

/** Configuration applied by a search mode preset */
export interface SearchModeConfig {
  vector_floor?: number;
  limit?: number;
  temporal_sort?: "asc" | "desc";
  include_episodes?: boolean;
  expand_relationships?: boolean;
  include_links?: boolean;
}

/**
 * Search mode presets: opinionated defaults to reduce cognitive load.
 *
 * fact (default): standard hybrid search for factual recall
 * timeline: chronological ordering, broader results
 * preference: lower vector floor, targets user preferences/values
 * decision: focuses on decisions/corrections with version history
 * recent: last 24h only, sorted by time
 */
export const SEARCH_MODES: Record<SearchMode, SearchModeConfig> = {
  fact: {
    vector_floor: undefined,
    limit: undefined,
    temporal_sort: undefined,
  },
  timeline: {
    temporal_sort: "desc",
    limit: 20,
    vector_floor: 0.15,
  },
  preference: {
    vector_floor: 0.10,
    include_episodes: true,
  },
  decision: {
    expand_relationships: true,
    include_links: true,
  },
  recent: {
    temporal_sort: "desc",
    limit: 15,
  },
};

/** Source label for a recall layer */
export type RecallSource = "static" | "semantic" | "important" | "recent";

/** A single entry in the recall result set with its layer metadata */
export interface RecallEntry {
  memory: any;
  score: number;
  source: RecallSource;
}

/** Breakdown of recall layer counts */
export interface RecallBreakdown {
  static: number;
  semantic: number;
  important: number;
  recent: number;
}
