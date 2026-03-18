// ============================================================================
// LLM -- Client, fact extraction, reranker
// Supports: Anthropic, MiniMax, Vertex AI, OpenAI-compatible (Ollama, LiteLLM, vLLM, Gemini, Groq, DeepSeek)
// Set via env: LLM_API_KEY, LLM_URL, LLM_MODEL
// ============================================================================

import { LLM_URL, LLM_API_KEY, LLM_MODEL, LLM_PROVIDERS, LLM_STRATEGY, type LLMProvider, RERANKER_ENABLED, RERANKER_TOP_K } from "../config/index.ts";
import { log, opsCounters } from "../config/logger.ts";
import { postProcessNewFacts } from "../intelligence/temporal.ts";
import { getVertexAccessToken } from "../auth/google-auth.ts";

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

// --- LLM availability check ---

export function isProviderAvailable(p: LLMProvider): boolean {
  if (p.key) return true;
  if (p.url.includes("127.0.0.1") || p.url.includes("localhost")) return true;
  try { if (new URL(p.url).hostname.endsWith("-aiplatform.googleapis.com")) return true; } catch {}
  return false;
}

let _llmReachable: boolean | null = null;

export async function probeLLM(): Promise<boolean> {
  // Any provider with an API key or Vertex SA auth means LLM is available
  if (LLM_PROVIDERS.some(isProviderAvailable)) { _llmReachable = true; return true; }
  if (!LLM_URL.includes("127.0.0.1") && !LLM_URL.includes("localhost")) { _llmReachable = false; return false; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(LLM_URL.replace(/\/chat\/completions$/, "/models"), { signal: ctrl.signal });
    clearTimeout(timer);
    _llmReachable = resp.ok;
  } catch {
    _llmReachable = false;
  }
  log.info({ msg: "llm_probe", reachable: _llmReachable, providers: LLM_PROVIDERS.map(p => p.name) });
  return _llmReachable;
}

export function isLLMAvailable(): boolean {
  if (LLM_PROVIDERS.some(isProviderAvailable)) return true;
  if (_llmReachable === false) return false;
  if (_llmReachable === true) return true;
  if (LLM_URL.includes("127.0.0.1") || LLM_URL.includes("localhost")) return true;
  return false;
}

// --- Single-provider call (internal) ---

function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

async function callProvider(provider: LLMProvider, systemPrompt: string, userPrompt: string, model?: string): Promise<string> {
  const useModel = model || provider.model;
  const url = provider.url;
  const key = provider.key;

  // Provider detection
  let isAnthropic = false;
  let isMiniMax = false;
  let isVertexAI = false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    isAnthropic = hostname === "api.anthropic.com" || hostname.endsWith(".api.anthropic.com");
    isMiniMax = hostname === "api.minimax.io" || hostname.endsWith(".minimaxi.com");
    isVertexAI = hostname.endsWith("-aiplatform.googleapis.com");
  } catch {}

  if (isAnthropic) {
    if (!key) throw new Error("API key required for Anthropic");
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: useModel, max_tokens: 2000, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`LLM ${provider.name} failed (${resp.status}): ${text}`);
      (err as any).status = resp.status;
      throw err;
    }
    const data = await resp.json() as any;
    return data.content?.[0]?.text || "";
  }

  // MiniMax: OpenAI-compatible but requires API key
  if (isMiniMax && !key) throw new Error("API key required for MiniMax");

  // OpenAI-compatible (also handles MiniMax, Gemini, Groq, DeepSeek, Vertex AI, etc.)
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isVertexAI) {
    // Vertex AI uses OAuth2 bearer tokens from service account
    try {
      const token = await getVertexAccessToken();
      headers["Authorization"] = `Bearer ${token}`;
    } catch (e: any) {
      // Fall back to the provider's key if service account auth fails
      if (key) headers["Authorization"] = `Bearer ${key}`;
      else throw new Error(`Vertex AI auth failed: ${e.message}`);
    }
  } else if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: useModel,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      max_tokens: 2000,
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`LLM ${provider.name} failed (${resp.status}): ${text}`);
    (err as any).status = resp.status;
    throw err;
  }

  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content || "";
}

// --- Main LLM call with fallback chain or round-robin ---

let _rrIndex = 0;

export async function callLLM(systemPrompt: string, userPrompt: string, model?: string): Promise<string> {
  const providers = LLM_PROVIDERS.filter(isProviderAvailable);
  if (providers.length === 0) throw new Error("No LLM providers configured");

  // Round-robin: rotate starting provider each call, still fall through on failure
  const startIdx = LLM_STRATEGY === "round-robin" ? _rrIndex % providers.length : 0;
  if (LLM_STRATEGY === "round-robin") _rrIndex++;

  let lastError: Error | null = null;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[(startIdx + i) % providers.length];
    try {
      const result = await callProvider(provider, systemPrompt, userPrompt, model);
      _llmReachable = true;
      if (LLM_STRATEGY === "round-robin" && providers.length > 1) {
        log.info({ msg: "llm_round_robin", provider: provider.name, index: (startIdx + i) % providers.length });
      }
      return result;
    } catch (e: any) {
      lastError = e;
      const status = e?.status || 0;
      const isConn = e?.cause?.code === "ECONNREFUSED" || e?.message?.includes("ECONNREFUSED") || e?.message?.includes("fetch failed");

      if (isConn || isRetryable(status)) {
        log.warn({ msg: "llm_provider_failed", provider: provider.name, status, error: e.message, remaining: providers.length - i - 1 });
        continue; // try next provider
      }
      // Non-retryable error (400, 401, etc.) - don't try fallbacks
      throw e;
    }
  }

  // All providers exhausted
  _llmReachable = false;
  throw lastError || new Error("All LLM providers failed");
}

const FACT_EXTRACTION_PROMPT = `You are a fact extraction engine for a persistent memory system. Your job is to analyze new content being stored and compare it with existing memories.

Given the NEW CONTENT and up to 3 SIMILAR EXISTING MEMORIES, you must:
1. Determine if this new content updates, extends, or duplicates any existing memory
2. Classify whether each fact is STATIC (permanent, unlikely to change — like preferences, identity, infrastructure) or DYNAMIC (temporary, likely to change — like current tasks, recent events, moods)
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
    const response = await callLLM(FACT_EXTRACTION_PROMPT, userPrompt);
    let jsonStr = response.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonStr) as FactExtractionResult;
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
    // Old memory's confidence drops — it's been superseded
    updateConfidence.run(0.3, existingMemoryId);
  } else if (relationType === "contradicts") {
    // Both memories get reduced confidence — conflict needs resolution
    const existing = getMemoryWithoutEmbedding.get(existingMemoryId) as any;
    const current = getMemoryWithoutEmbedding.get(memoryId) as any;
    if (existing) {
      const newConf = Math.max(0.2, (existing.confidence || 1.0) * 0.6);
      updateConfidence.run(newConf, existingMemoryId);
    }
    if (current) {
      updateConfidence.run(0.7, memoryId); // newer info gets slight benefit of doubt
    }

    emitWebhookEvent("contradiction.detected", {
      memory_id: memoryId,
      contradicts_memory_id: existingMemoryId,
      memory_content: current?.content,
      existing_content: existing?.content,
    }, userId);
  } else if (relationType === "extends") {
    // Extended memory gets a small confidence boost — it's been corroborated
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
    // Stamp episode provenance from the parent memory onto LLM-extracted facts
    try {
      const mem = db.prepare("SELECT episode_id FROM memories WHERE id = ?").get(newMemoryId) as { episode_id: number | null } | undefined;
      if (mem?.episode_id) {
        db.prepare("UPDATE structured_facts SET episode_id = ? WHERE memory_id = ? AND episode_id IS NULL")
          .run(mem.episode_id, newMemoryId);
      }
    } catch (e: any) {
      log.warn({ msg: "episode_provenance_stamp_failed", memory_id: newMemoryId, error: e?.message });
    }
    // Bi-temporal: set valid_at and detect contradictions for LLM-extracted facts
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

// ============================================================================
// LLM-BASED RERANKER
// ============================================================================

export async function rerank(
  query: string,
  candidates: Array<{ id: number; content: string; score: number; [k: string]: any }>,
  topK: number = RERANKER_TOP_K
): Promise<typeof candidates> {
  if (!RERANKER_ENABLED || !isLLMAvailable() || candidates.length <= 3) return candidates;

  const toRerank = candidates.slice(0, Math.min(topK, candidates.length));
  const numbered = toRerank.map((c, i) => `[${i}] ${c.content.substring(0, 200)}`).join("\n");

  const prompt = `Given the query, rank the following documents by relevance. Return ONLY a JSON array of indices from most to least relevant.

Query: "${query}"

Documents:
${numbered}

Return format: [most_relevant_index, next_most_relevant, ...]`;

  try {
    const resp = await callLLM("You are a document reranking engine. Return only a JSON array of integer indices.", prompt);
    if (!resp) return candidates;
    const match = resp.match(/\[[\d,\s]+\]/);
    if (!match) return candidates;
    const indices = JSON.parse(match[0]) as number[];
    const reranked: typeof candidates = [];
    for (let rank = 0; rank < indices.length; rank++) {
      const idx = indices[rank];
      if (idx >= 0 && idx < toRerank.length) {
        const item = { ...toRerank[idx] };
        item.score = item.score * (1 + (indices.length - rank) / indices.length * 0.5);
        reranked.push(item);
      }
    }
    const rerankedIds = new Set(reranked.map(r => r.id));
    for (const c of candidates) {
      if (!rerankedIds.has(c.id)) reranked.push(c);
    }
    return reranked;
  } catch (e: any) {
    opsCounters.reranker_fallbacks++;
    log.warn({ msg: "llm_rerank_failed", query: query.substring(0, 80), error: e?.message });
    return candidates;
  }
}
