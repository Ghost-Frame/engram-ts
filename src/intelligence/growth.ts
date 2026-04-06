// ============================================================================
// GROWTH ENGINE - Universal observe -> reflect -> record -> inject
// Ported from botcore pattern, adapted for server-side Engram use
// ============================================================================

import { callLocalModel, isLocalModelAvailable } from "../llm/local.ts";
import { insertReflection } from "./db.ts";
import { insertMemoryStmt } from "../memory/db.ts";
import { embed, embeddingToBuffer, cosineSimilarity, getCachedEmbeddings } from "../embeddings/index.ts";
import { db } from "../db/connection.ts";
import { log } from "../config/logger.ts";

// -- Types ------------------------------------------------------------------

export interface GrowthReflectRequest {
  service: string;
  context: string[];
  existing_growth?: string;
  prompt_override?: string;
}

export interface GrowthReflectResult {
  observation: string | null;
  stored_memory_id?: number;
  reflection_id?: number;
}

// -- Domain-specific prompts ------------------------------------------------

const SERVICE_PROMPTS: Record<string, string> = {
  engram: `You are Engram's internal self-reflection process. Engram is a persistent memory system for the Syntheos ecosystem.

Examine the recent activity and ask yourself:
- Which memories get searched most vs never?
- What contradictions persist unresolved?
- What knowledge gaps exist (frequent searches with no results)?
- What categories are growing fastest?
- Are memory quality patterns improving or degrading?`,

  "claude-code": `You are the self-reflection process for Claude Code sessions with Master (Zan).

Examine the session activity and ask yourself:
- Did a particular approach to a task work well or poorly?
- Did Master correct a pattern that should be remembered?
- Was there drift from expected behavior? Why?
- Was something learned about the codebase or infrastructure?
- Was there a communication style Master preferred?`,

  eidolon: `You are Eidolon's self-reflection process. Eidolon is the daemon that orchestrates the Syntheos neurosymbolic brain.

Examine the dream cycle results and ask yourself:
- What did this dream cycle reveal about memory patterns?
- Which patterns keep merging (over-correlated)?
- What connections are surprising?
- Is the substrate getting better or worse at targeted activation?`,

  chiasm: `You are Chiasm's self-reflection process. Chiasm is the task management system for the Syntheos ecosystem.

Examine recent task completions and ask yourself:
- What task patterns are emerging?
- How accurate are time estimates?
- Which agents are most reliable for which task types?
- What recurring blockers should be addressed?`,

  thymus: `You are Thymus's self-reflection process. Thymus monitors agent compliance and session quality.

Examine recent quality reports and ask yourself:
- Which compliance rules drift most frequently?
- Which agents show improvement over time?
- Are there patterns in when drift occurs (early vs late session)?
- What quality signals are most predictive of good outcomes?`,
};

const DEFAULT_PROMPT = `You are a self-reflection process for a service in the Syntheos ecosystem.

Examine the recent activity and extract ONE useful observation about patterns, improvements, or concerns.`;

// -- Core functions ---------------------------------------------------------

function getPromptForService(service: string, promptOverride?: string): string {
  if (promptOverride) return promptOverride;
  return SERVICE_PROMPTS[service] || DEFAULT_PROMPT;
}

export function validateObservation(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 10 || trimmed.length > 500) return false;
  if (trimmed.toUpperCase() === "NOTHING") return false;
  // Reject meta-commentary
  if (trimmed.startsWith("I don't") || trimmed.startsWith("There is nothing")) return false;
  return true;
}

async function isDuplicate(observation: string, service: string, userId: number): Promise<boolean> {
  try {
    const obsEmbedding = await embed(observation);
    if (!obsEmbedding) return false;

    // Check against recent growth memories for this service
    const recentGrowth = db.prepare(
      `SELECT id, content, embedding FROM memories
       WHERE category = 'growth' AND source = ? AND is_forgotten = 0 AND user_id = ?
       ORDER BY created_at DESC LIMIT 20`
    ).all(`${service}-growth`, userId) as any[];

    for (const mem of recentGrowth) {
      if (!mem.embedding) continue;
      const memEmb = new Float32Array(mem.embedding.buffer || mem.embedding);
      const sim = cosineSimilarity(obsEmbedding, memEmb);
      if (sim > 0.85) {
        log.info({ msg: "growth_duplicate_rejected", service, similarity: sim.toFixed(3) });
        return true;
      }
    }
  } catch (e: any) {
    log.warn({ msg: "growth_dedup_check_failed", error: e.message });
    // On failure, allow the observation through
  }
  return false;
}

export async function reflect(req: GrowthReflectRequest, userId: number = 1): Promise<GrowthReflectResult> {
  const { service, context, existing_growth, prompt_override } = req;

  if (!context || context.length === 0) {
    throw new Error("context array is required and must not be empty");
  }

  if (!isLocalModelAvailable()) {
    log.warn({ msg: "growth_reflect_skipped", reason: "llm_unavailable", service });
    return { observation: null };
  }

  const systemPrompt = getPromptForService(service, prompt_override);

  const rules = `\nRules:
- Output ONE concise observation (1-3 sentences max)
- Write in first person as ${service}
- Be specific -- not generic advice
- If nothing interesting happened, output exactly: NOTHING
- Do NOT output meta-commentary, explanations, or multiple options
- Do NOT repeat things already known`;

  const fullSystemPrompt = systemPrompt + rules;

  let userPrompt = `Recent activity:\n\n${context.join("\n")}\n\n`;
  if (existing_growth) {
    userPrompt += `Things I already know (do NOT repeat these):\n${existing_growth.slice(0, 4000)}\n\n`;
  }
  userPrompt += `What did I learn or notice? One observation, or NOTHING.`;

  try {
    const response = await callLocalModel(fullSystemPrompt, userPrompt, {
      priority: "background",
      temperature: 0.7,
      maxTokens: 300,
    });

    const trimmed = response.trim();

    if (!validateObservation(trimmed)) {
      log.info({ msg: "growth_nothing_observed", service });
      return { observation: null };
    }

    // Duplicate check
    if (await isDuplicate(trimmed, service, userId)) {
      return { observation: null };
    }

    // Store as memory with category="growth"
    const embResult = await embed(trimmed);
    const embBuffer = embResult ? embeddingToBuffer(embResult) : null;

    const memResult = insertMemoryStmt.get(
      trimmed,                    // content
      "growth",                   // category
      `${service}-growth`,        // source
      null,                       // session_id
      7,                          // importance (growth observations are important)
      embBuffer,                  // embedding
      1, 1, null, null, 1,        // version, is_latest, parent, root, source_count
      1,                          // is_static (growth observations are permanent)
      0, null, null,              // is_forgotten, forget_after, forget_reason
      0,                          // is_inference
      null,                       // model
      userId,                     // user_id
      null,                       // space_id
    ) as { id: number; created_at: string };

    // Store in reflections table too
    const now = new Date().toISOString();
    const reflResult = insertReflection.get(
      userId,
      trimmed,
      JSON.stringify([service, "growth"]),  // themes
      now,                                  // period_start
      now,                                  // period_end
      context.length,                       // memory_count (context items)
      JSON.stringify([memResult.id]),       // source_memory_ids
    ) as { id: number };

    log.info({
      msg: "growth_observation_stored",
      service,
      memory_id: memResult.id,
      reflection_id: reflResult.id,
      observation: trimmed.slice(0, 80),
    });

    return {
      observation: trimmed,
      stored_memory_id: memResult.id,
      reflection_id: reflResult.id,
    };
  } catch (e: any) {
    log.error({ msg: "growth_reflect_failed", service, error: e.message });
    return { observation: null };
  }
}

// -- Self-reflection for Engram (cron job) ----------------------------------

const countRecentMemories = db.prepare(
  `SELECT COUNT(*) as count FROM memories
   WHERE created_at > datetime('now', '-1 hour') AND user_id = ?`
);

const getMemoryStats = db.prepare(
  `SELECT
     COUNT(*) as total,
     SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END) as never_accessed,
     SUM(CASE WHEN category = 'growth' THEN 1 ELSE 0 END) as growth_count,
     AVG(importance) as avg_importance
   FROM memories WHERE is_forgotten = 0 AND user_id = ?`
);

const getTopCategories = db.prepare(
  `SELECT category, COUNT(*) as count FROM memories
   WHERE is_forgotten = 0 AND created_at > datetime('now', '-24 hours') AND user_id = ?
   GROUP BY category ORDER BY count DESC LIMIT 5`
);

const getRecentContradictions = db.prepare(
  `SELECT COUNT(*) as count FROM memory_links
   WHERE type = 'contradicts' AND created_at > datetime('now', '-24 hours')`
);

export async function selfReflect(userId: number = 1): Promise<GrowthReflectResult> {
  // Min activity threshold: 50 new memories in last hour
  const recent = countRecentMemories.get(userId) as { count: number };
  if (recent.count < 50) {
    log.debug({ msg: "growth_self_reflect_skipped", reason: "insufficient_activity", count: recent.count });
    return { observation: null };
  }

  // 15% probability gate
  if (Math.random() > 0.15) {
    return { observation: null };
  }

  // Build context from memory stats
  const stats = getMemoryStats.get(userId) as any;
  const topCats = getTopCategories.all(userId) as any[];
  const contradictions = getRecentContradictions.get() as { count: number };

  const context = [
    `Memory stats: ${stats.total} total, ${stats.never_accessed} never accessed, ${stats.growth_count} growth entries, avg importance ${(stats.avg_importance || 0).toFixed(1)}`,
    `Top categories (24h): ${topCats.map((c: any) => `${c.category}(${c.count})`).join(", ") || "none"}`,
    `Recent contradictions: ${contradictions.count}`,
    `New memories in last hour: ${recent.count}`,
  ];

  // Get existing growth for anti-repeat
  const existingGrowth = db.prepare(
    `SELECT content FROM memories WHERE category = 'growth' AND source = 'engram-growth' AND is_forgotten = 0 AND user_id = ?
     ORDER BY created_at DESC LIMIT 10`
  ).all(userId) as any[];
  const existingText = existingGrowth.map((g: any) => `- ${g.content}`).join("\n");

  return reflect({
    service: "engram",
    context,
    existing_growth: existingText,
  }, userId);
}
