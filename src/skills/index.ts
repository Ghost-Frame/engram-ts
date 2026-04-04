export type { SkillMeta, SkillRecord, SkillSearchResult, CloudSkillCandidate, UploadMeta } from "./types.ts";
export { discoverSkills, parseSkillMd, readSkillId, writeSkillId } from "./registry.ts";
export { searchSkillsLocal } from "./search.ts";
export { fixSkill } from "./evolver.ts";
export { searchSkillsCloud, uploadSkillToCloud } from "./cloud.ts";

import { discoverSkills } from "./registry.ts";
import { embed } from "../embeddings/index.ts";
import { embeddingToBuffer } from "../embeddings/index.ts";
import { upsertSkill, updateSkillEmbeddingStmt, insertSkillTagStmt, insertSkillParentStmt, writeSkillVec } from "../db/index.ts";
import { log } from "../config/logger.ts";

/** Discover skills from dirs, upsert to DB, compute embeddings.
 *  Fire-and-forget safe - catches all errors. Returns summary. */
export async function syncSkills(dirs: string[]): Promise<{ synced: number; errors: string[] }> {
  const skills = discoverSkills(dirs);
  const errors: string[] = [];
  let synced = 0;
  for (const s of skills) {
    try {
      upsertSkill.run(
        s.skill_id, s.meta.name, s.meta.description, s.path,
        s.content, s.meta.category ?? "workflow", "imported",
        0, null, null,
      );
      for (const tag of s.meta.tags ?? []) {
        insertSkillTagStmt.run(s.skill_id, tag);
      }
      const embedText = `${s.meta.name}. ${s.meta.description}. ${s.content.slice(0, 500)}`;
      const emb = await embed(embedText);
      updateSkillEmbeddingStmt.run(embeddingToBuffer(emb), s.skill_id);
      writeSkillVec(s.skill_id, emb);
      synced++;
    } catch (e: any) {
      errors.push(`${s.skill_id}: ${e.message}`);
      log.warn({ msg: "skill_sync_error", skill_id: s.skill_id, error: e.message });
    }
  }
  return { synced, errors };
}
