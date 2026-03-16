// ============================================================================
// BI-TEMPORAL FACT TRACKING + CONTRADICTION DETECTION
// From Graphiti/Zep: facts have valid_at/invalid_at windows. Old facts are
// never deleted, just invalidated. New contradicting facts auto-invalidate
// predecessors on the same subject+verb.
// ============================================================================

import { db } from "../db/index.ts";
import { log } from "../config/logger.ts";

// ============================================================================
// VALID_AT POPULATION
// ============================================================================

// Set valid_at on a newly inserted structured_fact.
// Priority: date_approx > date_ref resolved > created_at of memory
export function setFactValidity(factId: number, memoryCreatedAt: string): void {
  try {
    const fact = db.prepare(
      "SELECT date_approx, date_ref FROM structured_facts WHERE id = ?"
    ).get(factId) as { date_approx: string | null; date_ref: string | null } | undefined;
    if (!fact) return;

    let validAt = memoryCreatedAt;

    if (fact.date_approx) {
      // Absolute date provided, use it directly
      validAt = fact.date_approx;
    } else if (fact.date_ref) {
      // Resolve relative dates against memory creation time
      const resolved = resolveRelativeDate(fact.date_ref, memoryCreatedAt);
      if (resolved) validAt = resolved;
    }

    db.prepare("UPDATE structured_facts SET valid_at = ? WHERE id = ?").run(validAt, factId);
  } catch (e: any) {
    log.warn({ msg: "set_fact_validity_failed", factId, error: e.message });
  }
}

// Resolve relative date references to ISO date strings
function resolveRelativeDate(ref: string, baseDate: string): string | null {
  try {
    const base = new Date(baseDate);
    if (isNaN(base.getTime())) return null;
    const lower = ref.toLowerCase().trim();

    if (lower === "today") return base.toISOString().slice(0, 10);
    if (lower === "yesterday") {
      base.setDate(base.getDate() - 1);
      return base.toISOString().slice(0, 10);
    }
    if (lower === "this morning" || lower === "this afternoon" || lower === "this evening") {
      return base.toISOString().slice(0, 10);
    }
    if (lower === "last morning" || lower === "last afternoon" || lower === "last evening") {
      base.setDate(base.getDate() - 1);
      return base.toISOString().slice(0, 10);
    }

    const agoMatch = lower.match(/^(\w+)\s+(days?|weeks?|months?)\s+ago$/);
    if (agoMatch) {
      const num = parseWordNumber(agoMatch[1]);
      const unit = agoMatch[2];
      if (num > 0) {
        if (unit.startsWith("day")) base.setDate(base.getDate() - num);
        else if (unit.startsWith("week")) base.setDate(base.getDate() - num * 7);
        else if (unit.startsWith("month")) base.setMonth(base.getMonth() - num);
        return base.toISOString().slice(0, 10);
      }
    }

    const lastMatch = lower.match(/^last\s+(week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
    if (lastMatch) {
      const unit = lastMatch[1];
      if (unit === "week") { base.setDate(base.getDate() - 7); return base.toISOString().slice(0, 10); }
      if (unit === "month") { base.setMonth(base.getMonth() - 1); return base.toISOString().slice(0, 10); }
      // Day of week
      const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const targetDay = days.indexOf(unit);
      if (targetDay >= 0) {
        const currentDay = base.getDay();
        let diff = currentDay - targetDay;
        if (diff <= 0) diff += 7;
        base.setDate(base.getDate() - diff);
        return base.toISOString().slice(0, 10);
      }
    }

    const weekAgoMatch = lower.match(/^a\s+(week|month)\s+ago$/);
    if (weekAgoMatch) {
      if (weekAgoMatch[1] === "week") base.setDate(base.getDate() - 7);
      else base.setMonth(base.getMonth() - 1);
      return base.toISOString().slice(0, 10);
    }

    return null;
  } catch {
    return null;
  }
}

function parseWordNumber(word: string): number {
  const map: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    a: 1, an: 1,
  };
  return map[word.toLowerCase()] || parseInt(word) || 0;
}

// ============================================================================
// CONTRADICTION DETECTION ON STRUCTURED FACTS
// ============================================================================

export interface FactContradiction {
  newFactId: number;
  oldFactId: number;
  oldMemoryId: number;
  subject: string;
  verb: string;
  newObject: string | null;
  oldObject: string | null;
}

// Check if a new structured fact contradicts existing facts.
// Two facts contradict when: same subject + same verb + different object (for the same user).
// Quantitative facts: same subject + verb but different quantity.
export function detectFactContradictions(
  newFactId: number,
  memoryId: number,
  subject: string,
  verb: string,
  object: string | null,
  quantity: number | null,
  userId: number
): FactContradiction[] {
  const contradictions: FactContradiction[] = [];

  try {
    // Find existing valid facts with same subject+verb
    const existing = db.prepare(
      `SELECT id, memory_id, object, quantity, unit
       FROM structured_facts
       WHERE subject = ? COLLATE NOCASE
         AND verb = ? COLLATE NOCASE
         AND user_id = ?
         AND id != ?
         AND invalid_at IS NULL
       ORDER BY created_at DESC
       LIMIT 20`
    ).all(subject, verb, userId, newFactId) as Array<{
      id: number; memory_id: number; object: string | null;
      quantity: number | null; unit: string | null;
    }>;

    for (const old of existing) {
      let isContradiction = false;

      // State-type verbs where only one value can be true at a time
      // Use exact match (not substring) to avoid false positives like "established" matching "is"
      const stateVerbs = new Set(["is", "has", "lives", "works", "became", "started", "moved", "lives in", "works at", "works as"]);
      const verbLower = verb.toLowerCase().trim();
      const isStateVerb = stateVerbs.has(verbLower);

      if (isStateVerb && object && old.object && object.toLowerCase() !== old.object.toLowerCase()) {
        // "user is X" vs "user is Y" - state contradiction
        isContradiction = true;
      } else if (quantity != null && old.quantity != null && quantity !== old.quantity && object === old.object) {
        // Same thing, different quantity
        isContradiction = true;
      }

      if (isContradiction) {
        contradictions.push({
          newFactId,
          oldFactId: old.id,
          oldMemoryId: old.memory_id,
          subject,
          verb,
          newObject: object,
          oldObject: old.object,
        });
      }
    }
  } catch (e: any) {
    log.warn({ msg: "fact_contradiction_check_failed", error: e.message });
  }

  return contradictions;
}

// Invalidate old facts that have been contradicted by a newer fact
export function invalidateContradictedFacts(contradictions: FactContradiction[]): number {
  if (contradictions.length === 0) return 0;

  let invalidated = 0;
  const invalidate = db.prepare(
    "UPDATE structured_facts SET invalid_at = datetime('now'), invalidated_by = ? WHERE id = ? AND invalid_at IS NULL"
  );

  try {
    const batch = db.transaction(() => {
      for (const c of contradictions) {
        const result = invalidate.run(c.newFactId, c.oldFactId);
        if (result.changes > 0) invalidated++;
      }
    });
    batch();

    if (invalidated > 0) {
      log.info({
        msg: "facts_invalidated_by_contradiction",
        count: invalidated,
        subjects: [...new Set(contradictions.map(c => `${c.subject}.${c.verb}`))],
      });
    }
  } catch (e: any) {
    log.warn({ msg: "fact_invalidation_failed", error: e.message });
  }

  return invalidated;
}

// Post-process newly inserted facts for a memory:
// 1. Set valid_at based on date info
// 2. Detect and invalidate contradictions
export function postProcessNewFacts(memoryId: number, userId: number): void {
  try {
    // Get the memory's created_at for date resolution
    const mem = db.prepare("SELECT created_at FROM memories WHERE id = ?").get(memoryId) as { created_at: string } | undefined;
    if (!mem) return;

    // Get all facts just inserted for this memory (those without valid_at)
    const newFacts = db.prepare(
      `SELECT id, subject, verb, object, quantity
       FROM structured_facts WHERE memory_id = ? AND user_id = ? AND valid_at IS NULL`
    ).all(memoryId, userId) as Array<{
      id: number; subject: string; verb: string; object: string | null; quantity: number | null;
    }>;

    for (const fact of newFacts) {
      // Set temporal validity
      setFactValidity(fact.id, mem.created_at);

      // Check for contradictions against existing valid facts
      const contradictions = detectFactContradictions(
        fact.id, memoryId, fact.subject, fact.verb, fact.object, fact.quantity, userId
      );
      if (contradictions.length > 0) {
        invalidateContradictedFacts(contradictions);
      }
    }
  } catch (e: any) {
    log.warn({ msg: "post_process_facts_failed", memoryId, error: e.message });
  }
}

// Backfill valid_at for existing facts that don't have it yet
export function backfillFactValidity(userId?: number): number {
  try {
    const query = userId != null
      ? `SELECT sf.id, sf.date_approx, sf.date_ref, m.created_at as memory_created_at
         FROM structured_facts sf
         JOIN memories m ON m.id = sf.memory_id
         WHERE sf.valid_at IS NULL AND sf.user_id = ?`
      : `SELECT sf.id, sf.date_approx, sf.date_ref, m.created_at as memory_created_at
         FROM structured_facts sf
         JOIN memories m ON m.id = sf.memory_id
         WHERE sf.valid_at IS NULL`;

    const rows = (userId != null
      ? db.prepare(query).all(userId)
      : db.prepare(query).all()) as Array<{
      id: number; date_approx: string | null; date_ref: string | null; memory_created_at: string;
    }>;

    let filled = 0;
    const update = db.prepare("UPDATE structured_facts SET valid_at = ? WHERE id = ?");

    const batch = db.transaction(() => {
      for (const row of rows) {
        let validAt = row.memory_created_at;
        if (row.date_approx) {
          validAt = row.date_approx;
        } else if (row.date_ref) {
          const resolved = resolveRelativeDate(row.date_ref, row.memory_created_at);
          if (resolved) validAt = resolved;
        }
        update.run(validAt, row.id);
        filled++;
      }
    });
    batch();

    if (filled > 0) log.info({ msg: "fact_validity_backfilled", count: filled });
    return filled;
  } catch (e: any) {
    log.warn({ msg: "fact_validity_backfill_failed", error: e.message });
    return 0;
  }
}
