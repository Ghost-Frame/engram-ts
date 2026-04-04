// ============================================================================
// PACK DOMAIN - Route handlers
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { packMemories, type PackFormat } from "./index.ts";

export function registerPackRoutes(router: Router): void {

  // POST /pack - greedy knapsack memory packing
  router.post("/pack", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    try {
      const body = rawBody as any;
      const context = body.context || "";
      const tokenBudget = Math.max(100, Math.min(Number(body.tokens) || 4000, 128000));
      const rawFormat = body.format || "text";
      const format: PackFormat = (rawFormat === "json" || rawFormat === "xml") ? rawFormat : "text";

      const result = await packMemories(context, tokenBudget, format, auth.user_id);
      return json(result);
    } catch (e: any) {
      return safeError("Pack", e);
    }
  });

}
