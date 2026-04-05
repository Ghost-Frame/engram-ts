// ============================================================================
// ATOMIC FACT DECOMPOSITION - Extract indexed facts from memories
// ============================================================================

import { callLLM, repairAndParseJSON, isLLMAvailable } from "../llm/index.ts";
import { callGeminiCLI } from "../llm/gemini-cli.ts";
import { log } from "../config/logger.ts";
import { db, insertMemory, insertLink, writeVec } from "../db/index.ts";
import { embed, embeddingToBuffer, addToEmbeddingCache } from "../embeddings/index.ts";

import { DECOMPOSITION_ENABLED, DECOMPOSITION_MIN_LENGTH, DECOMPOSITION_MAX_FACTS } from "../config/index.ts";

const DECOMPOSITION_PROMPT = `You are a fact extraction engine for a memory system. Given a memory entry, extract individual atomic facts.

Rules:
- Each fact must be a single, self-contained statement
- Preserve ALL specific values: IPs, ports, paths, versions, dates, names, commands
- Each fact should make sense on its own without the others
- Do NOT add interpretation or inference -- only extract what is explicitly stated
- Do NOT rephrase into robotic language -- keep the original tone and wording where possible
- If the memory is already a single atomic fact, return it as-is
- Aim for 1-8 facts per memory (most will be 2-4)

Respond with ONLY a JSON object:
{
  "facts": ["fact 1", "fact 2"],
  "skip": false
}

Set skip=true if the content is too short, already atomic, or not decomposable (e.g., a single sentence with one claim).`;

export interface DecompositionResult {
  facts: string[];
  skip: boolean;
}

function validateDecomposition(parsed: unknown): parsed is DecompositionResult {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as any;
  if (obj.skip === true) return true;
  return Array.isArray(obj.facts) && obj.facts.every((f: unknown) => typeof f === "string");
}

/**
 * Decompose a memory into atomic facts.
 * Tries the LLM chain first, falls back to Gemini CLI, then gives up.
 */
export interface DecompositionWithTier {
  result: DecompositionResult;
  tier: "llm" | "gemini-cli" | "tier2-rules" | "tier3-template";
}

export async function decomposeMemory(content: string): Promise<DecompositionWithTier | null> {
  // Try LLM chain first
  if (isLLMAvailable()) {
    try {
      const response = await callLLM(DECOMPOSITION_PROMPT, content);
      const parsed = repairAndParseJSON(response);
      if (validateDecomposition(parsed)) return { result: parsed, tier: "llm" };
      log.warn({ msg: "decomposition_parse_failed_llm", content_length: content.length });
    } catch (e: any) {
      log.warn({ msg: "decomposition_llm_failed", error: e.message });
    }
  }

  // Fallback: Gemini CLI
  try {
    const response = await callGeminiCLI(DECOMPOSITION_PROMPT, content);
    if (response) {
      const parsed = repairAndParseJSON(response);
      if (validateDecomposition(parsed)) return { result: parsed, tier: "gemini-cli" };
    }
    log.warn({ msg: "decomposition_parse_failed_gemini_cli", content_length: content.length });
  } catch (e: any) {
    log.warn({ msg: "decomposition_gemini_cli_failed", error: e.message });
  }

  // Fallback: rule-based / template decomposition
  const { getFallbackDecomposition, tierModelTag } = await import("./fallback.ts");
  const fallbackResult = getFallbackDecomposition(content);
  if (!fallbackResult) return null;
  return { result: fallbackResult, tier: tierModelTag() as "tier2-rules" | "tier3-template" };
}

/**
 * Store extracted facts as child memories linked to the parent.
 * Returns the number of facts created.
 */
export async function storeFactChildren(
  parentId: number,
  facts: string[],
  parentMeta: {
    category: string;
    source: string;
    userId: number;
    spaceId: number | null;
    importance: number;
    episodeId: number | null;
    tags: string | null;
    sessionId: string | null;
    model?: string | null;
  },
): Promise<number> {
  const capped = facts.slice(0, DECOMPOSITION_MAX_FACTS);
  let stored = 0;

  for (const factContent of capped) {
    if (!factContent || factContent.trim().length < 5) continue;
    const trimmed = factContent.trim();

    try {
      // Embed the fact
      let embBuffer: Buffer | null = null;
      let embArray: Float32Array | null = null;
      try {
        embArray = await embed(trimmed);
        embBuffer = embeddingToBuffer(embArray);
      } catch (e: any) {
        log.warn({ msg: "fact_embed_failed", parent_id: parentId, error: e.message });
      }

      // Insert as child memory -- match insertMemory parameter order from db/index.ts
      const result = insertMemory.get(
        trimmed,                        // content
        "fact",                         // category
        "decomposition",                // source
        parentMeta.sessionId,           // session_id
        parentMeta.importance,          // importance
        embBuffer,                      // embedding
        1,                              // version
        1,                              // is_latest
        parentId,                       // parent_memory_id
        null,                           // root_memory_id
        1,                              // source_count
        0,                              // is_static
        0,                              // is_forgotten
        null,                           // forget_after
        null,                           // forget_reason
        0,                              // is_inference
        parentMeta.model ?? null,       // model
        parentMeta.userId,              // user_id
        parentMeta.spaceId,             // space_id
      ) as { id: number; created_at: string };

      // Set is_fact flag and copy metadata
      db.prepare(
        "UPDATE memories SET is_fact = 1, tags = ?, episode_id = ?, confidence = 1.0, status = 'approved' WHERE id = ?"
      ).run(parentMeta.tags, parentMeta.episodeId, result.id);

      // Link parent -> child
      insertLink.run(parentId, result.id, 1.0, "has_fact");

      // Write vector and add to cache
      if (embArray) {
        writeVec(result.id, embArray);
        addToEmbeddingCache({
          id: result.id, user_id: parentMeta.userId, content: trimmed,
          category: "fact", importance: parentMeta.importance, embedding: embArray,
          is_static: false, source_count: 1, is_latest: true, is_forgotten: false,
        });
      }

      stored++;
    } catch (e: any) {
      log.error({ msg: "fact_store_failed", parent_id: parentId, error: e.message });
    }
  }

  // Mark parent as decomposed
  if (stored > 0) {
    db.prepare("UPDATE memories SET is_decomposed = 1 WHERE id = ?").run(parentId);
    log.info({ msg: "decomposed", parent_id: parentId, facts_stored: stored });
  }

  return stored;
}

/**
 * Full decomposition pipeline for a single memory.
 * Called from post_store job handler.
 */
export async function decomposeAndStore(
  memoryId: number,
  content: string,
  meta: {
    category: string;
    source: string;
    userId: number;
    spaceId: number | null;
    importance: number;
    episodeId: number | null;
    tags: string | null;
    sessionId: string | null;
  },
): Promise<number> {
  if (!DECOMPOSITION_ENABLED) return 0;
  if (content.length < DECOMPOSITION_MIN_LENGTH) {
    db.prepare("UPDATE memories SET is_decomposed = 1 WHERE id = ?").run(memoryId);
    return 0;
  }

  // Skip consolidated, compaction, auto-captured, and fact children
  if (content.startsWith("[Consolidated:")) return 0;
  if (content.startsWith("Session compaction summary")) return 0;
  if (content.startsWith("[auto-captured]")) return 0;
  if (meta.category === "fact") return 0;

  const decomposition = await decomposeMemory(content);
  if (!decomposition) {
    log.warn({ msg: "decomposition_failed", memory_id: memoryId });
    return 0;
  }

  if (decomposition.result.skip) {
    db.prepare("UPDATE memories SET is_decomposed = 1 WHERE id = ?").run(memoryId);
    return 0;
  }

  return storeFactChildren(memoryId, decomposition.result.facts, { ...meta, model: decomposition.tier });
}
