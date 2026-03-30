// ============================================================================
// FSRS DOMAIN -- Route handlers
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope, canAccessOwnedRow } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { getFSRSForUser, updateFSRS, getMemoryWithoutEmbedding, getUninitializedFSRS, db } from "./db.ts";
import { FSRSRating, fsrsProcessReview, fsrsRetrievability, fsrsNextInterval } from "./index.ts";
import { trackAccessWithFSRS } from "../db/index.ts";

export function registerFsrsRoutes(router: Router): void {

  // POST /fsrs/review -- Record a review grade for a memory
  router.post("/fsrs/review", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = await req.json() as any;
      const id = Number(body.id);
      const grade = Number(body.grade || 3) as FSRSRating;
      if (!id || grade < 1 || grade > 4) return errorResponse("id required, grade 1-4", 400);
      const mem = getMemoryWithoutEmbedding.get(id) as any;
      if (!canAccessOwnedRow(mem, auth)) return errorResponse("not found", 404);
      trackAccessWithFSRS(id, grade);
      const updated = getFSRSForUser.get(id, auth.user_id) as any;
      return json({ id, fsrs: updated });
    } catch (e: any) { return errorResponse(e.message, 400); }
  });

  // GET /fsrs/state -- Get FSRS state for a memory
  router.get("/fsrs/state", async (req) => {
    const { auth, url } = getContext(req);
    const id = Number(url.searchParams.get("id"));
    if (!id) return errorResponse("id required", 400);
    const row = getFSRSForUser.get(id, auth.user_id) as any;
    if (!row) return errorResponse("not found", 404);
    const elapsed = row.fsrs_last_review_at
      ? (Date.now() - new Date(row.fsrs_last_review_at + "Z").getTime()) / 86400000
      : (Date.now() - new Date(row.created_at + "Z").getTime()) / 86400000;
    const retrievability = row.fsrs_stability
      ? fsrsRetrievability(row.fsrs_stability, elapsed)
      : null;
    const nextReview = row.fsrs_stability
      ? fsrsNextInterval(row.fsrs_stability)
      : null;
    return json({ id, retrievability, next_review_days: nextReview, ...row });
  });

  // POST /fsrs/init -- Backfill FSRS state for all memories that lack it
  router.post("/fsrs/init", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const uninitialized = getUninitializedFSRS(auth.user_id);
    let count = 0;
    const batch = db.transaction(() => {
      for (const m of uninitialized) {
        const init = fsrsProcessReview(null, FSRSRating.Good, 0);
        updateFSRS.run(
          init.stability, init.difficulty, init.storage_strength,
          init.retrieval_strength, init.learning_state, init.reps, init.lapses,
          init.last_review_at, m.id
        );
        count++;
      }
    });
    batch();
    return json({ initialized: count });
  });
}
