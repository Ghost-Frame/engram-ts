// ============================================================================
// MEMORY DOMAIN -- Type definitions and constants
// ============================================================================

/** Validated feedback signal values */
export const VALID_FEEDBACK_SIGNALS = ["used", "ignored", "corrected", "irrelevant", "helpful"] as const;
export type FeedbackSignal = (typeof VALID_FEEDBACK_SIGNALS)[number];

/** Default importance for new memories (1-10 scale) */
export const DEFAULT_IMPORTANCE = 5;

/** Maximum content size in bytes */
export const MAX_CONTENT_SIZE = 102_400;

/** Options for storing a new memory */
export interface StoreOptions {
  content: string;
  category?: string;
  source?: string;
  session_id?: string | null;
  importance?: number;
  tags?: string[] | string | null;
  episode?: string | false;
  model?: string | null;
  skip_processing?: boolean;
  is_static?: boolean;
  forget_after?: string | null;
  forget_reason?: string | null;
  is_inference?: boolean;
  entity_ids?: number[];
  project_ids?: number[];
  status?: string;
}

/** Result returned from insertMemory RETURNING clause */
export interface StoreResult {
  id: number;
  created_at: string;
}

/** Options for correcting an existing memory */
export interface CorrectOptions {
  correction: string;
  original_claim?: string;
  memory_id?: number;
  category?: string;
  source?: string;
  importance?: number;
  tags?: string[];
}

/** Parameters for memory health endpoint */
export interface MemoryHealthParams {
  stale_days: number;
  dup_threshold: number;
  limit: number;
}

/** Single feedback item (supports batch submission) */
export interface FeedbackItem {
  query: string;
  memory_id: number;
  signal: FeedbackSignal;
  context?: string;
  agent?: string;
}

/** Options for deduplication */
export interface DeduplicateOptions {
  threshold: number;
  dry_run: boolean;
  max_merge: number;
}
