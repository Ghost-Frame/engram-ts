// ============================================================================
// MEMORY DOMAIN - Business logic (pure validation / normalization)
// ============================================================================

import { DEFAULT_IMPORTANCE, MAX_CONTENT_SIZE, VALID_FEEDBACK_SIGNALS } from "./types.ts";
import type { FeedbackSignal } from "./types.ts";
import { getQuotaForUser, getUserMemoryCount } from "./db.ts";

// -- Tag normalization -------------------------------------------------------

/**
 * Normalize tags from various input formats to a JSON string array.
 * Accepts: string[] | CSV string | null/undefined
 * Returns: JSON string (e.g. '["tag1","tag2"]') or null if no valid tags.
 */
export function normalizeTags(tags: string[] | string | null | undefined): string | null {
  if (tags == null) return null;

  let arr: string[];
  if (Array.isArray(tags)) {
    arr = tags.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean);
  } else if (typeof tags === "string") {
    arr = tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
  } else {
    return null;
  }

  return arr.length > 0 ? JSON.stringify(arr) : null;
}

// -- Importance clamping -----------------------------------------------------

/**
 * Clamp importance to the valid range [1, 10].
 * Falls back to DEFAULT_IMPORTANCE if value is NaN or missing.
 */
export function clampImportance(value: unknown, defaultValue: number = DEFAULT_IMPORTANCE): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(1, Math.min(10, n));
}

// -- Content validation ------------------------------------------------------

/**
 * Validate that content is a non-empty string. Returns trimmed content.
 * Throws on invalid input.
 */
export function validateContent(content: unknown): string {
  if (!content || typeof content !== "string") {
    throw new ContentValidationError("content is required and must be a non-empty string");
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new ContentValidationError("content is required and must be a non-empty string");
  }
  return trimmed;
}

/**
 * Validate content does not exceed the size limit.
 * Throws on oversized content with a descriptive message.
 */
export function validateContentSize(content: string, maxSize: number = MAX_CONTENT_SIZE): void {
  if (content.length > maxSize) {
    throw new ContentValidationError("Content too large (" + content.length + " bytes). Max: " + maxSize);
  }
}

export class ContentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentValidationError";
  }
}

// -- Quota checking ----------------------------------------------------------

export interface QuotaCheckResult {
  allowed: boolean;
  current: number;
  max: number;
}

/**
 * Check whether the user has exceeded their memory count quota.
 * Returns null if no quota is configured (unlimited).
 */
export function checkQuota(userId: number): QuotaCheckResult | null {
  const quota = getQuotaForUser(userId);
  if (!quota) return null;
  const current = getUserMemoryCount(userId);
  return {
    allowed: current < quota.max_memories,
    current,
    max: quota.max_memories,
  };
}

/**
 * Check whether a single memory's content exceeds the per-memory size quota.
 * Returns null if no quota is configured (unlimited).
 */
export function checkContentQuota(contentLength: number, userId: number): QuotaCheckResult | null {
  const quota = getQuotaForUser(userId);
  if (!quota) return null;
  return {
    allowed: contentLength <= quota.max_memory_size_bytes,
    current: contentLength,
    max: quota.max_memory_size_bytes,
  };
}

// -- Feedback validation -----------------------------------------------------

/**
 * Type guard for valid feedback signals.
 */
export function isValidFeedbackSignal(signal: string): signal is FeedbackSignal {
  return (VALID_FEEDBACK_SIGNALS as readonly string[]).includes(signal);
}

// -- Correction content builder ----------------------------------------------

/**
 * Build the stored content string for a correction memory.
 */
export function buildCorrectionContent(
  correction: string,
  originalClaim: string | null,
  memoryId: number | null,
): string {
  if (originalClaim && memoryId) {
    return '[CORRECTION] Was: "' + originalClaim.substring(0, 200) + '". Correct: ' + correction;
  }
  if (memoryId) {
    return "[CORRECTION of #" + memoryId + "] " + correction;
  }
  return correction;
}
