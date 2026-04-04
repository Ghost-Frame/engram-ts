// ============================================================================
// ARTIFACTS DOMAIN - Route handlers
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
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
  router.get("/artifact/:id", async (req, params) => {
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

    // Decrypt if needed
    if ((row as any).is_encrypted) {
      const { getMasterKey, decryptArtifact } = await import("./encryption.ts");
      const masterKey = getMasterKey();
      if (!masterKey) {
        return json({ error: "artifact_decryption_failed", detail: "No encryption key configured" }, 500);
      }
      const { auth } = getContext(req);
      try {
        content = decryptArtifact(content, masterKey, auth.user_id);
      } catch {
        return json({ error: "artifact_decryption_failed" }, 500);
      }
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

  // POST /artifacts/migrate-encryption - encrypt existing unencrypted artifacts (admin only)
  router.post("/artifacts/migrate-encryption", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "admin")) return json({ error: "Admin scope required" }, 403);

    const { getMasterKey, encryptArtifact } = await import("./encryption.ts");
    const masterKey = getMasterKey();
    if (!masterKey) return json({ error: "No encryption key configured" }, 400);

    const { db } = await import("../db/connection.ts");
    const { ARTIFACT_DIR } = await import("../config/index.ts");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");

    const BATCH_SIZE = 50;
    const unencrypted = db.prepare(
      `SELECT a.id, a.memory_id, a.data, a.disk_path, a.storage_mode, a.sha256, m.user_id
       FROM artifacts a JOIN memories m ON a.memory_id = m.id
       WHERE a.is_encrypted = 0 LIMIT ?`
    ).all(BATCH_SIZE) as Array<{
      id: number; memory_id: number; data: Buffer | null; disk_path: string | null;
      storage_mode: string; sha256: string; user_id: number;
    }>;

    let migrated = 0;
    let errors = 0;

    for (const art of unencrypted) {
      try {
        let plaintext: Buffer;
        if (art.storage_mode === "inline" && art.data) {
          plaintext = Buffer.from(art.data);
        } else if (art.storage_mode === "disk" && art.disk_path) {
          plaintext = readArtifactFromDisk(art.disk_path);
        } else {
          continue;
        }

        const encrypted = encryptArtifact(plaintext, masterKey, art.user_id);

        if (art.storage_mode === "inline") {
          db.prepare("UPDATE artifacts SET data = ?, is_encrypted = 1 WHERE id = ?").run(encrypted, art.id);
        } else if (art.disk_path) {
          const prefix = art.sha256.slice(0, 2);
          const newDir = resolve(ARTIFACT_DIR, String(art.user_id), prefix);
          const newPath = join(newDir, art.sha256);
          mkdirSync(newDir, { recursive: true });
          writeFileSync(newPath, encrypted);
          db.prepare("UPDATE artifacts SET disk_path = ?, is_encrypted = 1 WHERE id = ?").run(newPath, art.id);
        }

        migrated++;
      } catch {
        errors++;
      }
    }

    const remaining = (db.prepare("SELECT COUNT(*) as c FROM artifacts WHERE is_encrypted = 0").get() as { c: number }).c;
    return json({ migrated, remaining, errors });
  });

} // end registerArtifactRoutes
