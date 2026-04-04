// ============================================================================
// ARTIFACTS DOMAIN - Route handlers
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext } from "../middleware/auth.ts";
import { json } from "../helpers/index.ts";
import { getArtifactsByMemory, getArtifactById, getArtifactStats } from "../db/index.ts";
import { readArtifactFromDisk } from "./storage.ts";

export function enrichWithArtifacts<T extends { id: number }>(results: T[]): (T & { artifacts: Array<{ id: number; filename: string; mime_type: string; size_bytes: number }> })[] {
  return results.map(r => {
    if (r.id <= 0) return { ...r, artifacts: [] };
    const arts = getArtifactsByMemory.all(r.id) as Array<{ id: number; filename: string; mime_type: string; size_bytes: number }>;
    return {
      ...r,
      artifacts: arts.map(({ id, filename, mime_type, size_bytes }) => ({ id, filename, mime_type, size_bytes })),
    };
  });
}

export function registerArtifactRoutes(router: Router): void {

  // GET /artifacts/stats - storage usage stats
  router.get("/artifacts/stats", async (_req) => {
    const stats = getArtifactStats.get() as {
      total_count: number; total_bytes: number;
      inline_bytes: number; disk_bytes: number;
      inline_count: number; disk_count: number;
    };
    return json({
      total_count: stats.total_count || 0,
      total_bytes: stats.total_bytes || 0,
      inline: { count: stats.inline_count || 0, bytes: stats.inline_bytes || 0 },
      disk: { count: stats.disk_count || 0, bytes: stats.disk_bytes || 0 },
    });
  });

  // GET /artifacts/:memoryId - list artifacts for a memory
  router.get("/artifacts/:memoryId", async (_req, params) => {
    const memoryId = Number(params.memoryId);
    if (isNaN(memoryId)) return json({ error: "Invalid memory ID" }, 400);
    const rows = getArtifactsByMemory.all(memoryId) as Array<{
      id: number; filename: string; mime_type: string; size_bytes: number;
      sha256: string; storage_mode: string; created_at: string;
    }>;
    return json({ artifacts: rows, memory_id: memoryId });
  });

  // GET /artifact/:id - download a single artifact
  router.get("/artifact/:id", async (_req, params) => {
    const artifactId = Number(params.id);
    if (isNaN(artifactId)) return json({ error: "Invalid artifact ID" }, 400);
    const row = getArtifactById.get(artifactId) as {
      id: number; memory_id: number; filename: string; mime_type: string;
      size_bytes: number; sha256: string; storage_mode: string;
      data: Buffer | null; disk_path: string | null; created_at: string;
    } | undefined;

    if (!row) return json({ error: "Artifact not found" }, 404);

    let content: Buffer;
    if (row.storage_mode === "inline" && row.data) {
      content = Buffer.from(row.data);
    } else if (row.storage_mode === "disk" && row.disk_path) {
      try {
        content = readArtifactFromDisk(row.disk_path);
      } catch {
        return json({ error: "Artifact file missing from disk", artifact_id: row.id }, 404);
      }
    } else {
      return json({ error: "Artifact has no data" }, 500);
    }

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": row.mime_type,
        "Content-Length": String(content.length),
        "Content-Disposition": `attachment; filename="${row.filename}"`,
      },
    });
  });

} // end registerArtifactRoutes
