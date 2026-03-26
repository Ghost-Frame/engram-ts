import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { callLLM, isLLMAvailable } from "../llm/index.ts";
import { embed, embeddingToBuffer } from "../embeddings/index.ts";
import { updateSkillContentStmt, updateSkillEmbeddingStmt, writeSkillVec } from "../db/index.ts";
import { log } from "../config/logger.ts";
import { parseSkillMd } from "./registry.ts";
import type { UploadMeta } from "./types.ts";

const SYSTEM_PROMPT = `You are a skill editor. You receive a SKILL.md file and a direction describing what to fix.

Output the COMPLETE updated SKILL.md file. Rules:
1. Keep the YAML frontmatter (--- delimiters, name, description fields). Update name/description only if the fix changes the skill's purpose.
2. Apply the fix described in the direction to the instructions body.
3. Do NOT add commentary outside the SKILL.md content.
4. Output ONLY the raw SKILL.md content, starting with --- and ending with the last line of instructions. No markdown code fences.`;

/** Patch a SKILL.md file using LLM, update DB, write .upload_meta.json.
 *  Returns the new content. */
export async function fixSkill(skillId: string, skillPath: string, direction: string): Promise<string> {
  if (!isLLMAvailable()) throw new Error("No LLM configured. Set LLM_URL/LLM_API_KEY.");

  const skillFile = join(skillPath, "SKILL.md");
  if (!existsSync(skillFile)) throw new Error(`SKILL.md not found at ${skillFile}`);

  const original = readFileSync(skillFile, "utf-8");

  const userPrompt = `<skill_md>\n${original}\n</skill_md>\n\n<direction>\n${direction}\n</direction>`;
  let patched = await callLLM(SYSTEM_PROMPT, userPrompt);

  // Strip accidental markdown code fences
  patched = patched.replace(/^```(?:markdown|md)?\n?/i, "").replace(/\n?```$/, "").trim();
  if (!patched.startsWith("---") && !patched.startsWith("#")) {
    throw new Error("LLM returned unexpected format - does not start with --- or #");
  }

  // Write to filesystem
  writeFileSync(skillFile, patched, "utf-8");

  // Write .upload_meta.json sidecar
  const meta: UploadMeta = {
    origin: "fixed",
    parent_skill_ids: [skillId],
    tags: [],
    created_by: "engram",
    change_summary: direction.slice(0, 200),
  };
  writeFileSync(join(skillPath, ".upload_meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");

  // Update DB
  const newMeta = parseSkillMd(patched);
  updateSkillContentStmt.run(patched, newMeta.name || skillId, newMeta.description || "", skillId);

  // Re-embed
  try {
    const embedText = `${newMeta.name}. ${newMeta.description}. ${patched.slice(0, 500)}`;
    const emb = await embed(embedText);
    updateSkillEmbeddingStmt.run(embeddingToBuffer(emb), skillId);
    writeSkillVec(skillId, emb);
  } catch (e: any) {
    log.warn({ msg: "skill_re_embed_failed", skill_id: skillId, error: e.message });
  }

  return patched;
}
