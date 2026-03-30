// ============================================================================
// INBOX DOMAIN -- Route handlers
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope, canAccessOwnedRow } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { auditLog } from "../middleware/audit.ts";
import {
  listPending, countPending, approveMemory, rejectMemory, getMemoryWithoutEmbedding,
} from "./db.ts";
import { db } from "../db/connection.ts";
import { embedWithChunking, embeddingToBuffer, embeddingToVectorJSON } from "../embeddings/index.ts";
import { emitWebhookEvent } from "../platform/webhooks.ts";
import { log } from "../config/logger.ts";

export function registerInboxRoutes(router: Router): void {

  // GET /inbox -- list inbox (pending) items
  router.get("/inbox", (req) => {
    const { auth, url } = getContext(req);
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    const offset = Number(url.searchParams.get("offset") || 0);
    const pending = listPending.all(auth.user_id, limit, offset) as any[];
    const total = (countPending.get(auth.user_id) as { count: number }).count;
    for (const p of pending) {
      try { if (p.tags) p.tags = JSON.parse(p.tags); } catch { p.tags = []; }
    }
    return json({ pending, count: pending.length, total, offset, limit });
  });

  // POST /inbox/:id/approve -- approve a pending memory
  router.post("/inbox/:id/approve", async (req, params) => {
    const { auth, clientIp } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const id = Number(params.id);
    const mem = getMemoryWithoutEmbedding.get(id) as any;
    if (!mem) return errorResponse("Not found", 404);
    if (!canAccessOwnedRow(mem, auth)) return errorResponse("Forbidden", 403);
    if (mem.status !== "pending") return errorResponse(`Memory is already ${mem.status}`, 400);
    approveMemory.run(id, auth.user_id);
    auditLog(auth.user_id, "inbox.approve", "memory", id, null, clientIp);
    emitWebhookEvent("memory.approved", { id }, auth.user_id);
    return json({ approved: true, id });
  });

  // POST /inbox/:id/reject -- reject a pending memory
  router.post("/inbox/:id/reject", async (req, params) => {
    const { auth, clientIp } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const id = Number(params.id);
    const mem = getMemoryWithoutEmbedding.get(id) as any;
    if (!mem) return errorResponse("Not found", 404);
    if (!canAccessOwnedRow(mem, auth)) return errorResponse("Forbidden", 403);
    if (mem.status !== "pending") return errorResponse(`Memory is already ${mem.status}`, 400);
    const body = await req.json().catch(() => ({})) as any;
    rejectMemory.run(id, auth.user_id);
    auditLog(auth.user_id, "inbox.reject", "memory", id, body.reason || null, clientIp);
    if (body.reason) {
      db.prepare("UPDATE memories SET forget_reason = ? WHERE id = ?").run(body.reason, id);
    }
    emitWebhookEvent("memory.rejected", { id, reason: body.reason || null }, auth.user_id);
    return json({ rejected: true, id });
  });

  // POST /inbox/:id/edit -- edit + approve in one shot
  router.post("/inbox/:id/edit", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const id = Number(params.id);
      const mem = getMemoryWithoutEmbedding.get(id) as any;
      if (!mem) return errorResponse("Not found", 404);
      if (!canAccessOwnedRow(mem, auth)) return errorResponse("Forbidden", 403);
      const body = await req.json() as any;

      const sets: string[] = ["status = 'approved'", "updated_at = datetime('now')"];
      const vals: any[] = [];
      if (body.content?.trim()) { sets.push("content = ?"); vals.push(body.content.trim()); }
      if (body.category) { sets.push("category = ?"); vals.push(body.category); }
      if (body.importance) { sets.push("importance = ?"); vals.push(Math.max(1, Math.min(10, Number(body.importance)))); }
      if (body.tags) {
        const tags = Array.isArray(body.tags) ? body.tags : body.tags.split(",");
        sets.push("tags = ?");
        vals.push(JSON.stringify(tags.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean)));
      }
      vals.push(id);
      db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

      // Re-embed if content changed
      if (body.content?.trim()) {
        try {
          const emb = await embedWithChunking(body.content.trim());
          const { updateMemoryEmbedding, updateMemoryVec } = await import("../db/index.ts");
          updateMemoryEmbedding.run(embeddingToBuffer(emb), id);
          try { updateMemoryVec.run(embeddingToVectorJSON(emb), id); } catch {}
        } catch {}
      }

      emitWebhookEvent("memory.approved", { id, edited: true }, auth.user_id);
      return json({ approved: true, edited: true, id });
    } catch (e: any) {
      return safeError("Edit", e);
    }
  });

  // POST /inbox/bulk -- bulk approve/reject
  router.post("/inbox/bulk", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = await req.json() as any;
      const ids = body.ids;
      const action = body.action; // "approve" or "reject"
      if (!Array.isArray(ids) || !ids.length) return errorResponse("ids array required");
      if (action !== "approve" && action !== "reject") return errorResponse("action must be 'approve' or 'reject'");

      let count = 0;
      const stmt = action === "approve" ? approveMemory : rejectMemory;
      for (const id of ids) {
        stmt.run(id, auth.user_id);
        count++;
      }
      emitWebhookEvent(`memory.bulk_${action}`, { ids, count }, auth.user_id);
      return json({ action, count, ids });
    } catch (e: any) {
      return safeError("Bulk action", e);
    }
  });

  // GET /pending -- legacy alias for GET /inbox
  router.get("/pending", (req) => {
    const { auth, url } = getContext(req);
    log.warn({ msg: "deprecated_route", path: "/pending", use: "GET /inbox", user: auth.user_id });
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    const offset = Number(url.searchParams.get("offset") || 0);
    const pending = listPending.all(auth.user_id, limit, offset) as any[];
    const total = (countPending.get(auth.user_id) as { count: number }).count;
    for (const p of pending) {
      try { if (p.tags) p.tags = JSON.parse(p.tags); } catch { p.tags = []; }
    }
    return json({ pending, count: pending.length, total, offset, limit });
  });

  // POST /approve -- legacy alias for POST /inbox/:id/approve
  router.post("/approve", async (req) => {
    const { auth, clientIp } = getContext(req);
    log.warn({ msg: "deprecated_route", path: "/approve", use: "POST /inbox/{id}/approve", user: auth.user_id });
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const body = await req.json().catch(() => ({})) as any;
    const id = Number(body?.id);
    if (!id) return errorResponse("Missing 'id' in request body", 400);
    const mem = getMemoryWithoutEmbedding.get(id) as any;
    if (!mem) return errorResponse("Not found", 404);
    if (!canAccessOwnedRow(mem, auth)) return errorResponse("Forbidden", 403);
    if (mem.status !== "pending") return errorResponse(`Memory is already ${mem.status}`, 400);
    approveMemory.run(id, auth.user_id);
    auditLog(auth.user_id, "inbox.approve", "memory", id, null, clientIp);
    emitWebhookEvent("memory.approved", { id }, auth.user_id);
    return json({ approved: true, id });
  });
}
