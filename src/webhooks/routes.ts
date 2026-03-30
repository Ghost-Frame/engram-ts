// ============================================================================
// WEBHOOKS DOMAIN -- Route handlers
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { validatePublicWebhookUrl } from "../routes/types.ts";
import {
  insertWebhook, listWebhooks, deleteWebhook, getChangesSince, getMemoryBySyncId,
} from "./db.ts";
import { db } from "../db/connection.ts";
import {
  insertMemory, updateMemoryEmbedding, updateMemoryVec,
} from "../db/index.ts";
import {
  embedWithChunking, embeddingToBuffer, embeddingToVectorJSON,
} from "../embeddings/index.ts";
import { autoLink } from "../memory/search.ts";
import { writeVec } from "../routes/types.ts";

export function registerWebhookRoutes(router: Router): void {

  // POST /webhooks -- create webhook
  router.post("/webhooks", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = (rawBody || {}) as any;
      if (!body.url) return errorResponse("url is required");
      const webhookError = validatePublicWebhookUrl(body.url, "Webhook URL");
      if (webhookError) return errorResponse(webhookError, 400);
      const events = body.events || ["*"];
      const secret = body.secret || null;
      const result = insertWebhook.get(body.url, JSON.stringify(events), secret, auth.user_id) as { id: number; created_at: string };
      return json({ created: true, id: result.id, url: body.url, events });
    } catch (e: any) {
      return safeError("create webhook", e);
    }
  });

  // GET /webhooks -- list webhooks
  router.get("/webhooks", async (req) => {
    const { auth } = getContext(req);
    const hooks = listWebhooks.all(auth.user_id) as any[];
    for (const h of hooks) {
      try { h.events = JSON.parse(h.events); } catch {}
    }
    return json({ webhooks: hooks });
  });

  // DELETE /webhooks/:id -- delete webhook
  router.delete("/webhooks/:id", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    deleteWebhook.run(id, auth.user_id);
    return json({ deleted: true, id });
  });

  // GET /sync/changes -- get changes since timestamp
  router.get("/sync/changes", async (req) => {
    const { auth, url } = getContext(req);
    const since = url.searchParams.get("since") || "1970-01-01T00:00:00";
    const limit = Math.min(Number(url.searchParams.get("limit") || 100), 1000);
    const changes = getChangesSince.all(since, auth.user_id, limit) as any[];
    for (const c of changes) {
      try { c.tags = c.tags ? JSON.parse(c.tags) : []; } catch { c.tags = []; }
    }
    return json({
      changes,
      count: changes.length,
      since,
      server_time: new Date().toISOString(),
    });
  });

  // POST /sync/receive -- receive synced changes
  router.post("/sync/receive", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = (rawBody || {}) as any;
      const memories = body.memories;
      if (!Array.isArray(memories)) return errorResponse("memories array required");

      let created = 0, updated = 0, skipped = 0;
      for (const mem of memories) {
        if (!mem.sync_id || !mem.content) { skipped++; continue; }

        const existing = getMemoryBySyncId.get(mem.sync_id, auth.user_id) as any;
        if (existing) {
          // Conflict resolution: last-write-wins
          if (mem.updated_at > existing.updated_at) {
            db.prepare(
              `UPDATE memories SET content = ?, category = ?, importance = ?, tags = ?,
               confidence = ?, is_static = ?, is_forgotten = ?, is_archived = ?,
               model = COALESCE(?, model), updated_at = ? WHERE id = ?`
            ).run(
              mem.content, mem.category || "general", mem.importance || 5,
              mem.tags ? JSON.stringify(mem.tags) : null,
              mem.confidence ?? 1.0, mem.is_static ? 1 : 0,
              mem.is_forgotten ? 1 : 0, mem.is_archived ? 1 : 0,
              mem.model || null, mem.updated_at, existing.id
            );
            // Re-embed on content change
            try {
              const emb = await embedWithChunking(mem.content);
              updateMemoryEmbedding.run(embeddingToBuffer(emb), existing.id);
              try { updateMemoryVec.run(embeddingToVectorJSON(emb), existing.id); } catch {}
            } catch {}
            updated++;
          } else {
            skipped++;
          }
        } else {
          // New memory from remote
          let embBuffer: Buffer | null = null;
          let embArray: Float32Array | null = null;
          try {
            embArray = await embedWithChunking(mem.content);
            embBuffer = embeddingToBuffer(embArray);
          } catch {}
          const result = insertMemory.get(
            mem.content, mem.category || "general", mem.source || "sync", mem.session_id || null,
            mem.importance || 5, embBuffer, mem.version || 1, 1, null, null, 1,
            mem.is_static ? 1 : 0, mem.is_forgotten ? 1 : 0, null, null, 0,
            mem.model || null, auth.user_id, auth.space_id || null
          ) as { id: number; created_at: string };
          db.prepare(
            "UPDATE memories SET sync_id = ?, tags = ?, confidence = ?, is_archived = ?, model = COALESCE(?, model) WHERE id = ?"
          ).run(
            mem.sync_id, mem.tags ? JSON.stringify(mem.tags) : null,
            mem.confidence ?? 1.0, mem.is_archived ? 1 : 0, mem.model || null, result.id
          );
          if (embArray) {
            writeVec(result.id, embArray);
            await autoLink(result.id, embArray, auth.user_id);
          }
          created++;
        }
      }

      return json({ synced: true, created, updated, skipped });
    } catch (e: any) {
      return safeError("Sync receive", e);
    }
  });
}
