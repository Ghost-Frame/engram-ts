// ============================================================================
// INTELLIGENCE DOMAIN - Type definitions and constants
// ============================================================================

/** Valid reflection period values */
export type ReflectionPeriod = "day" | "week" | "month";

/** Stored reflection row from the reflections table */
export interface Reflection {
  id: number;
  user_id: number;
  content: string;
  themes: string; // JSON string array
  period_start: string;
  period_end: string;
  memory_count: number;
  source_memory_ids?: string; // JSON number array
  created_at: string;
}

/** Parsed reflection returned to the API consumer */
export interface ReflectionResponse {
  id: number;
  memory_id?: number;
  reflection: string;
  themes: string[];
  progress?: string[];
  patterns?: string[];
  unresolved?: string[];
  insight?: string | null;
  period: { start: string; end: string };
  memories_analyzed?: number;
  cached: boolean;
}

/** A detected contradiction between two memories */
export interface Contradiction {
  memory_a: { id: number; content: string; category: string; created_at: string };
  memory_b: { id: number; content: string; category: string; created_at: string };
  similarity: number;
  source: "link" | "scan";
  verified?: boolean;
  explanation?: string;
}

/** Resolution strategy for a contradiction */
export type ContradictionResolution = "keep_a" | "keep_b" | "keep_both" | "merge";

/** Scheduled digest configuration row */
export interface Digest {
  id: number;
  user_id: number;
  schedule: "hourly" | "daily" | "weekly";
  webhook_url: string;
  webhook_secret?: string | null;
  include_stats: number;
  include_new_memories: number;
  include_contradictions: number;
  include_reflections: number;
  last_sent_at?: string | null;
  next_send_at: string;
  active: number;
  created_at: string;
}

/** Consolidation record row */
export interface ConsolidationRow {
  id: number;
  summary_memory_id: number;
  source_memory_ids: string; // JSON number array, parsed in handler
  cluster_label: string;
  created_at: string;
  summary_content?: string;
}

/** Time-travel query result */
export interface TimeTravelResult {
  as_of: string;
  query: string | null;
  memories: Array<{
    id: number;
    content: string;
    category: string;
    source: string;
    importance: number;
    version: number;
    is_static: boolean;
    tags: string[];
    created_at: string;
    similarity?: number;
  }>;
  stats: {
    total: number;
    static_count: number;
    tasks: number;
    states: number;
    decisions: number;
    discoveries: number;
    issues: number;
  };
  total_returned: number;
}
