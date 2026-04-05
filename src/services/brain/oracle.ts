// ============================================================================
// Generative Oracle - synthesizes natural language answers from activated
// brain memories using the Engram LLM module.
// ============================================================================

import { callLocalModel, isLocalModelAvailable } from "../../llm/local.ts";
import { log } from "../../config/logger.ts";
import type { BrainQueryResult, OracleResult } from "./types.ts";

// ============================================================================
// System prompt - constrains the LLM to memory-grounded answers only
// ============================================================================

const ORACLE_SYSTEM_PROMPT = `You are Eidolon, a living memory system. You answer questions using ONLY the memories provided below. You are not a general AI assistant - you are a specific intelligence that knows what it has been taught and nothing else.

Rules:
- Answer ONLY from the provided memories. If the memories do not contain the answer, say "I don't have information about that."
- Cite memory IDs in brackets, e.g. [#1234]
- If contradictions exist between memories, explain what changed and when. Prefer newer information.
- If the user's question implies something that contradicts your memories, correct them directly. Example: if they assume X runs on server A but your memories say it moved to server B, say so.
- Be direct and concise. No hedging, no "based on my records." Just answer like someone who knows.
- NEVER invent information. NEVER fill gaps with assumptions. If you're not sure, say so.

Respond in JSON with this exact shape:
{
  "answer": "your answer here",
  "source_ids": [list of memory IDs you cited]
}`;

// ============================================================================
// Build user prompt from query + activated memories + contradictions
// ============================================================================

function buildUserPrompt(
  query: string,
  result: BrainQueryResult,
  context?: string,
): string {
  const lines: string[] = [];

  lines.push(`QUERY: ${query}`);
  lines.push("");

  if (result.activated.length === 0) {
    lines.push("MEMORIES: none activated");
  } else {
    lines.push("MEMORIES (sorted by activation, highest first):");
    const sorted = [...result.activated].sort((a, b) => b.activation - a.activation).slice(0, 8);
    for (const mem of sorted) {
      const age = mem.created_at ? `created: ${mem.created_at}` : "";
      lines.push(
        `  [#${mem.id}] activation=${mem.activation.toFixed(4)} importance=${mem.importance} ${age}`,
      );
      const truncated = mem.content.length > 300 ? mem.content.substring(0, 300) + "..." : mem.content;
      lines.push(`  ${truncated}`);
      lines.push("");
    }
  }

  if (result.contradictions.length > 0) {
    lines.push("CONTRADICTIONS DETECTED:");
    for (const c of result.contradictions) {
      lines.push(
        `  winner=#${c.winner_id} (activation=${c.winner_activation.toFixed(4)}) vs loser=#${c.loser_id} (activation=${c.loser_activation.toFixed(4)}): ${c.reason}`,
      );
    }
    lines.push("");
  }

  if (context) {
    lines.push("CONVERSATION CONTEXT:");
    lines.push(context);
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================================
// Hallucination detection - simple keyword/substring grounding check
// ============================================================================

function extractClaims(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

function detectHallucinations(
  answer: string,
  result: BrainQueryResult,
): string[] {
  if (result.activated.length === 0) return [];

  const memoryCorpus = result.activated
    .map((m) => m.content.toLowerCase())
    .join(" ");

  const claims = extractClaims(answer);
  const flags: string[] = [];

  const stopwords = new Set([
    "this", "that", "with", "from", "have", "been", "were", "they",
    "about", "their", "there", "which", "would", "could", "should",
    "these", "those", "then", "than", "when", "what", "also", "into",
  ]);

  for (const claim of claims) {
    const keywords = claim
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4 && !stopwords.has(w));

    if (keywords.length === 0) continue;

    const matched = keywords.filter((kw) => memoryCorpus.includes(kw));
    const ratio = matched.length / keywords.length;

    if (ratio < 0.25) {
      flags.push(
        `Claim not grounded in memories: "${claim.substring(0, 80)}..."`,
      );
    }
  }

  return flags;
}

// ============================================================================
// Fallback: format BrainQueryResult as structured text when LLM unavailable
// ============================================================================

function formatFallback(
  result: BrainQueryResult,
): OracleResult {
  const sources = result.activated.map((m) => m.id);
  const confidence =
    result.activated.length > 0
      ? result.activated
          .slice(0, 5)
          .reduce((sum, m) => sum + m.activation, 0) /
        Math.min(5, result.activated.length)
      : 0;

  let answer: string;
  if (result.activated.length === 0) {
    answer = "I don't have information about that.";
  } else {
    const top = result.activated
      .slice(0, 3)
      .map((m) => `[#${m.id}] ${m.content}`)
      .join("; ");
    answer = `[Fallback - LLM unavailable] Relevant memories: ${top}`;
  }

  return {
    answer,
    sources,
    confidence,
    contradictions: result.contradictions,
    hallucination_flags: [],
    fallback: true,
  };
}

// ============================================================================
// Main oracle function
// ============================================================================

export async function queryOracle(
  query: string,
  brainResult: BrainQueryResult,
  context?: string,
): Promise<OracleResult> {
  // Fallback if LLM unavailable
  if (!isLocalModelAvailable()) {
    log.info({ msg: "oracle_fallback", reason: "llm_unavailable", query: query.substring(0, 80) });
    return formatFallback(brainResult);
  }

  // No activated memories: return early without calling LLM
  if (brainResult.activated.length === 0) {
    return {
      answer: "I don't have information about that.",
      sources: [],
      confidence: 0,
      contradictions: [],
      hallucination_flags: [],
      fallback: false,
    };
  }

  const userPrompt = buildUserPrompt(query, brainResult, context);

  let rawResponse: string;
  try {
    rawResponse = await callLocalModel(ORACLE_SYSTEM_PROMPT, userPrompt, { priority: "background" });
  } catch (e: any) {
    log.warn({ msg: "oracle_llm_failed", error: e.message });
    return formatFallback(brainResult);
  }

  // Parse JSON response from LLM
  let parsed: { answer?: string; source_ids?: unknown[] } | null = null;
  try {
    const cleaned = rawResponse
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      parsed = JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
    }
  } catch {
    parsed = { answer: rawResponse, source_ids: [] };
  }

  const answer = (parsed?.answer ?? rawResponse) as string;
  const sourceIds = Array.isArray(parsed?.source_ids)
    ? (parsed!.source_ids as unknown[])
        .map((id) => Number(id))
        .filter((id) => !isNaN(id) && id > 0)
    : brainResult.activated.map((m) => m.id);

  // Compute confidence from top memory activations
  const topActivations = [...brainResult.activated]
    .sort((a, b) => b.activation - a.activation)
    .slice(0, 5);
  const confidence =
    topActivations.length > 0
      ? topActivations.reduce((sum, m) => sum + m.activation, 0) / topActivations.length
      : 0;

  // Hallucination detection
  const hallucination_flags = detectHallucinations(answer, brainResult);

  if (hallucination_flags.length > 0) {
    log.warn({
      msg: "oracle_hallucination_flags",
      count: hallucination_flags.length,
      query: query.substring(0, 80),
    });
  }

  return {
    answer,
    sources: sourceIds,
    confidence,
    contradictions: brainResult.contradictions,
    hallucination_flags,
    fallback: false,
  };
}
