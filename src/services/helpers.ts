// ============================================================================
// Shared helpers for consolidated Syntheos services
// ============================================================================

/**
 * Parse JSON string fields in a DB row back to objects.
 * Used by Thymus (scores, criteria, tags), Soma (capabilities, config, data),
 * and Chiasm (metadata, plan, feedback).
 */
export function parseJsonFields<T extends Record<string, unknown>>(
  row: T | undefined,
  ...fields: string[]
): T | undefined {
  if (!row) return undefined;
  for (const f of fields) {
    if (typeof (row as any)[f] === "string") {
      try { (row as any)[f] = JSON.parse((row as any)[f]); } catch { /* leave as-is */ }
    }
  }
  return row;
}

export function parseJsonFieldsAll<T extends Record<string, unknown>>(
  rows: T[],
  ...fields: string[]
): T[] {
  for (const row of rows) parseJsonFields(row, ...fields);
  return rows;
}
