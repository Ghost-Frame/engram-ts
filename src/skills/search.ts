import { embed } from "../embeddings/index.ts";
import { sanitizeFTS } from "../helpers/index.ts";
import { searchSkillsFTSStmt, getAllSkillEmbeddingsStmt } from "../db/index.ts";
import { log } from "../config/logger.ts";
import type { SkillSearchResult } from "./types.ts";

/** Cosine similarity between two Float32Array vectors (assumes normalized). */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function normalize(v: Float32Array): Float32Array {
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  if (mag === 0) return v;
  return v.map(x => x / mag) as Float32Array;
}

const RRF_K = 60;

/** Hybrid BM25+vector search using Reciprocal Rank Fusion. Falls back to FTS-only if embedding fails. */
export async function searchSkillsLocal(query: string, limit = 20): Promise<SkillSearchResult[]> {
  const ftsQuery = sanitizeFTS(query);
  const ftsLimit = Math.min(limit * 3, 100);

  // FTS pass -- guard against empty sanitizeFTS result (all-punctuation queries return "")
  const ftsRows = ftsQuery.trim()
    ? (searchSkillsFTSStmt.all(ftsQuery, ftsLimit) as any[])
    : [];

  // Vector pass
  let vectorRanked: Array<{ skill_id: string; score: number }> = [];
  try {
    const queryEmb = normalize(await embed(query));
    const allEmbs = getAllSkillEmbeddingsStmt.all() as Array<{
      skill_id: string;
      embedding: Buffer | null;
    }>;
    const scored = allEmbs
      .filter(r => r.embedding)
      .map(r => {
        const raw = new Float32Array(r.embedding!.buffer, r.embedding!.byteOffset, r.embedding!.byteLength / 4);
        return { skill_id: r.skill_id, score: cosineSim(queryEmb, normalize(raw)) };
      })
      .filter(r => r.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, ftsLimit);
    vectorRanked = scored;
  } catch (e: any) {
    log.warn({ msg: "skill_embed_failed", error: e.message });
  }

  // Build union of candidate IDs
  const ftsMap = new Map(ftsRows.map((r, i) => [r.skill_id, i + 1]));
  const vecMap = new Map(vectorRanked.map((r, i) => [r.skill_id, i + 1]));
  const maxRank = Math.max(ftsRows.length, vectorRanked.length) + 1;
  const allIds = new Set([...ftsMap.keys(), ...vecMap.keys()]);

  // RRF fusion
  const fused = Array.from(allIds).map(id => ({
    skill_id: id,
    score: 1 / (RRF_K + (ftsMap.get(id) ?? maxRank)) + 1 / (RRF_K + (vecMap.get(id) ?? maxRank)),
  })).sort((a, b) => b.score - a.score).slice(0, limit);

  // Hydrate with full metadata from FTS results (all candidates are already queried)
  const ftsById = new Map(ftsRows.map(r => [r.skill_id, r]));
  return fused.map(({ skill_id, score }) => {
    const row = ftsById.get(skill_id);
    return {
      skill_id,
      name: row?.name ?? skill_id,
      description: row?.description ?? "",
      path: row?.path ?? "",
      category: row?.category ?? "workflow",
      origin: row?.origin ?? "imported",
      score,
      source: "local" as const,
    };
  });
}
