// ============================================================================
// Shared types for consolidated Syntheos services
// ============================================================================

/** Standard JSON row with parsed fields */
export type JsonRow = Record<string, unknown>;

/** Bounded numeric parameter */
export function bounded(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
