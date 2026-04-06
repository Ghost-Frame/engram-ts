// ============================================================================
// Broca routes - action logging, narration, feed, NL query
// Prefix: /broca/*
// ============================================================================

import { db } from "../../db/index.ts";
import { log } from "../../config/logger.ts";
import { json, errorResponse } from "../../helpers/index.ts";
import { getContext } from "../../middleware/auth.ts";
import { bounded } from "../types.ts";
import { parseJsonFields, parseJsonFieldsAll } from "../helpers.ts";
import { publish } from "../axon/bus.ts";
import { insertAction, getActionById, actionCount, narratedCount } from "./db.ts";
import { narrate, narrateFromTemplate } from "./narrator.ts";
import { ask } from "./ask.ts";

export async function handleBrocaRoutes(
  method: string,
  url: URL,
  req: Request,
  requestId: string,
): Promise<Response | null> {
  const path = url.pathname;

  if (!path.startsWith("/broca/") && path !== "/broca") return null;

  const sub = path.slice("/broca".length); // e.g. "/actions" or "/actions/5"

  // - POST /broca/actions - Log an action --

  if (sub === "/actions" && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    const { agent, service, action, payload } = body;
    if (!agent || typeof agent !== "string") return errorResponse("agent required", 400, requestId);
    if (!service || typeof service !== "string") return errorResponse("service required", 400, requestId);
    if (!action || typeof action !== "string") return errorResponse("action required", 400, requestId);

    const payloadObj = payload && typeof payload === "object" ? payload : {};
    const payloadStr = JSON.stringify(payloadObj);

    // Auto-narrate via template (sync, O(1))
    const narrative = narrateFromTemplate(action, payloadObj);

    // Publish to Axon
    let axonEventId: number | null = null;
    try {
      const eventInfo = db.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'axon_events'"
      ).get() as { seq: number } | undefined;
      const beforeSeq = eventInfo?.seq ?? 0;
      publish(1, "system", "broca", `broca.${action}`, { agent, service, ...payloadObj });
      const afterInfo = db.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'axon_events'"
      ).get() as { seq: number } | undefined;
      if (afterInfo && afterInfo.seq > beforeSeq) {
        axonEventId = afterInfo.seq;
      }
    } catch (e: any) {
      log.warn({ msg: "broca_axon_publish_failed", action, error: e.message });
    }

    const info = insertAction.run(agent, service, action, payloadStr, narrative, axonEventId);
    const id = Number(info.lastInsertRowid);
    const row = getActionById.get(id) as Record<string, unknown> | undefined;
    const result = parseJsonFields(row, "payload");

    return json(result, 201);
  }

  // - GET /broca/actions - List actions --

  if (sub === "/actions" && method === "GET") {
    const clauses: string[] = [];
    const params: unknown[] = [];

    const agent = url.searchParams.get("agent");
    const service = url.searchParams.get("service");
    const action = url.searchParams.get("action");
    const since = url.searchParams.get("since");

    if (agent) { clauses.push("agent = ?"); params.push(agent); }
    if (service) { clauses.push("service = ?"); params.push(service); }
    if (action) { clauses.push("action = ?"); params.push(action); }
    if (since) { clauses.push("created_at >= ?"); params.push(since); }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = bounded(url.searchParams.get("limit"), 1, 1000, 100);
    const offset = bounded(url.searchParams.get("offset"), 0, 100000, 0);

    const rows = db.prepare(
      `SELECT * FROM broca_actions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Record<string, unknown>[];

    return json(parseJsonFieldsAll(rows, "payload"));
  }

  // - GET /broca/actions/:id - Single action --

  const actionIdMatch = sub.match(/^\/actions\/(\d+)$/);
  if (actionIdMatch && method === "GET") {
    const row = getActionById.get(parseInt(actionIdMatch[1], 10)) as Record<string, unknown> | undefined;
    if (!row) return errorResponse("Action not found", 404, requestId);
    return json(parseJsonFields(row, "payload"));
  }

  // - GET /broca/actions/:id/narrate - Generate/return narrative --

  const narrateMatch = sub.match(/^\/actions\/(\d+)\/narrate$/);
  if (narrateMatch && method === "GET") {
    const row = getActionById.get(parseInt(narrateMatch[1], 10)) as Record<string, unknown> | undefined;
    if (!row) return errorResponse("Action not found", 404, requestId);

    if (row.narrative) {
      return json({ id: row.id, narrative: row.narrative, cached: true });
    }

    const payload = typeof row.payload === "string" ? JSON.parse(row.payload as string) : (row.payload ?? {});
    const narrative = await narrate(
      row.agent as string,
      row.service as string,
      row.action as string,
      payload as Record<string, unknown>,
    );

    // Persist the narrative
    db.prepare("UPDATE broca_actions SET narrative = ? WHERE id = ?").run(narrative, row.id);

    return json({ id: row.id, narrative, cached: false });
  }

  // - GET /broca/feed - Recent actions with narratives --

  if (sub === "/feed" && method === "GET") {
    const clauses: string[] = [];
    const params: unknown[] = [];

    const agent = url.searchParams.get("agent");
    const since = url.searchParams.get("since");

    if (agent) { clauses.push("agent = ?"); params.push(agent); }
    if (since) { clauses.push("created_at >= ?"); params.push(since); }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = bounded(url.searchParams.get("limit"), 1, 200, 50);
    const offset = bounded(url.searchParams.get("offset"), 0, 100000, 0);

    const rows = db.prepare(
      `SELECT * FROM broca_actions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Record<string, unknown>[];

    return json(parseJsonFieldsAll(rows, "payload"));
  }

  // - POST /broca/narrate - Bulk narrate --

  if (sub === "/narrate" && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0) return errorResponse("ids array required", 400, requestId);
    if (ids.length > 50) return errorResponse("Maximum 50 IDs per request", 400, requestId);

    const results: Array<{ id: number; narrative: string }> = [];

    for (const id of ids) {
      const numId = Number(id);
      if (!Number.isFinite(numId)) continue;

      const row = getActionById.get(numId) as Record<string, unknown> | undefined;
      if (!row) continue;

      if (row.narrative) {
        results.push({ id: numId, narrative: row.narrative as string });
        continue;
      }

      const payload = typeof row.payload === "string" ? JSON.parse(row.payload as string) : (row.payload ?? {});
      const narrative = await narrate(
        row.agent as string,
        row.service as string,
        row.action as string,
        payload as Record<string, unknown>,
      );

      db.prepare("UPDATE broca_actions SET narrative = ? WHERE id = ?").run(narrative, numId);
      results.push({ id: numId, narrative });
    }

    return json({ narrated: results.length, results });
  }

  // - POST /broca/ask - NL query --

  if (sub === "/ask" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const question = body.question;
    if (!question || typeof question !== "string") return errorResponse("question required", 400, requestId);
    if (question.length > 2000) return errorResponse("question too long (max 2000 chars)", 400, requestId);

    try {
      const result = await ask(auth.user_id, question);
      return json(result);
    } catch (e: any) {
      log.error({ msg: "broca_ask_failed", error: e.message });
      return errorResponse("Ask query failed", 500, requestId);
    }
  }

  // - GET /broca/stats - Action counts --

  if (sub === "/stats" && method === "GET") {
    const { auth } = getContext(req);
    const userId = auth.is_admin ? undefined : auth.user_id;

    const total = userId !== undefined
      ? (db.prepare("SELECT COUNT(*) as count FROM broca_actions WHERE user_id = ?").get(userId) as any).count
      : (actionCount.get() as any).count;

    const narrated = userId !== undefined
      ? (db.prepare("SELECT COUNT(*) as count FROM broca_actions WHERE narrative IS NOT NULL AND user_id = ?").get(userId) as any).count
      : (narratedCount.get() as any).count;

    const by_service = userId !== undefined
      ? db.prepare("SELECT service, COUNT(*) as count FROM broca_actions WHERE user_id = ? GROUP BY service ORDER BY count DESC").all(userId)
      : db.prepare("SELECT service, COUNT(*) as count FROM broca_actions GROUP BY service ORDER BY count DESC").all();

    const by_agent = userId !== undefined
      ? db.prepare("SELECT agent, COUNT(*) as count FROM broca_actions WHERE user_id = ? GROUP BY agent ORDER BY count DESC").all(userId)
      : db.prepare("SELECT agent, COUNT(*) as count FROM broca_actions GROUP BY agent ORDER BY count DESC").all();

    const by_action = userId !== undefined
      ? db.prepare("SELECT action, COUNT(*) as count FROM broca_actions WHERE user_id = ? GROUP BY action ORDER BY count DESC LIMIT 20").all(userId)
      : db.prepare("SELECT action, COUNT(*) as count FROM broca_actions GROUP BY action ORDER BY count DESC LIMIT 20").all();

    return json({ total, narrated, by_service, by_agent, by_action });
  }

  return null;
}
