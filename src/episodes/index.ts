// ============================================================================
// EPISODES DOMAIN - Business logic (pure functions)
// ============================================================================

/** LLM prompt for summarizing a conversation into an episodic narrative */
export const EPISODE_SUMMARIZE_PROMPT =
  `You are a memory system. Summarize this conversation into a concise episodic narrative (1-3 paragraphs). Capture: what the user asked for, what the assistant did, key decisions made, problems solved, and outcomes. Include temporal flow ("first... then... finally..."). Write in past tense.`;

/** LLM prompt for summarizing memories during finalization */
export const FINALIZE_SUMMARIZE_PROMPT =
  `You are a memory system. Summarize these memories from a single session into a concise episodic narrative (1-3 paragraphs). Capture: what the user asked for, what the assistant did, key decisions made, problems solved, and outcomes. Include temporal flow. Write in past tense.`;

/** Maximum conversation/memory text length sent to LLM */
export const LLM_TEXT_LIMIT = 8000;

/**
 * Calculate duration in seconds between two ISO timestamp strings.
 * Returns 0 if either timestamp is null, undefined, or invalid.
 */
export function calculateDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): number {
  if (!startedAt || !endedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (isNaN(start) || isNaN(end)) return 0;
  const seconds = Math.round((end - start) / 1000);
  return seconds > 0 ? seconds : 0;
}

/**
 * Build a fallback summary from memory contents when LLM is unavailable.
 * Joins content strings with spaces, truncated to 1000 characters.
 */
export function buildFallbackSummary(
  memories: Array<{ content: string }>,
): string {
  return memories.map((m) => m.content).join(" ").substring(0, 1000);
}

/**
 * Format memory rows as labeled text for LLM summarization.
 * Each memory is prefixed with its category. Truncated to LLM_TEXT_LIMIT.
 */
export function formatMemoriesForLLM(
  memories: Array<{ content: string; category: string }>,
): string {
  return memories
    .map((m) => `[${m.category}] ${m.content}`)
    .join("\n")
    .substring(0, LLM_TEXT_LIMIT);
}

/**
 * Generate an ISO-ish timestamp suitable for the database (space-separated, no Z).
 */
export function nowTimestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}
