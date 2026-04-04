import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import type { SkillMeta } from "./types.ts";

const SKILL_ID_FILE = ".skill_id";
const SKILL_MD_FILE = "SKILL.md";

/** Parse YAML frontmatter from SKILL.md without an external YAML dep.
 *  Handles: name, description, category, tags (inline array [a, b, c]).
 *  Falls back to first H1 heading for name if frontmatter is missing/empty. */
export function parseSkillMd(raw: string): SkillMeta {
  const meta: SkillMeta = { name: "", description: "" };
  if (!raw.startsWith("---")) {
    const h1 = raw.match(/^#\s+(.+)$/m);
    if (h1) meta.name = h1[1].trim();
    return meta;
  }
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) return meta;
  const frontmatter = raw.slice(4, endIdx);
  for (const line of frontmatter.split("\n")) {
    const m = line.trim().match(/^(\w+)\s*:\s*(.+)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.replace(/^["']|["']$/g, "").trim();
    switch (key) {
      case "name": meta.name = val; break;
      case "description": meta.description = val; break;
      case "category": meta.category = val as any; break;
      case "tags": {
        const inner = val.replace(/^\[|\]$/g, "");
        meta.tags = inner.split(",").map(t => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        break;
      }
    }
  }
  if (!meta.name) {
    const body = raw.slice(endIdx + 4);
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) meta.name = h1[1].trim();
  }
  return meta;
}

export function readSkillId(skillDir: string): string | null {
  try { return readFileSync(join(skillDir, SKILL_ID_FILE), "utf-8").trim() || null; }
  catch { return null; }
}

export function writeSkillId(skillDir: string, id: string): void {
  writeFileSync(join(skillDir, SKILL_ID_FILE), id + "\n", "utf-8");
}

export interface DiscoveredSkill {
  skill_id: string;
  path: string;       // absolute path to skill directory
  content: string;    // raw SKILL.md content
  meta: SkillMeta;
}

/** Walk directories recursively, yield skill dirs (containing SKILL.md).
 *  Skips hidden dirs and node_modules. Does NOT recurse into skill dirs. */
function* walkSkillDirs(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch { return; }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch { continue; }
    if (existsSync(join(full, SKILL_MD_FILE))) {
      yield full;
    } else {
      yield* walkSkillDirs(full);
    }
  }
}

export function discoverSkills(dirs: string[]): DiscoveredSkill[] {
  const found: DiscoveredSkill[] = [];
  for (const dir of dirs) {
    const absDir = resolve(dir);
    for (const skillDir of walkSkillDirs(absDir)) {
      try {
        const content = readFileSync(join(skillDir, SKILL_MD_FILE), "utf-8");
        const meta = parseSkillMd(content);
        if (!meta.name) continue; // skip malformed skills
        let skill_id = readSkillId(skillDir);
        if (!skill_id) {
          const safeName = meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
          skill_id = `${safeName}__imp_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
          try { writeSkillId(skillDir, skill_id); } catch {}
        }
        found.push({ skill_id, path: skillDir, content, meta });
      } catch { /* skip unreadable */ }
    }
  }
  return found;
}
