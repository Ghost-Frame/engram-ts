// ============================================================================
// CONSOLIDATION - Auto-summarize memory clusters
// ============================================================================

import { db, insertMemory, insertLink, writeVec, getClusterMembers, getClusterCandidates } from "../db/index.ts";
import { log } from "../config/logger.ts";
import { LLM_API_KEY, CONSOLIDATION_THRESHOLD } from "../config/index.ts";
import { callLLM, repairAndParseJSON } from "../llm/index.ts";
import { embed, embeddingToBuffer } from "../embeddings/index.ts";
import { autoLink } from "../memory/search.ts";

// ============================================================================
// MEMORY CONSOLIDATION - Auto-summarize large clusters
// ============================================================================

const CONSOLIDATION_PROMPT = `You are a memory consolidation engine. Given a cluster of related memories and their extracted facts, merge and deduplicate into a clean fact set.

Rules:
- Identify duplicate or near-duplicate facts and keep only the most recent/complete version
- Group related facts by topic or entity
- Preserve ALL specific values: IPs, ports, paths, versions, dates, names
- Do NOT add interpretation -- only merge what exists
- Keep the original wording where possible

Respond with ONLY a JSON object:
{
  "title": "short 3-5 word cluster label",
  "merged_facts": ["fact 1", "fact 2"],
  "removed_duplicates": ["duplicate fact that was removed"],
  "importance": 1-10
}`;

export async function consolidateCluster(
  centerMemoryId: number,
  userId: number = 1
): Promise<{ summaryId: number; archivedCount: number } | null> {
  if (!LLM_API_KEY) return null;

  const members = getClusterMembers.all(centerMemoryId, userId, userId) as Array<any>;
  if (members.length < CONSOLIDATION_THRESHOLD) return null;

  // Check if already consolidated
  const existing = db.prepare(
      `SELECT id FROM consolidations WHERE user_id = ? AND source_memory_ids LIKE ?`
  ).get(userId, `%${centerMemoryId}%`) as any;
  if (existing) return null;

  const memberContents = members.map(m => {
    const facts = db.prepare(
      "SELECT content FROM memories WHERE parent_memory_id = ? AND is_fact = 1"
    ).all(m.id) as Array<{ content: string }>;
    const factLines = facts.length > 0
      ? "\n  Facts: " + facts.map(f => f.content).join("; ")
      : "";
    return `[#${m.id}, ${m.category}, imp=${m.importance}]: ${m.content}${factLines}`;
  }).join("\n\n");

  try {
    const response = await callLLM(CONSOLIDATION_PROMPT, memberContents);
    const result = repairAndParseJSON(response) as { summary?: string; title: string; importance: number; merged_facts?: string[]; removed_duplicates?: string[] } | null;
    if (!result || (!result.summary && !result.merged_facts)) {
      log.error({ msg: "consolidation_parse_failed", center_id: centerMemoryId });
      return null;
    }

    // Fix: ensure title is a non-empty string, fallback to first words of summary or facts
    if (typeof result.title !== "string" || !result.title.trim()) {
      const fallbackSource = result.summary || (result.merged_facts && result.merged_facts[0]) || "consolidated memory";
      result.title = fallbackSource.split(/\s+/).slice(0, 5).join(" ");
      log.warn({ msg: "consolidation_title_fallback", center_id: centerMemoryId, derived_title: result.title });
    }

    // Create consolidated summary memory
    const mergedFacts = (result as any).merged_facts;
    const mergedContent = mergedFacts && Array.isArray(mergedFacts)
      ? `[Consolidated: ${result.title}]\n- ${mergedFacts.join("\n- ")}`
      : `[Consolidated: ${result.title}] ${result.summary || ""}`;
    const embArray = await embed(mergedContent);
    const embBuffer = embeddingToBuffer(embArray);
    const imp = Math.max(1, Math.min(10, result.importance || 8));

    const summaryMem = insertMemory.get(
      mergedContent,
      "discovery", "consolidation", null, imp, embBuffer,
      1, 1, null, null, members.length, 1, 0, null, null, 0, null, userId, null
    ) as { id: number; created_at: string };

    const titleSlug = result.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    db.prepare("UPDATE memories SET tags = ? WHERE id = ?").run(
      JSON.stringify(["consolidated", titleSlug]), summaryMem.id
    );

    // Link source memories -- NOT archived, they remain searchable
    let linked = 0;
    for (const m of members) {
      insertLink.run(summaryMem.id, m.id, 1.0, "consolidates");
      linked++;
    }

    // Track consolidation
    db.prepare(
       `INSERT INTO consolidations (summary_memory_id, source_memory_ids, user_id, cluster_label)
        VALUES (?, ?, ?, ?)`
    ).run(summaryMem.id, JSON.stringify(members.map(m => m.id)), userId, result.title);

    writeVec(summaryMem.id, embArray);
    await autoLink(summaryMem.id, embArray, userId);
    log.info({ msg: "consolidated", linked, summary_id: summaryMem.id, title: result.title });
    return { summaryId: summaryMem.id, linkedCount: linked };
  } catch (e: any) {
    log.error({ msg: "consolidation_failed", center_id: centerMemoryId, error: e.message });
    return null;
  }
}

export async function runConsolidationSweep(userId: number = 1): Promise<number> {
  const candidates = getClusterCandidates.all(userId, CONSOLIDATION_THRESHOLD) as Array<{ source_id: number; link_count: number }>;
  let totalConsolidated = 0;
  for (const c of candidates) {
    const result = await consolidateCluster(c.source_id, userId);
    if (result) totalConsolidated += result.linkedCount;
  }
  return totalConsolidated;
}
