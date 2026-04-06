// ============================================================================
// Brain routes - graph memory query, absorb, dream, feedback, decay
// Prefix: /brain/*
// ============================================================================

import { db } from "../../db/index.ts";
import { json, errorResponse } from "../../helpers/index.ts";
import { getContext } from "../../middleware/auth.ts";
import {
  isBrainReady,
  queryBrain,
  absorbMemory,
  brainStats,
  brainDreamCycle,
  brainFeedbackSignal,
  brainDecayTick,
} from "./manager.ts";

export async function handleBrainRoutes(
  method: string,
  url: URL,
  req: Request,
  requestId: string,
): Promise<Response | null> {
  const path = url.pathname;

  if (!path.startsWith("/brain/") && path !== "/brain") return null;

  const sub = path.slice("/brain".length); // e.g. "/stats" or "/query"

  // -- GET /brain/stats --

  if (sub === "/stats" && method === "GET") {
    if (!isBrainReady()) return json({ ok: false, error: "brain not ready" }, 503);
    try {
      const stats = await brainStats();
      return json({ ok: true, stats });
    } catch (e: any) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // -- POST /brain/query --

  if (sub === "/query" && method === "POST") {
    if (!isBrainReady()) return json({ ok: false, error: "brain not ready" }, 503);
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    if (!body.query || typeof body.query !== "string") {
      return errorResponse("query required", 400, requestId);
    }
    try {
      const result = await queryBrain(body.query, {
        top_k: body.top_k,
        beta: body.beta,
        spread_hops: body.spread_hops,
      });
      return json({ ok: true, result });
    } catch (e: any) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // -- POST /brain/absorb --

  if (sub === "/absorb" && method === "POST") {
    if (!isBrainReady()) return json({ ok: false, error: "brain not ready" }, 503);
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    const id = body.id;
    if (!id || typeof id !== "number") {
      return errorResponse("id required (number)", 400, requestId);
    }
    try {
      const row = db.prepare(
        "SELECT id, content, category, source, importance, created_at, tags FROM memories WHERE id = ?"
      ).get(id) as {
        id: number;
        content: string;
        category: string;
        source: string;
        importance: number;
        created_at: string;
        tags: string | null;
      } | undefined;

      if (!row) return errorResponse("Memory not found", 404, requestId);

      const tags = row.tags
        ? (typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags)
        : undefined;

      await absorbMemory({
        id: row.id,
        content: row.content,
        category: row.category,
        source: row.source,
        importance: row.importance,
        created_at: row.created_at,
        tags,
      });

      return json({ ok: true, id: row.id });
    } catch (e: any) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // -- POST /brain/dream --

  if (sub === "/dream" && method === "POST") {
    if (!isBrainReady()) return json({ ok: false, error: "brain not ready" }, 503);
    try {
      const result = await brainDreamCycle();
      return json({ ok: true, result });
    } catch (e: any) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // -- POST /brain/feedback --

  if (sub === "/feedback" && method === "POST") {
    if (!isBrainReady()) return json({ ok: false, error: "brain not ready" }, 503);
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    if (!Array.isArray(body.memory_ids)) {
      return errorResponse("memory_ids array required", 400, requestId);
    }
    if (!Array.isArray(body.edge_pairs)) {
      return errorResponse("edge_pairs array required", 400, requestId);
    }
    if (typeof body.useful !== "boolean") {
      return errorResponse("useful (boolean) required", 400, requestId);
    }
    try {
      const result = await brainFeedbackSignal(body.memory_ids, body.edge_pairs, body.useful);
      return json({ ok: true, result });
    } catch (e: any) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // -- POST /brain/decay --

  if (sub === "/decay" && method === "POST") {
    if (!isBrainReady()) return json({ ok: false, error: "brain not ready" }, 503);
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    try {
      await brainDecayTick(body.ticks);
      return json({ ok: true });
    } catch (e: any) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
