// ============================================================================
// SKILL EVOLVER - Full FIX/DERIVED/CAPTURED evolution system
// Ported from OpenSpace skill_engine/evolver.py
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { randomUUID } from "crypto";
import { repairAndParseJSON } from "../llm/index.ts";
import { callLocalModel, isLocalModelAvailable } from "../llm/local.ts";
import { embed, embeddingToBuffer } from "../embeddings/index.ts";
import {
  upsertSkill, updateSkillContentStmt, updateSkillEmbeddingStmt, writeSkillVec,
  deactivateSkill, insertSkillParentStmt, insertSkillTagStmt, getSkillById,
} from "../db/index.ts";
import { log } from "../config/logger.ts";
import { parseSkillMd, writeSkillId } from "./registry.ts";
import { collectSkillSnapshot, computeUnifiedDiff, fixSkillFiles, deriveSkill, createSkill } from "./patch.ts";
import type {
  UploadMeta, EvolutionType, EvolutionContext, SkillEditResult,
  SkillRecord, EvolutionSuggestion,
} from "./types.ts";

// --- LLM Prompts ---

const FIX_SYSTEM_PROMPT = `You are a skill editor. You receive a SKILL.md file and a direction describing what to fix.

Output the COMPLETE updated SKILL.md file. Rules:
1. Keep the YAML frontmatter (--- delimiters, name, description fields). Update name/description only if the fix changes the skill's purpose.
2. Apply the fix described in the direction to the instructions body.
3. Do NOT add commentary outside the SKILL.md content.
4. Output ONLY the raw SKILL.md content, starting with --- and ending with the last line of instructions. No markdown code fences.`;

const DERIVE_SYSTEM_PROMPT = `You are a skill architect. You receive one or more parent SKILL.md files and a direction for creating an enhanced or merged skill.

Output the COMPLETE new SKILL.md file. Rules:
1. Include YAML frontmatter (--- delimiters) with name and description fields.
2. Synthesize the best aspects of the parent skills while applying the enhancement direction.
3. The new skill should be self-contained and not reference the parent skills.
4. Output ONLY the raw SKILL.md content. No markdown code fences.`;

const CAPTURE_SYSTEM_PROMPT = `You are a skill architect. You receive a description of a novel pattern observed during task execution.

Output a COMPLETE new SKILL.md file that captures this pattern. Rules:
1. Include YAML frontmatter (--- delimiters) with name and description fields.
2. Write clear, actionable instructions that would help an agent replicate the pattern.
3. Include relevant context, prerequisites, and expected outcomes.
4. Output ONLY the raw SKILL.md content. No markdown code fences.`;

// --- Helper: strip code fences from LLM output ---

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:markdown|md|yaml)?\n?/i, "").replace(/\n?```$/, "").trim();
}

// --- Helper: generate skill ID ---

function generateSkillId(name: string, origin: EvolutionType, generation: number): string {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const hex = randomUUID().replace(/-/g, "").slice(0, 8);
  if (origin === "fix") return `${safeName}__v${generation}_${hex}`;
  if (origin === "derived") return `${safeName}__v${generation}_${hex}`;
  return `${safeName}__cap_${hex}`;
}

// --- Helper: persist evolved skill to DB ---

async function persistEvolvedSkill(
  skillId: string,
  name: string,
  description: string,
  skillDir: string,
  content: string,
  origin: string,
  generation: number,
  changeSummary: string,
  sourceTaskId: string | null,
  contentDiff: string,
  contentSnapshot: Record<string, string>,
  parentSkillIds: string[],
  tags: string[],
  creatorId: string,
): Promise<void> {
  upsertSkill.run(
    skillId, name, description, skillDir, content,
    "workflow", origin, generation, changeSummary, creatorId,
    "private", sourceTaskId, contentDiff, JSON.stringify(contentSnapshot), 0,
  );

  for (const parentId of parentSkillIds) {
    insertSkillParentStmt.run(skillId, parentId);
  }

  for (const tag of tags) {
    insertSkillTagStmt.run(skillId, tag);
  }

  // Embed
  try {
    const embedText = `${name}. ${description}. ${content.slice(0, 500)}`;
    const emb = await embed(embedText);
    updateSkillEmbeddingStmt.run(embeddingToBuffer(emb), skillId);
    writeSkillVec(skillId, emb);
  } catch (e: any) {
    log.warn({ msg: "evolved_skill_embed_failed", skill_id: skillId, error: e.message });
  }

  // Write .skill_id sidecar
  try { writeSkillId(skillDir, skillId); } catch {}

  // Write .upload_meta.json
  const meta: UploadMeta = {
    origin,
    parent_skill_ids: parentSkillIds,
    tags,
    created_by: creatorId,
    change_summary: changeSummary,
  };
  try {
    writeFileSync(join(skillDir, ".upload_meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
  } catch {}
}

// ============================================================================
// FIX EVOLUTION - Repair broken instructions in-place
// ============================================================================

export async function fixSkill(
  skillId: string,
  skillPath: string,
  direction: string,
  sourceTaskId?: string | null,
): Promise<string> {
  if (!isLocalModelAvailable()) throw new Error("Local model not available. Check Ollama is running.");

  const skillFile = join(skillPath, "SKILL.md");
  if (!existsSync(skillFile)) throw new Error(`SKILL.md not found at ${skillFile}`);

  const original = readFileSync(skillFile, "utf-8");
  const beforeSnapshot = collectSkillSnapshot(skillPath);

  // Get existing record for lineage
  const existingRow = getSkillById.get(skillId) as SkillRecord | undefined;
  const oldGeneration = existingRow?.generation ?? 0;
  const newGeneration = oldGeneration + 1;

  // Call LLM
  const userPrompt = `<skill_md>\n${original}\n</skill_md>\n\n<direction>\n${direction}\n</direction>`;
  let patched = await callLocalModel(FIX_SYSTEM_PROMPT, userPrompt, { priority: "background" });
  patched = stripCodeFences(patched);

  if (!patched.startsWith("---") && !patched.startsWith("#")) {
    throw new Error("LLM returned unexpected format -- does not start with --- or #");
  }

  // Apply patch to filesystem
  const editResult = fixSkillFiles(skillPath, patched);
  if (!editResult.success) throw new Error(`Patch failed: ${editResult.error}`);

  const afterSnapshot = collectSkillSnapshot(skillPath);
  const diff = computeUnifiedDiff(beforeSnapshot, afterSnapshot);

  // Parse new metadata
  const newMeta = parseSkillMd(patched);
  const newName = newMeta.name || existingRow?.name || skillId;

  // Generate new skill ID for this version
  const newSkillId = generateSkillId(newName, "fix", newGeneration);

  // Deactivate old version
  deactivateSkill.run(skillId);

  // Persist new version
  await persistEvolvedSkill(
    newSkillId, newName, newMeta.description || "",
    skillPath, patched, "fixed", newGeneration,
    direction.slice(0, 500), sourceTaskId ?? null,
    diff, afterSnapshot, [skillId],
    newMeta.tags ?? [], "engram",
  );

  log.info({
    msg: "skill_fixed",
    old_id: skillId,
    new_id: newSkillId,
    generation: newGeneration,
  });

  return patched;
}

// ============================================================================
// DERIVED EVOLUTION - Create enhanced version from existing skill(s)
// ============================================================================

export async function deriveSkillEvolution(
  parentSkillIds: string[],
  direction: string,
  sourceTaskId?: string | null,
): Promise<{ skill_id: string; content: string; path: string }> {
  if (!isLocalModelAvailable()) throw new Error("Local model not available.");
  if (parentSkillIds.length === 0) throw new Error("At least one parent skill required for derivation.");

  // Load parent skills
  const parents: SkillRecord[] = [];
  const parentContents: string[] = [];
  const parentDirs: string[] = [];

  for (const pid of parentSkillIds) {
    const row = getSkillById.get(pid) as SkillRecord | undefined;
    if (!row) throw new Error(`Parent skill not found: ${pid}`);
    parents.push(row);
    parentContents.push(row.content);
    parentDirs.push(row.path);
  }

  const maxGeneration = Math.max(...parents.map(p => p.generation));
  const newGeneration = maxGeneration + 1;

  // Build LLM prompt
  const parentSection = parents.map((p, i) =>
    `<parent_skill index="${i}" name="${p.name}">\n${p.content}\n</parent_skill>`
  ).join("\n\n");

  const userPrompt = `${parentSection}\n\n<direction>\n${direction}\n</direction>`;
  let newContent = await callLocalModel(DERIVE_SYSTEM_PROMPT, userPrompt, { priority: "background" });
  newContent = stripCodeFences(newContent);

  if (!newContent.startsWith("---") && !newContent.startsWith("#")) {
    throw new Error("LLM returned unexpected format");
  }

  const newMeta = parseSkillMd(newContent);
  const newName = newMeta.name || `derived-${parents[0].name}`;
  const newSkillId = generateSkillId(newName, "derived", newGeneration);

  // Create new directory alongside first parent
  const parentBase = dirname(parentDirs[0]);
  const newDirName = newName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  const newDir = join(parentBase, newDirName);

  const editResult = deriveSkill(parentDirs, newDir, newContent);
  if (!editResult.success) throw new Error(`Derive failed: ${editResult.error}`);

  // Persist (parents stay active)
  await persistEvolvedSkill(
    newSkillId, newName, newMeta.description || "",
    newDir, newContent, "derived", newGeneration,
    direction.slice(0, 500), sourceTaskId ?? null,
    editResult.diff, editResult.snapshot, parentSkillIds,
    newMeta.tags ?? [], "engram",
  );

  log.info({
    msg: "skill_derived",
    new_id: newSkillId,
    parents: parentSkillIds,
    generation: newGeneration,
  });

  return { skill_id: newSkillId, content: newContent, path: newDir };
}

// ============================================================================
// CAPTURED EVOLUTION - Capture novel pattern as new skill
// ============================================================================

export async function captureSkill(
  direction: string,
  baseDir: string,
  sourceTaskId?: string | null,
): Promise<{ skill_id: string; content: string; path: string }> {
  if (!isLocalModelAvailable()) throw new Error("Local model not available.");

  const userPrompt = `<pattern_description>\n${direction}\n</pattern_description>`;
  let newContent = await callLocalModel(CAPTURE_SYSTEM_PROMPT, userPrompt, { priority: "background" });
  newContent = stripCodeFences(newContent);

  if (!newContent.startsWith("---") && !newContent.startsWith("#")) {
    throw new Error("LLM returned unexpected format");
  }

  const newMeta = parseSkillMd(newContent);
  const newName = newMeta.name || "captured-skill";
  const newSkillId = generateSkillId(newName, "captured", 0);

  // Create directory
  const newDirName = newName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  const newDir = join(baseDir, newDirName);

  const editResult = createSkill(newDir, newContent);
  if (!editResult.success) throw new Error(`Capture failed: ${editResult.error}`);

  // Persist (no parents)
  await persistEvolvedSkill(
    newSkillId, newName, newMeta.description || "",
    newDir, newContent, "captured", 0,
    direction.slice(0, 500), sourceTaskId ?? null,
    "", editResult.snapshot, [],
    newMeta.tags ?? [], "engram",
  );

  log.info({ msg: "skill_captured", skill_id: newSkillId });

  return { skill_id: newSkillId, content: newContent, path: newDir };
}

// ============================================================================
// EVOLVE DISPATCHER - Route evolution suggestions to handlers
// ============================================================================

export async function evolve(context: EvolutionContext): Promise<{
  evolved: boolean;
  skill_id?: string;
  error?: string;
}> {
  const { suggestion, skill_records, skill_dirs, source_task_id } = context;

  try {
    switch (suggestion.evolution_type) {
      case "fix": {
        if (skill_records.length === 0) return { evolved: false, error: "No target skill for FIX" };
        const target = skill_records[0];
        const content = await fixSkill(
          target.skill_id, target.path,
          suggestion.direction, source_task_id,
        );
        return { evolved: true, skill_id: target.skill_id };
      }

      case "derived": {
        const parentIds = suggestion.target_skill_ids.length > 0
          ? suggestion.target_skill_ids
          : skill_records.map(r => r.skill_id);
        if (parentIds.length === 0) return { evolved: false, error: "No parent skills for DERIVED" };
        const baseDir = skill_dirs[0] ? dirname(skill_dirs[0]) : ".";
        const result = await deriveSkillEvolution(
          parentIds, suggestion.direction, source_task_id,
        );
        return { evolved: true, skill_id: result.skill_id };
      }

      case "captured": {
        const baseDir = skill_dirs[0] ? dirname(skill_dirs[0]) : ".";
        const result = await captureSkill(
          suggestion.direction, baseDir, source_task_id,
        );
        return { evolved: true, skill_id: result.skill_id };
      }

      default:
        return { evolved: false, error: `Unknown evolution type: ${suggestion.evolution_type}` };
    }
  } catch (e: any) {
    log.error({ msg: "evolution_failed", type: suggestion.evolution_type, error: e.message });
    return { evolved: false, error: e.message };
  }
}
