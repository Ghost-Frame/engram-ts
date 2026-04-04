// ============================================================================
// SKILL PATCH - Content snapshots, diffs, file operations for skill evolution
// Ported from OpenSpace skill_engine/patch.py
// ============================================================================

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, cpSync } from "fs";
import { join, relative, basename } from "path";
import { log } from "../config/logger.ts";
import type { SkillEditResult, PatchType } from "./types.ts";

// --- Snapshot: capture all files in a skill directory ---

export function collectSkillSnapshot(skillDir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (!existsSync(skillDir)) return snapshot;

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          walk(full);
        } else {
          const rel = relative(skillDir, full).replace(/\\/g, "/");
          try {
            snapshot[rel] = readFileSync(full, "utf-8");
          } catch { /* skip binary/unreadable */ }
        }
      } catch { continue; }
    }
  }

  walk(skillDir);
  return snapshot;
}

// --- Unified diff generation ---

export function computeUnifiedDiff(
  before: Record<string, string>,
  after: Record<string, string>
): string {
  const lines: string[] = [];
  const allPaths = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const path of [...allPaths].sort()) {
    const old = before[path];
    const cur = after[path];

    if (old === undefined && cur !== undefined) {
      // Added file
      lines.push(`--- /dev/null`);
      lines.push(`+++ b/${path}`);
      for (const line of cur.split("\n")) {
        lines.push(`+${line}`);
      }
    } else if (old !== undefined && cur === undefined) {
      // Deleted file
      lines.push(`--- a/${path}`);
      lines.push(`+++ /dev/null`);
      for (const line of old.split("\n")) {
        lines.push(`-${line}`);
      }
    } else if (old !== cur) {
      // Modified file -- simple line diff
      lines.push(`--- a/${path}`);
      lines.push(`+++ b/${path}`);
      const oldLines = (old ?? "").split("\n");
      const newLines = (cur ?? "").split("\n");
      // Simple diff: show removed then added (not optimal but functional)
      const maxLen = Math.max(oldLines.length, newLines.length);
      let inChange = false;
      let changeStart = 0;
      const changes: Array<{ start: number; oldEnd: number; newEnd: number }> = [];

      // Find contiguous change blocks
      let i = 0, j = 0;
      while (i < oldLines.length || j < newLines.length) {
        if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
          if (inChange) {
            changes.push({ start: changeStart, oldEnd: i, newEnd: j });
            inChange = false;
          }
          i++; j++;
        } else {
          if (!inChange) {
            changeStart = i;
            inChange = true;
          }
          // Advance the shorter side or both
          if (i < oldLines.length) i++;
          if (j < newLines.length) j++;
        }
      }
      if (inChange) {
        changes.push({ start: changeStart, oldEnd: oldLines.length, newEnd: newLines.length });
      }

      if (changes.length === 0 && old !== cur) {
        // Fallback: entire file changed
        for (const line of oldLines) lines.push(`-${line}`);
        for (const line of newLines) lines.push(`+${line}`);
      } else {
        for (const c of changes) {
          const ctxStart = Math.max(0, c.start - 3);
          lines.push(`@@ -${c.start + 1},${c.oldEnd - c.start} +${c.start + 1},${c.newEnd - c.start} @@`);
          for (let k = c.start; k < c.oldEnd; k++) {
            if (k < oldLines.length) lines.push(`-${oldLines[k]}`);
          }
          for (let k = c.start; k < c.newEnd; k++) {
            if (k < newLines.length) lines.push(`+${newLines[k]}`);
          }
        }
      }
    }
  }

  return lines.join("\n");
}

// --- Patch type detection ---

export function detectPatchType(content: string): PatchType {
  if (content.includes("*** Begin Patch")) return "patch";
  if (content.includes("*** Begin Files") || content.includes("*** File:")) return "full";
  if (content.includes("<<<<<<< SEARCH")) return "diff";
  return "full";
}

// --- Apply SEARCH/REPLACE diff to content ---

function applySearchReplace(original: string, patch: string): string {
  let result = original;
  const blocks = patch.split("<<<<<<< SEARCH");

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const sepIdx = block.indexOf("=======");
    if (sepIdx === -1) continue;
    const endIdx = block.indexOf(">>>>>>> REPLACE", sepIdx);
    if (endIdx === -1) continue;

    const search = block.slice(0, sepIdx).trim();
    const replace = block.slice(sepIdx + 7, endIdx).trim();

    if (result.includes(search)) {
      result = result.replace(search, replace);
    } else {
      log.warn({ msg: "search_replace_miss", search_preview: search.slice(0, 80) });
    }
  }
  return result;
}

// --- Parse multi-file envelope ---

function parseMultiFile(content: string): Record<string, string> {
  const files: Record<string, string> = {};
  const marker = "*** File:";
  const parts = content.split(marker);

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const nlIdx = part.indexOf("\n");
    if (nlIdx === -1) continue;
    const filename = part.slice(0, nlIdx).trim();
    let body = part.slice(nlIdx + 1);
    // Trim end markers
    const endIdx = body.indexOf("*** End Files");
    if (endIdx !== -1) body = body.slice(0, endIdx);
    const nextFile = body.indexOf("*** File:");
    if (nextFile !== -1) body = body.slice(0, nextFile);
    files[filename] = body.trimEnd();
  }
  return files;
}

// --- Create a brand new skill ---

export function createSkill(
  targetDir: string,
  content: string,
  meta?: { name?: string; description?: string }
): SkillEditResult {
  try {
    mkdirSync(targetDir, { recursive: true });

    const patchType = detectPatchType(content);
    const snapshot: Record<string, string> = {};

    if (patchType === "full" && (content.includes("*** Begin Files") || content.includes("*** File:"))) {
      const files = parseMultiFile(content);
      for (const [path, body] of Object.entries(files)) {
        const fullPath = join(targetDir, path);
        mkdirSync(join(targetDir, path, ".."), { recursive: true });
        writeFileSync(fullPath, body, "utf-8");
        snapshot[path] = body;
      }
    } else {
      // Single file -- treat as SKILL.md
      writeFileSync(join(targetDir, "SKILL.md"), content, "utf-8");
      snapshot["SKILL.md"] = content;
    }

    return { success: true, skill_dir: targetDir, content, snapshot, diff: "" };
  } catch (e: any) {
    return { success: false, skill_dir: targetDir, content: "", snapshot: {}, diff: "", error: e.message };
  }
}

// --- Fix a skill in-place ---

export function fixSkillFiles(
  skillDir: string,
  newContent: string
): SkillEditResult {
  try {
    const before = collectSkillSnapshot(skillDir);
    const patchType = detectPatchType(newContent);

    if (patchType === "diff") {
      // SEARCH/REPLACE on SKILL.md
      const original = before["SKILL.md"] ?? "";
      const patched = applySearchReplace(original, newContent);
      writeFileSync(join(skillDir, "SKILL.md"), patched, "utf-8");
    } else if (patchType === "full" && (newContent.includes("*** Begin Files") || newContent.includes("*** File:"))) {
      const files = parseMultiFile(newContent);
      for (const [path, body] of Object.entries(files)) {
        const fullPath = join(skillDir, path);
        mkdirSync(join(fullPath, ".."), { recursive: true });
        writeFileSync(fullPath, body, "utf-8");
      }
    } else {
      // Single file content -> overwrite SKILL.md
      writeFileSync(join(skillDir, "SKILL.md"), newContent, "utf-8");
    }

    const after = collectSkillSnapshot(skillDir);
    const diff = computeUnifiedDiff(before, after);

    return { success: true, skill_dir: skillDir, content: newContent, snapshot: after, diff };
  } catch (e: any) {
    return { success: false, skill_dir: skillDir, content: "", snapshot: {}, diff: "", error: e.message };
  }
}

// --- Derive a new skill from parent(s) ---

export function deriveSkill(
  sourceDirs: string[],
  targetDir: string,
  content: string
): SkillEditResult {
  try {
    mkdirSync(targetDir, { recursive: true });

    // If single parent, copy its auxiliary files first
    if (sourceDirs.length === 1 && existsSync(sourceDirs[0])) {
      const parentDir = sourceDirs[0];
      const entries = readdirSync(parentDir);
      for (const entry of entries) {
        if (entry === "SKILL.md" || entry === ".skill_id" || entry === ".upload_meta.json") continue;
        if (entry.startsWith(".")) continue;
        const src = join(parentDir, entry);
        const dst = join(targetDir, entry);
        try {
          if (statSync(src).isDirectory()) {
            cpSync(src, dst, { recursive: true });
          } else {
            writeFileSync(dst, readFileSync(src));
          }
        } catch { /* skip */ }
      }
    }

    // Write the new SKILL.md or multi-file content
    const patchType = detectPatchType(content);
    if (patchType === "full" && (content.includes("*** Begin Files") || content.includes("*** File:"))) {
      const files = parseMultiFile(content);
      for (const [path, body] of Object.entries(files)) {
        const fullPath = join(targetDir, path);
        mkdirSync(join(fullPath, ".."), { recursive: true });
        writeFileSync(fullPath, body, "utf-8");
      }
    } else {
      writeFileSync(join(targetDir, "SKILL.md"), content, "utf-8");
    }

    const snapshot = collectSkillSnapshot(targetDir);

    // Compute diff against first parent if single-parent derive
    let diff = "";
    if (sourceDirs.length === 1) {
      const parentSnapshot = collectSkillSnapshot(sourceDirs[0]);
      diff = computeUnifiedDiff(parentSnapshot, snapshot);
    }

    return { success: true, skill_dir: targetDir, content, snapshot, diff };
  } catch (e: any) {
    return { success: false, skill_dir: targetDir, content: "", snapshot: {}, diff: "", error: e.message };
  }
}
