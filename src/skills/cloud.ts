import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { OPENSPACE_API_KEY, OPENSPACE_API_URL } from "../config/index.ts";
import type { CloudSkillCandidate, UploadMeta } from "./types.ts";

const TIMEOUT = 10_000;

function cloudHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${OPENSPACE_API_KEY}`,
  };
}

/** Search OpenSpace cloud for skills matching query. Returns [] if no API key. */
export async function searchSkillsCloud(query: string, limit = 20): Promise<CloudSkillCandidate[]> {
  if (!OPENSPACE_API_KEY) return [];
  try {
    const url = `${OPENSPACE_API_URL}/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, { headers: cloudHeaders(), signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];
  } catch { return []; }
}

/** Upload a local skill directory to the OpenSpace cloud. */
export async function uploadSkillToCloud(
  skillDir: string,
  skillId: string,
  name: string,
  description: string,
  content: string,
  visibility: "public" | "private" = "public",
  overrides: Partial<UploadMeta> = {},
): Promise<{ url?: string; skill_id?: string }> {
  if (!OPENSPACE_API_KEY) throw new Error("OPENSPACE_API_KEY not configured.");

  // Read sidecar metadata
  let sidecar: Partial<UploadMeta> = {};
  const metaFile = join(skillDir, ".upload_meta.json");
  if (existsSync(metaFile)) {
    try { sidecar = JSON.parse(readFileSync(metaFile, "utf-8")); }
    catch { /* ignore */ }
  }

  const merged: UploadMeta = {
    origin: overrides.origin ?? sidecar.origin ?? "imported",
    parent_skill_ids: overrides.parent_skill_ids ?? sidecar.parent_skill_ids ?? [],
    tags: overrides.tags ?? sidecar.tags ?? [],
    created_by: overrides.created_by ?? sidecar.created_by ?? "engram",
    change_summary: overrides.change_summary ?? sidecar.change_summary ?? "",
  };

  const body = JSON.stringify({ skill_id: skillId, name, description, content, visibility, ...merged });
  const res = await fetch(`${OPENSPACE_API_URL}/skills`, {
    method: "POST",
    headers: cloudHeaders(),
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloud upload failed (${res.status}): ${text}`);
  }
  return await res.json() as any;
}
