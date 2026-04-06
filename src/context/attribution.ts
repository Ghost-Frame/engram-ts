// ============================================================================
// CONTEXT DOMAIN - Attribution tag builder
// ============================================================================

import type { ContextBlock } from "./types.ts";

// ---------------------------------------------------------------------------
// Attribution tag builder
// ---------------------------------------------------------------------------

export function buildAttribution(block: ContextBlock): string {
  const parts: string[] = [];
  if (block.model) parts.push(block.model);
  if (block.origin && block.origin !== "unknown") parts.push(`via ${block.origin}`);
  return parts.length > 0 ? ` (by ${parts.join(" ")})` : "";
}
