// ============================================================================
// CONTEXT DOMAIN - Route handlers
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { assembleContext, type ContextDeps } from "./index.ts";
import type { ContextOptions } from "./types.ts";
import { getArtifactsByMemory } from "../db/index.ts";

/**
 * Register POST /context route.
 *
 * deps is injected at server startup so the route handler can call
 * DB/embedding functions from the monolith without the context domain
 * taking a hard dependency on every other subsystem.
 */
export function registerContextRoutes(router: Router, deps: ContextDeps): void {

  router.post("/context", async (req) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "read")) return errorResponse("Read scope required", 403);
    try {
      const b = body as any;
      if (!b?.query || typeof b.query !== "string") {
        return errorResponse("query (string) required");
      }

      const opts: ContextOptions = {
        query: b.query,
        max_tokens: b.max_tokens,
        token_budget: b.token_budget,
        budget: b.budget,
        strategy: b.strategy,
        depth: b.depth,
        mode: b.mode,
        include_static: b.include_static,
        include_recent: b.include_recent,
        include_episodes: b.include_episodes,
        include_linked: b.include_linked,
        include_inference: b.include_inference,
        include_current_state: b.include_current_state,
        include_preferences: b.include_preferences,
        include_structured_facts: b.include_structured_facts,
        include_working_memory: b.include_working_memory,
        max_memory_tokens: b.max_memory_tokens,
        dedup_threshold: b.dedup_threshold,
        min_relevance: b.min_relevance,
        semantic_ceiling: b.semantic_ceiling,
        semantic_limit: b.semantic_limit,
        source: b.source,
        session: b.session,
      };

      const result = await assembleContext(opts, auth.user_id, deps);

      // Enrich context blocks with artifact metadata
      if (result.blocks) {
        for (const b of result.blocks) {
          if (b.id <= 0) { (b as any).artifacts = []; continue; }
          const arts = getArtifactsByMemory.all(b.id) as Array<{ id: number; filename: string; mime_type: string; size_bytes: number }>;
          (b as any).artifacts = arts.map(({ id, filename, mime_type, size_bytes }) => ({ id, filename, mime_type, size_bytes }));
        }
      }

      return json(result);
    } catch (e: any) {
      return safeError("Context build", e);
    }
  });
}
