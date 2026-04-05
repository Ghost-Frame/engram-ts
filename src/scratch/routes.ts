// ============================================================================
// SCRATCH PAD DOMAIN - Route handlers
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { auditLog } from "../middleware/audit.ts";
import {
  upsertScratchEntryWithTTL,
  getScratchSessionAll,
  listScratchEntries,
  deleteScratchSession,
  deleteScratchSessionKey,
  db,
} from "./db.ts";
import { insertMemory, updateMemoryEmbedding, updateMemoryVec } from "../db/index.ts";
import {
  embedWithChunking,
  addToEmbeddingCache,
  embeddingToBuffer,
  embeddingToVectorJSON,
} from "../embeddings/index.ts";
import { autoLink } from "../memory/search.ts";
import { callLocalModel, isLocalModelAvailable } from "../llm/local.ts";
import type { ScratchEntryRow } from "./types.ts";

export function registerScratchRoutes(router: Router): void {

  // GET /scratch - list scratch entries
  router.get("/scratch", async (req) => {
    const { auth, url } = getContext(req);
    if (!hasScope(auth, "read")) return errorResponse("Read scope required", 403);
    try {
      const agentFilter = url.searchParams.get("agent");
      const modelFilter = url.searchParams.get("model");
      const sessionFilter = url.searchParams.get("session");
      const rows = listScratchEntries.all(
        auth.user_id,
        agentFilter, agentFilter,
        modelFilter, modelFilter,
        sessionFilter, sessionFilter,
      ) as ScratchEntryRow[];
      return json({
        entries: rows.map((row) => ({
          session: row.session,
          agent: row.agent,
          model: row.model,
          key: row.entry_key,
          value: row.value,
          created_at: row.created_at,
          updated_at: row.updated_at,
          expires_at: row.expires_at,
        })),
        count: rows.length,
      });
    } catch (e: any) {
      return safeError("Scratch list", e);
    }
  });

  // PUT /scratch - upsert scratch entries
  router.put("/scratch", async (req) => {
    const { auth, body, clientIp, requestId } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const b = body as any;
      const session = String(b.session || "").trim();
      const agent = String(b.agent || "").trim();
      const model = String(b.model || "").trim();
      const entries = Array.isArray(b.entries) ? b.entries : [];
      // TTL in minutes: default 30, max 1440 (24h)
      const ttl = Math.max(1, Math.min(1440, Number(b.ttl) || 30));
      if (!session) return errorResponse("session is required");
      if (!agent) return errorResponse("agent is required");
      if (!model) return errorResponse("model is required");
      if (entries.length === 0) return errorResponse("entries array is required");
      if (entries.length > 50) return errorResponse("too many scratch entries (max 50)");

      const cleaned = entries.map((entry: any) => ({
        key: String(entry?.key || "").trim(),
        value: entry?.value == null ? "" : String(entry.value),
      }));
      if (cleaned.some((entry: any) => !entry.key)) return errorResponse("each scratch entry needs a key");

      const ttlStr = String(ttl);
      const tx = db.transaction(() => {
        for (const entry of cleaned) {
          upsertScratchEntryWithTTL.run(auth.user_id, session, agent, model, entry.key, entry.value, ttlStr, ttlStr);
        }
      });
      tx();

      auditLog(auth.user_id, "scratch_put", "scratchpad", null, JSON.stringify({ session, entries: cleaned.length }), clientIp);
      const rows = listScratchEntries.all(
        auth.user_id,
        null, null,
        null, null,
        session, session,
      ) as ScratchEntryRow[];
      return json({
        stored: true,
        session,
        count: rows.length,
        entries: rows.map((row) => ({
          session: row.session,
          agent: row.agent,
          model: row.model,
          key: row.entry_key,
          value: row.value,
          updated_at: row.updated_at,
          expires_at: row.expires_at,
        })),
      });
    } catch (e: any) {
      return safeError("Scratch put", e);
    }
  });

  // DELETE /scratch/:session/:key - delete specific key
  router.delete("/scratch/:session/:key", async (req, params) => {
    const { auth, clientIp } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const session = params.session?.trim() || "";
      const key = params.key?.trim() || "";
      if (!session || !key) return errorResponse("session and key are required");
      deleteScratchSessionKey.run(auth.user_id, session, key);
      auditLog(auth.user_id, "scratch_delete_key", "scratchpad", null, JSON.stringify({ session, key }), clientIp);
      return json({ deleted: true, session, key });
    } catch (e: any) {
      return safeError("Scratch delete key", e);
    }
  });

  // DELETE /scratch/:session - delete session (auto-summarize if LLM available)
  router.delete("/scratch/:session", async (req, params) => {
    const { auth, clientIp } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const session = params.session?.trim() || "";
      if (!session) return errorResponse("session is required");

      // Auto-summarize on session end if LLM is available and entries exist
      let summarized = false;
      let summaryId: number | null = null;
      if (isLocalModelAvailable()) {
        const rows = getScratchSessionAll.all(auth.user_id, session) as ScratchEntryRow[];
        if (rows.length >= 2) { // only summarize if there's meaningful content
          try {
            const agent = rows[0].agent;
            const model = rows[0].model;
            const entriesText = rows.map(r =>
              `[${r.entry_key}] ${r.value || "(empty)"}`
            ).join("\n");

            const summary = await callLocalModel(
              `You extract lasting knowledge from agent work sessions. Given an agent's scratchpad entries, identify facts worth remembering long-term (infrastructure details, endpoints, architectural decisions, bugs found, solutions). Ignore transient state. If nothing is worth keeping, say "nothing". Be concise.`,
              `Agent: ${agent}\nModel: ${model}\n\nEntries:\n${entriesText}`,
              { priority: "background" },
            );

            if (summary && summary.toLowerCase().trim() !== "nothing") {
              const content = `[Session summary: ${agent}/${model} #${session.slice(0, 8)}] ${summary.trim()}`;
              const result = insertMemory.get(content, "discovery", agent, null, 5, null, 1, 1, null, null, 1, 0, 0, null, null, 0, model, auth.user_id, auth.space_id || null) as { id: number; created_at: string };
              summaryId = result.id;
              try {
                const emb = await embedWithChunking(content);
                updateMemoryEmbedding.run(embeddingToBuffer(emb), summaryId);
                try { updateMemoryVec.run(embeddingToVectorJSON(emb), summaryId); } catch {}
                addToEmbeddingCache({ id: summaryId, embedding: emb, content, category: "discovery", importance: 5, is_static: 0, source_count: 1, user_id: auth.user_id, is_latest: 1, is_forgotten: 0 } as any);
                await autoLink(summaryId, emb, auth.user_id);
              } catch {}
              summarized = true;
            }
          } catch {}
        }
      }

      deleteScratchSession.run(auth.user_id, session);
      auditLog(auth.user_id, "scratch_delete_session", "scratchpad", summaryId,
        JSON.stringify({ session, auto_summarized: summarized }),
        clientIp);
      const result: Record<string, any> = { deleted: true, session };
      if (summarized) { result.summarized = true; result.memory_id = summaryId; }
      else if (!isLocalModelAvailable()) { result.summarized = false; result.reason = "llm_not_available"; }
      return json(result);
    } catch (e: any) {
      return safeError("Scratch delete", e);
    }
  });

  // POST /scratch/:session/promote - promote session entries to permanent memories
  router.post("/scratch/:session/promote", async (req, params) => {
    const { auth, body, clientIp } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const session = params.session?.trim() || "";
      if (!session) return errorResponse("session is required");

      const b = body as any;
      const filterKeys: string[] | null = Array.isArray(b.keys) ? b.keys : null;
      const combine = b.combine === true;
      const category = b.category || "discovery";

      const rows = getScratchSessionAll.all(auth.user_id, session) as ScratchEntryRow[];
      if (rows.length === 0) return errorResponse("No entries found for session", 404);

      const filtered = filterKeys
        ? rows.filter(r => filterKeys.includes(r.entry_key))
        : rows;
      if (filtered.length === 0) return errorResponse("No matching entries for specified keys", 404);

      const promoted: number[] = [];

      if (combine) {
        const lines = filtered.map(r => `[${r.agent}] ${r.entry_key}: ${r.value || ""}`);
        const content = `Session ${session.slice(0, 8)} (${filtered[0].agent}): ${lines.join("; ")}`;
        const result = insertMemory.get(
          content, category, filtered[0].agent, null, 5,
          null, 1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
        ) as { id: number; created_at: string };
        const newId = result.id;
        promoted.push(newId);
        try {
          const emb = await embedWithChunking(content);
          updateMemoryEmbedding.run(embeddingToBuffer(emb), newId);
          try { updateMemoryVec.run(embeddingToVectorJSON(emb), newId); } catch {}
          addToEmbeddingCache({ id: newId, embedding: emb, content, category, importance: 5, is_static: 0, source_count: 1, user_id: auth.user_id, is_latest: 1, is_forgotten: 0 } as any);
          await autoLink(newId, emb, auth.user_id);
        } catch {}
      } else {
        for (const r of filtered) {
          const content = `${r.entry_key}: ${r.value || ""}`;
          const result = insertMemory.get(
            content, category, r.agent, null, 5,
            null, 1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
          ) as { id: number; created_at: string };
          const newId = result.id;
          promoted.push(newId);
          try {
            const emb = await embedWithChunking(content);
            updateMemoryEmbedding.run(embeddingToBuffer(emb), newId);
            try { updateMemoryVec.run(embeddingToVectorJSON(emb), newId); } catch {}
            addToEmbeddingCache({ id: newId, embedding: emb, content, category, importance: 5, is_static: 0, source_count: 1, user_id: auth.user_id, is_latest: 1, is_forgotten: 0 } as any);
            await autoLink(newId, emb, auth.user_id);
          } catch {}
        }
      }

      auditLog(auth.user_id, "scratch_promote", "scratchpad", null,
        JSON.stringify({ session, promoted: promoted.length, combine }),
        clientIp);

      return json({ promoted: true, session, memory_ids: promoted, count: promoted.length });
    } catch (e: any) {
      return safeError("Scratch promote", e);
    }
  });

  // POST /scratch/:session/summarize - LLM-summarize session and store as memory
  router.post("/scratch/:session/summarize", async (req, params) => {
    const { auth, body, clientIp } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const session = params.session?.trim() || "";
      if (!session) return errorResponse("session is required");

      const b = body as any;
      const deleteAfter = b.delete !== false; // default: clean up after summarizing

      const rows = getScratchSessionAll.all(auth.user_id, session) as ScratchEntryRow[];
      if (rows.length === 0) return errorResponse("No entries found for session", 404);

      const agent = rows[0].agent;
      const model = rows[0].model;
      const entriesText = rows.map(r =>
        `[${r.entry_key}] ${r.value || "(empty)"} (set ${r.created_at}, updated ${r.updated_at})`
      ).join("\n");

      let summary: string;

      if (isLocalModelAvailable()) {
        summary = await callLocalModel(
          `You extract lasting knowledge from agent work sessions. Given an agent's scratchpad entries from a session, identify facts, decisions, or discoveries worth remembering long-term. Ignore transient state (files being edited, tasks in progress). Focus on: infrastructure details, credentials/endpoints, architectural decisions, bugs found, solutions applied. If nothing is worth keeping, say "nothing". Be concise - one line per fact.`,
          `Agent: ${agent}\nModel: ${model}\nSession: ${session}\n\nEntries:\n${entriesText}`,
          { priority: "background" },
        );
      } else {
        // No LLM: just combine entries as-is
        summary = rows.map(r => `${r.entry_key}: ${r.value || ""}`).join("\n");
      }

      if (!summary || summary.toLowerCase().trim() === "nothing") {
        if (deleteAfter) deleteScratchSession.run(auth.user_id, session);
        return json({ summarized: true, session, stored: false, reason: "nothing worth keeping" });
      }

      const content = `[Session summary: ${agent}/${model} #${session.slice(0, 8)}] ${summary.trim()}`;
      const result = insertMemory.get(
        content, "discovery", agent, null, 5,
        null, 1, 1, null, null, 1, 0, 0, null, null, 0, model, auth.user_id, auth.space_id || null
      ) as { id: number; created_at: string };
      const newId = result.id;

      try {
        const emb = await embedWithChunking(content);
        updateMemoryEmbedding.run(embeddingToBuffer(emb), newId);
        try { updateMemoryVec.run(embeddingToVectorJSON(emb), newId); } catch {}
        addToEmbeddingCache({ id: newId, embedding: emb, content, category: "discovery", importance: 5, is_static: 0, source_count: 1, user_id: auth.user_id, is_latest: 1, is_forgotten: 0 } as any);
        await autoLink(newId, emb, auth.user_id);
      } catch {}

      if (deleteAfter) deleteScratchSession.run(auth.user_id, session);

      auditLog(auth.user_id, "scratch_summarize", "scratchpad", newId,
        JSON.stringify({ session, entries: rows.length, delete_after: deleteAfter }),
        clientIp);

      return json({ summarized: true, session, stored: true, memory_id: newId, content });
    } catch (e: any) {
      return safeError("Scratch summarize", e);
    }
  });

}
