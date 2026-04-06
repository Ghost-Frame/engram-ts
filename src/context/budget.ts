// ============================================================================
// CONTEXT DOMAIN - Token budget math and truncation
// ============================================================================

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: 1 token ~= 4 chars */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Sentence-boundary truncation
// ---------------------------------------------------------------------------

/**
 * Truncate content to fit within maxMemoryTokens.
 * Prefers sentence boundaries where possible.
 */
export function truncateToTokenBudget(content: string, maxMemoryTokens: number): string {
  if (estimateTokens(content) <= maxMemoryTokens) return content;
  const maxChars = maxMemoryTokens * 4;
  const cutPoint = content.lastIndexOf(". ", maxChars);
  if (cutPoint > maxChars * 0.6) return content.substring(0, cutPoint + 1) + " [truncated]";
  return content.substring(0, maxChars) + "... [truncated]";
}
