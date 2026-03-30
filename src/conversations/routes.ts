// ============================================================================
// CONVERSATIONS DOMAIN -- Route handlers (thin wrappers)
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError, sanitizeFTS } from "../helpers/index.ts";
import {
  insertConversation,
  updateConversation,
  getConversationForUser,
  getConversationBySession,
  listConversations,
  listConversationsByAgent,
  deleteConversation,
  touchConversation,
  insertMessage,
  getMessages,
  searchMessages,
  bulkInsertConvo,
} from "./db.ts";
import { recordUsage } from "../db/index.ts";
import type {
  CreateConversationBody,
  UpdateConversationBody,
  BulkInsertBody,
  UpsertConversationBody,
  SearchMessagesBody,
} from "./types.ts";

export function registerConversationRoutes(router: Router): void {

  // POST /conversations -- create a new conversation
  router.post("/conversations", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = getContext(req).body as CreateConversationBody;
      const { agent, session_id, title, metadata } = body;
      if (!agent || typeof agent !== "string") return errorResponse("agent is required");
      const result = insertConversation.get(
        agent.trim(), session_id || null, title || null,
        metadata ? JSON.stringify(metadata) : null,
        auth.user_id,
      ) as { id: number; started_at: string };
      try { recordUsage.run(auth.user_id, "conversation.create", 1, null); } catch {}
      return json({ id: result.id, started_at: result.started_at }, 201);
    } catch (e: any) {
      return safeError("create conversation", e);
    }
  });

  // GET /conversations -- list conversations (optionally filtered by agent)
  router.get("/conversations", async (req) => {
    const { auth, url } = getContext(req);
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
    const agent = url.searchParams.get("agent");
    const results = agent
      ? listConversationsByAgent.all(auth.user_id, agent, limit)
      : listConversations.all(auth.user_id, limit);
    return json({ results });
  });

  // GET /conversations/:id -- get conversation with messages
  router.get("/conversations/:id", async (req, params) => {
    const { auth, url } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const conv = getConversationForUser.get(id, auth.user_id) as any;
    if (!conv) return errorResponse("Not found", 404);
    const limit = Math.min(Number(url.searchParams.get("limit") || 10000), 100000);
    const offset = Number(url.searchParams.get("offset") || 0);
    const msgs = getMessages.all(id, limit, offset);
    return json({ conversation: conv, messages: msgs });
  });

  // PATCH /conversations/:id -- update title/metadata
  router.patch("/conversations/:id", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const id = Number(params.id);
      if (isNaN(id)) return errorResponse("Invalid id");
      const conv = getConversationForUser.get(id, auth.user_id) as any;
      if (!conv) return errorResponse("Not found", 404);
      const body = getContext(req).body as UpdateConversationBody;
      updateConversation.run(
        body.title || null,
        body.metadata ? JSON.stringify(body.metadata) : null,
        id,
        auth.user_id,
      );
      return json({ updated: true, id });
    } catch (e: any) {
      return safeError("update", e);
    }
  });

  // DELETE /conversations/:id -- delete a conversation
  router.delete("/conversations/:id", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    deleteConversation.run(id, auth.user_id);
    return json({ deleted: true, id });
  });

  // POST /conversations/:id/messages -- add one or more messages
  router.post("/conversations/:id/messages", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const convId = Number(params.id);
      if (isNaN(convId)) return errorResponse("Invalid id");
      const conv = getConversationForUser.get(convId, auth.user_id);
      if (!conv) return errorResponse("Conversation not found", 404);
      const body = getContext(req).body as any;
      const msgs = Array.isArray(body) ? body : [body];
      const results: Array<{ id: number; created_at: string }> = [];
      for (const msg of msgs) {
        if (!msg.role || !msg.content) continue;
        const result = insertMessage.get(
          convId, msg.role, msg.content, msg.metadata ? JSON.stringify(msg.metadata) : null,
        ) as { id: number; created_at: string };
        results.push(result);
      }
      touchConversation.run(convId);
      return json({ added: results.length, messages: results });
    } catch (e: any) {
      return safeError("add messages", e);
    }
  });

  // POST /conversations/bulk -- create conversation with messages in one transaction
  router.post("/conversations/bulk", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = getContext(req).body as BulkInsertBody;
      const { agent, session_id, title, metadata, messages: msgs } = body;
      if (!agent) return errorResponse("agent is required");
      if (!msgs || !Array.isArray(msgs) || msgs.length === 0) {
        return errorResponse("messages array is required and must not be empty");
      }
      const conv = bulkInsertConvo(
        agent.trim(), session_id || null, title || null,
        metadata ? JSON.stringify(metadata) : null,
        auth.user_id,
        msgs.map((m: any) => ({
          role: m.role || "user",
          content: m.content || "",
          metadata: m.metadata ? JSON.stringify(m.metadata) : null,
        })),
      );
      return json({ id: conv.id, started_at: conv.started_at, messages: msgs.length });
    } catch (e: any) {
      return safeError("Bulk store", e);
    }
  });

  // POST /conversations/upsert -- find-or-create by agent+session_id, append messages
  router.post("/conversations/upsert", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = getContext(req).body as UpsertConversationBody;
      const { agent, session_id, title, metadata, messages: msgs } = body;
      if (!agent) return errorResponse("agent is required");
      if (!session_id) return errorResponse("session_id is required for upsert");

      let conv = getConversationBySession.get(agent, session_id, auth.user_id) as any;
      let created = false;
      if (!conv) {
        const result = insertConversation.get(
          agent, session_id, title || null,
          metadata ? JSON.stringify(metadata) : null,
          auth.user_id,
        ) as { id: number; started_at: string };
        conv = { id: result.id };
        created = true;
      } else if (title || metadata) {
        updateConversation.run(
          title || null,
          metadata ? JSON.stringify(metadata) : null,
          conv.id,
          auth.user_id,
        );
      }

      let added = 0;
      if (msgs && Array.isArray(msgs)) {
        for (const msg of msgs) {
          if (!msg.role || !msg.content) continue;
          insertMessage.run(
            conv.id, msg.role, msg.content,
            msg.metadata ? JSON.stringify(msg.metadata) : null,
          );
          added++;
        }
        if (added > 0) touchConversation.run(conv.id);
      }
      return json({ id: conv.id, created, added });
    } catch (e: any) {
      return safeError("Upsert", e);
    }
  });

  // POST /messages/search -- full-text search across messages
  router.post("/messages/search", async (req) => {
    const { auth } = getContext(req);
    try {
      const body = getContext(req).body as SearchMessagesBody;
      const { query, limit } = body;
      if (!query || typeof query !== "string") return errorResponse("query is required");
      const sanitized = sanitizeFTS(query);
      if (!sanitized) return json({ results: [] });
      const results = searchMessages.all(sanitized, auth.user_id, Math.min(limit || 30, 200));
      return json({ results });
    } catch (e: any) {
      return safeError("Search", e);
    }
  });

} // end registerConversationRoutes
