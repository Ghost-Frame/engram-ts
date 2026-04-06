// ============================================================================
// INTELLIGENCE DOMAIN - Route handlers
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import {
  getRecentReflection, insertReflection, listReflections,
  getPeriodMemories, getKnownContradictions, listConsolidations, db
} from "./db.ts";
import { runConsolidationSweep, consolidateCluster } from "./consolidation.ts";
import { reflect } from "./growth.ts";

export function registerIntelligenceRoutes(router: Router): void {

  // POST /reflect - Generate growth reflection
  router.post("/reflect", async (req) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const b = body as any;
    if (!b?.service || typeof b.service !== "string") {
      return errorResponse("service is required (string)", 400);
    }
    if (!Array.isArray(b?.context) || b.context.length === 0) {
      return errorResponse("context is required (non-empty string array)", 400);
    }
    try {
      const result = await reflect({
        service: b.service,
        context: b.context,
        existing_growth: b.existing_growth,
        prompt_override: b.prompt_override,
      }, auth.user_id);
      return json(result);
    } catch (e: any) {
      return safeError("reflect", e);
    }
  });

  // GET /reflections - List reflections
  router.get("/reflections", async (req) => {
    const { auth, url } = getContext(req);
    const limit = Math.min(Number(url.searchParams.get("limit") || 10), 50);
    const rows = listReflections.all(auth.user_id, limit) as any[];
    const reflections = rows.map((r) => ({
      ...r,
      themes: (() => { try { return JSON.parse(r.themes || "[]"); } catch { return []; } })(),
    }));
    return json({ reflections, total: reflections.length });
  });

  // GET /contradictions - Get contradictions
  router.get("/contradictions", async (req) => {
    const { auth, url } = getContext(req);
    const _threshold = Number(url.searchParams.get("threshold") || 0.6);
    const limit = Math.min(Number(url.searchParams.get("limit") || 30), 100);
    const rows = getKnownContradictions.all(auth.user_id, auth.user_id, limit) as any[];
    const contradictions = rows.map((r) => ({
      memory_a: {
        id: r.source_id,
        content: r.source_content,
        category: r.source_category,
        created_at: r.source_created,
      },
      memory_b: {
        id: r.target_id,
        content: r.target_content,
        category: r.target_category,
        created_at: r.target_created,
      },
      similarity: r.similarity,
      source: "link" as const,
    }));
    return json({ contradictions, total: contradictions.length });
  });

  // POST /contradictions/resolve - Resolve a contradiction
  router.post("/contradictions/resolve", async (req) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const b = body as any;
    if (!b?.memory_a_id || !b?.memory_b_id) return errorResponse("memory_a_id and memory_b_id required");
    const resolution = b.resolution || "keep_both";
    // Remove the contradicts link
    db.prepare(
      "DELETE FROM memory_links WHERE type = 'contradicts' AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))"
    ).run(b.memory_a_id, b.memory_b_id, b.memory_b_id, b.memory_a_id);
    return json({ resolved: true, resolution, memory_a_id: b.memory_a_id, memory_b_id: b.memory_b_id });
  });

  // POST /consolidate - Run consolidation
  router.post("/consolidate", async (req) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const b = body as any;
      if (b?.memory_id) {
        const result = await consolidateCluster(Number(b.memory_id), auth.user_id);
        return json({ result });
      }
      const totalArchived = await runConsolidationSweep(auth.user_id);
      return json({ total_archived: totalArchived });
    } catch (e: any) {
      return safeError("consolidate", e);
    }
  });

  // GET /consolidations - List consolidations
  router.get("/consolidations", async (req) => {
    const { auth } = getContext(req);
    const rows = listConsolidations.all(auth.user_id) as any[];
    const consolidations = rows.map((r) => ({
      ...r,
      source_memory_ids: (() => { try { return JSON.parse(r.source_memory_ids || "[]"); } catch { return []; } })(),
    }));
    return json({ consolidations });
  });
}
