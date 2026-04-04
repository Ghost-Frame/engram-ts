// ============================================================================
// SCRATCH PAD DOMAIN - Type definitions
// ============================================================================

/** A single row from the scratchpad table */
export interface ScratchEntryRow {
  session: string;
  agent: string;
  model: string;
  entry_key: string;
  value: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/** A scratch entry as returned to API callers */
export interface ScratchEntry {
  session: string;
  agent: string;
  model: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/** A single key-value pair for PUT /scratch */
export interface ScratchKV {
  key: string;
  value: string;
}

/** Body for PUT /scratch */
export interface ScratchPutBody {
  session?: string;
  agent?: string;
  model?: string;
  entries?: ScratchKV[];
  /** TTL in minutes (1-1440, default 30) */
  ttl?: number;
}

/** Body for POST /scratch/:session/promote */
export interface ScratchPromoteBody {
  /** Optional list of entry keys to promote (all if omitted) */
  keys?: string[];
  /** Combine all entries into one memory (default false) */
  combine?: boolean;
  /** Memory category (default 'discovery') */
  category?: string;
}

/** Body for POST /scratch/:session/summarize */
export interface ScratchSummarizeBody {
  /** Whether to delete the session after summarizing (default true) */
  delete?: boolean;
}
