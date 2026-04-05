// ============================================================================
// LLM UTILITIES - JSON parsing, fact extraction, result processing
// All inference now routes through callLocalModel in ./local.ts
// This file retains only utilities and the extractFacts pipeline.
// ============================================================================

import { LLM_PROVIDERS, type LLMProvider } from "../config/index.ts";
import { log, opsCounters } from "../config/logger.ts";
import { postProcessNewFacts } from "../intelligence/temporal.ts";
import { callLocalModel } from "./local.ts";

interface FactExtractionResult {
  facts: Array<{
    content: string;
    category: string;
    is_static: boolean;
    forget_after?: string | null;
    forget_reason?: string | null;
    importance: number;
  }>;
  relation_to_existing: {
    type: "none" | "updates" | "extends" | "duplicate" | "contradicts" | "caused_by" | "prerequisite_for" | "corrects";
    existing_memory_id?: number | null;
    reason?: string;
  };
}

// --- Provider availability check (used by health/admin status reporting) ---

export function isProviderAvailable(p: LLMProvider): boolean {
  if (p.key) return true;
  if (p.url.includes("127.0.0.1") || p.url.includes("localhost")) return true;
  try { if (new URL(p.url).hostname.endsWith("-aiplatform.googleapis.com")) return true; } catch {}
  return false;
}

// ============================================================================
// ROBUST JSON PARSING - repair common model output issues
// ============================================================================

export function repairAndParseJSON(raw: string): unknown | null {
  let str = raw.trim();

  // 1. Extract JSON body: find first { or [, find last matching } or ]
  const firstBrace = str.indexOf("{");
  const firstBracket = str.indexOf("[");
  let start = -1;
  let closeChar: string;
  if (firstBrace === -1 && firstBracket === -1) return null;
  if (firstBracket === -1 || (firstBrace !== -1 && firstBrace < firstBracket)) {
    start = firstBrace; closeChar = "}";
  } else {
    start = firstBracket; closeChar = "]";
  }
  const lastClose = str.lastIndexOf(closeChar);
  if (lastClose > start) {
    str = str.substring(start, lastClose + 1);
  } else {
    str = str.substring(start);
  }

  // 2. Strip markdown fences that survived extraction
  str = str.replace(/```(?:json)?\s*/g, "").replace(/\s*```/g, "");

  // 3. Fix trailing commas: ,} or ,]
  str = str.replace(/,\s*([}\]])/g, "$1");

  // 4. Try parse
  try { return JSON.parse(str); } catch (e1: any) {
    // 5. Fix unterminated strings + unbalanced braces
    if (e1.message?.includes("Unterminated") || e1.message?.includes("Expected")) {
      // Find last unmatched quote and close it
      let inStr = false;
      let lastQuoteIdx = -1;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === '"' && (i === 0 || str[i - 1] !== '\\')) {
          inStr = !inStr;
          if (inStr) lastQuoteIdx = i;
        }
      }
      if (inStr && lastQuoteIdx >= 0) {
        str = str + '"';
      }

      // Balance braces/brackets
      let braces = 0, brackets = 0;
      let inString = false;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === '"' && (i === 0 || str[i - 1] !== '\\')) { inString = !inString; continue; }
        if (inString) continue;
        if (str[i] === '{') braces++;
        else if (str[i] === '}') braces--;
        else if (str[i] === '[') brackets++;
        else if (str[i] === ']') brackets--;
      }
      while (brackets > 0) { str += "]"; brackets--; }
      while (braces > 0) { str += "}"; braces--; }

      // Fix trailing commas again after repair
      str = str.replace(/,\s*([}\]])/g, "$1");

      // 6. Try parse again
      try {
        const result = JSON.parse(str);
        log.debug({ msg: "json_repaired", original_length: raw.length, repaired_length: str.length });
        return result;
      } catch { /* fall through */ }
    }

    // 7. Return null
    return null;
  }
}

// --- Call local model and parse JSON with retry ---

async function callLocalAndParse<T>(
  systemPrompt: string,
  userPrompt: string,
  validator: (result: unknown) => result is T
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await callLocalModel(systemPrompt, userPrompt, { priority: "background" });
      const parsed = repairAndParseJSON(response);
      if (parsed !== null && validator(parsed)) return parsed;
      if (attempt === 0) {
        log.info({ msg: "json_parse_retry", attempt: 1, had_result: parsed !== null });
      }
    } catch (e: any) {
      if (attempt === 0) {
        log.info({ msg: "json_parse_retry", attempt: 1, error: e.message });
      }
    }
  }
  log.error({ msg: "json_parse_exhausted", prompt_length: userPrompt.length });
  return null;
}

// ============================================================================
// FACT EXTRACTION
// ============================================================================

const FACT_EXTRACTION_PROMPT = `You are a fact extraction engine for a persistent memory system. Your job is to analyze new content being stored and compare it with existing memories.

Given the NEW CONTENT and up to 3 SIMILAR EXISTING MEMORIES, you must:
1. Determine if this new content updates, extends, or duplicates any existing memory
2. Classify whether each fact is STATIC (permanent, unlikely to change - like preferences, identity, infrastructure) or DYNAMIC (temporary, likely to change - like current tasks, recent events, moods)
3. For dynamic facts, estimate when they should be forgotten (if applicable)
4. Rate importance 1-10

Respond with ONLY valid JSON (no markdown, no backticks):
{
  "facts": [
    {
      "content": "extracted fact text",
      "category": "task|discovery|decision|state|issue",
      "is_static": true/false,
      "forget_after": "ISO datetime or null",
      "forget_reason": "reason or null",
      "importance": 1-10
    }
  ],
  "tags": ["lowercase", "keyword", "tags"],
  "structured_facts": [
    {
      "subject": "who (user/assistant/entity name)",
      "verb": "what action",
      "object": "what was acted upon",
      "quantity": null,
      "unit": null,
      "date_ref": "relative date if mentioned (yesterday, last week)",
      "date_approx": "YYYY-MM-DD if determinable",
      "location": "where it happened (city/building/server/null)",
      "context": "why/how - brief causal context (null if not applicable)"
    }
  ],
  "preferences": [{"domain": "category", "preference": "likes/dislikes X"}],
  "state_updates": [{"key": "current_role|current_location|etc", "value": "new value"}],
  "relation_to_existing": {
    "type": "none|updates|extends|duplicate|contradicts|caused_by|prerequisite_for|corrects",
    "existing_memory_id": number_or_null,
    "reason": "why this relation was determined"
  }
}

Rules:
- "corrects" = explicit correction of existing memory. HIGHEST priority relation.
- "updates" = supersedes with newer info
- "extends" = adds to without contradicting
- "duplicate" = same thing
- "contradicts" = directly conflicts
- "caused_by" / "prerequisite_for" = causal relationships
- "none" = no meaningful relation
- For forget_after: ISO 8601 datetime. Permanent facts = null.
- 1-3 key facts per content
- Extract BOTH user facts AND assistant actions. If the assistant recommended, implemented, fixed, diagnosed, or produced something, extract that as a fact too (e.g. "assistant implemented FSRS-6 spaced repetition", "assistant recommended using WAL mode").
- Include "tags": 2-5 lowercase keywords
- For structured_facts: decompose into atomic WHAT/WHEN/WHERE/WHO/WHY dimensions. WHO = subject, WHAT = verb+object, WHEN = date_ref/date_approx, WHERE = location, WHY = context. Include as many dimensions as the content provides.
- Include "preferences", "state_updates" if applicable`;

export async function extractFacts(
  content: string,
  category: string,
  similarMemories: Array<{ id: number; content: string; category: string; score: number }>
): Promise<FactExtractionResult | null> {
  try {
    let userPrompt = `NEW CONTENT (category: ${category}):\n${content}\n\n`;
    if (similarMemories.length > 0) {
      userPrompt += "SIMILAR EXISTING MEMORIES:\n";
      for (const m of similarMemories) {
        userPrompt += `[ID: ${m.id}, category: ${m.category}, similarity: ${m.score.toFixed(3)}]\n${m.content}\n\n`;
      }
    } else {
      userPrompt += "SIMILAR EXISTING MEMORIES: none found\n";
    }
    const result = await callLocalAndParse<FactExtractionResult>(
      FACT_EXTRACTION_PROMPT, userPrompt,
      (r): r is FactExtractionResult => !!r && Array.isArray((r as any).facts)
    );
    return result;
  } catch (e: any) {
    log.error({ msg: "fact_extraction_failed", error: e.message });
    return null;
  }
}

// ============================================================================
// PROCESS FACT EXTRACTION RESULTS
// ============================================================================

import {
  db, getMemoryWithoutEmbedding, insertLink, markSuperseded, updateConfidence,
} from "../db/index.ts";
import { emitWebhookEvent } from "../platform/webhooks.ts";

function propagateConfidence(memoryId: number, relationType: string, existingMemoryId: number, userId: number): void {
  if (relationType === "updates") {
    updateConfidence.run(0.3, existingMemoryId);
  } else if (relationType === "contradicts") {
    const existing = getMemoryWithoutEmbedding.get(existingMemoryId) as any;
    const current = getMemoryWithoutEmbedding.get(memoryId) as any;
    if (existing) {
      const newConf = Math.max(0.2, (existing.confidence || 1.0) * 0.6);
      updateConfidence.run(newConf, existingMemoryId);
    }
    if (current) {
      updateConfidence.run(0.7, memoryId);
    }

    emitWebhookEvent("contradiction.detected", {
      memory_id: memoryId,
      contradicts_memory_id: existingMemoryId,
      memory_content: current?.content,
      existing_content: existing?.content,
    }, userId);
  } else if (relationType === "extends") {
    const existing = getMemoryWithoutEmbedding.get(existingMemoryId) as any;
    if (existing) {
      const newConf = Math.min(1.0, (existing.confidence || 1.0) * 1.05);
      updateConfidence.run(newConf, existingMemoryId);
    }
  }
}
const incrementSourceCount = db.prepare("UPDATE memories SET source_count = source_count + 1 WHERE id = ?");

export function processExtractionResult(
  newMemoryId: number,
  result: FactExtractionResult,
  embArray: Float32Array | null,
  userId?: number
): void {
  const rel = result.relation_to_existing;
  const ownerId = userId ?? ((getMemoryWithoutEmbedding.get(newMemoryId) as any)?.user_id ?? 1);

  if (rel.type === "duplicate" && rel.existing_memory_id) {
    const existing = getMemoryWithoutEmbedding.get(rel.existing_memory_id) as any;
    if (existing && !existing.is_forgotten) {
      incrementSourceCount.run(rel.existing_memory_id);
      markSuperseded.run(newMemoryId);
      insertLink.run(newMemoryId, rel.existing_memory_id, 1.0, "derives");
      return;
    }
  }

  if (rel.type === "updates" && rel.existing_memory_id) {
    const existing = getMemoryWithoutEmbedding.get(rel.existing_memory_id) as any;
    if (existing) {
      markSuperseded.run(rel.existing_memory_id);
      const rootId = existing.root_memory_id || existing.id;
      const newVersion = (existing.version || 1) + 1;
      db.prepare(`UPDATE memories SET version = ?, root_memory_id = ?, parent_memory_id = ?, is_latest = 1 WHERE id = ?`)
        .run(newVersion, rootId, existing.id, newMemoryId);
      insertLink.run(newMemoryId, rel.existing_memory_id, 1.0, "updates");
      propagateConfidence(newMemoryId, "updates", rel.existing_memory_id, ownerId);
    }
  }

  if (rel.type === "extends" && rel.existing_memory_id) {
    insertLink.run(newMemoryId, rel.existing_memory_id, 0.9, "extends");
  }

  if (rel.type === "contradicts" && rel.existing_memory_id) {
    insertLink.run(newMemoryId, rel.existing_memory_id, 0.85, "contradicts");
    insertLink.run(rel.existing_memory_id, newMemoryId, 0.85, "contradicts");
  }

  if (rel.type === "caused_by" && rel.existing_memory_id) {
    insertLink.run(newMemoryId, rel.existing_memory_id, 0.8, "caused_by");
  }

  if (rel.type === "prerequisite_for" && rel.existing_memory_id) {
    insertLink.run(rel.existing_memory_id, newMemoryId, 0.8, "prerequisite_for");
  }

  if (rel.type === "corrects" && rel.existing_memory_id) {
    const existing = getMemoryWithoutEmbedding.get(rel.existing_memory_id) as any;
    if (existing) {
      markSuperseded.run(rel.existing_memory_id);
      const rootId = existing.root_memory_id || existing.id;
      const newVersion = (existing.version || 1) + 1;
      db.prepare(`UPDATE memories SET version = ?, root_memory_id = ?, parent_memory_id = ?, is_latest = 1, is_static = 1,
         importance = CASE WHEN importance < 9 THEN 9 ELSE importance END WHERE id = ?`)
        .run(newVersion, rootId, existing.id, newMemoryId);
      insertLink.run(newMemoryId, rel.existing_memory_id, 1.0, "corrects");
    }
  }

  if (result.facts.length > 0) {
    const f = result.facts[0];
    db.prepare(`UPDATE memories SET is_static = ?, forget_after = ?, forget_reason = ?,
       importance = CASE WHEN importance = 5 THEN ? ELSE importance END, updated_at = datetime('now') WHERE id = ?`)
      .run(f.is_static ? 1 : 0, f.forget_after || null, f.forget_reason || null, f.importance, newMemoryId);
  }

  if ((result as any).tags?.length) {
    const inferred = (result as any).tags.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean);
    const mem = getMemoryWithoutEmbedding.get(newMemoryId) as any;
    let existing: string[] = [];
    if (mem?.tags) try { existing = JSON.parse(mem.tags); } catch {}
    const merged = [...new Set([...existing, ...inferred])];
    db.prepare("UPDATE memories SET tags = ? WHERE id = ?").run(JSON.stringify(merged), newMemoryId);
  }

  if ((result as any).structured_facts?.length) {
    const insertSF = db.prepare(
      `INSERT INTO structured_facts (memory_id, subject, verb, object, quantity, unit, date_ref, date_approx, location, context, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const sf of (result as any).structured_facts) {
      try { insertSF.run(newMemoryId, sf.subject || "user", sf.verb || "unknown", sf.object || null,
        sf.quantity != null ? Number(sf.quantity) : null, sf.unit || null, sf.date_ref || null, sf.date_approx || null,
        sf.location || null, sf.context || null, ownerId); } catch (e: any) {
        opsCounters.structured_fact_failures++;
        log.warn({ msg: "structured_fact_insert_failed", memory_id: newMemoryId, error: e?.message });
      }
    }
    try {
      const mem = db.prepare("SELECT episode_id FROM memories WHERE id = ?").get(newMemoryId) as { episode_id: number | null } | undefined;
      if (mem?.episode_id) {
        db.prepare("UPDATE structured_facts SET episode_id = ? WHERE memory_id = ? AND episode_id IS NULL")
          .run(mem.episode_id, newMemoryId);
      }
    } catch (e: any) {
      log.warn({ msg: "episode_provenance_stamp_failed", memory_id: newMemoryId, error: e?.message });
    }
    postProcessNewFacts(newMemoryId, ownerId);
  }

  if ((result as any).preferences?.length) {
    const upsertPref = db.prepare(
      `INSERT INTO user_preferences (domain, preference, evidence_memory_id, user_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(domain, preference, user_id) DO UPDATE SET strength = strength + 0.5, evidence_memory_id = excluded.evidence_memory_id, updated_at = datetime('now')`
    );
    for (const p of (result as any).preferences) {
      try { upsertPref.run(p.domain || "general", p.preference, newMemoryId, ownerId); } catch (e: any) {
        log.warn({ msg: "preference_upsert_failed", memory_id: newMemoryId, error: e?.message });
      }
    }
  }

  if ((result as any).state_updates?.length) {
    const upsertState = db.prepare(
      `INSERT INTO current_state (key, value, memory_id, user_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET previous_value = current_state.value, previous_memory_id = current_state.memory_id,
         value = excluded.value, memory_id = excluded.memory_id, updated_count = updated_count + 1, updated_at = datetime('now')`
    );
    for (const s of (result as any).state_updates) {
      try { upsertState.run(s.key, s.value, newMemoryId, ownerId); } catch (e: any) {
        log.warn({ msg: "state_upsert_failed", memory_id: newMemoryId, error: e?.message });
      }
    }
  }
}
