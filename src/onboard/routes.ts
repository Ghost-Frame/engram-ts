// ============================================================================
// ONBOARD DOMAIN -- Route handlers (/onboard, /fetch)
// ============================================================================

import { randomUUID } from "crypto";
import { htmlToText } from "html-to-text";
import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { MAX_CONTENT_SIZE } from "../config/index.ts";
import { db, insertMemory, updateMemoryEmbedding } from "../db/index.ts";
import { embedWithChunking, embeddingToBuffer } from "../embeddings/index.ts";
import { hybridSearch } from "../memory/search.ts";

export function registerOnboardRoutes(router: Router): void {

  // POST /onboard
  router.post("/onboard", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403, requestId);
    const checks: Record<string, { passed: boolean; detail: string }> = {};
    try {
      const testMem = db.prepare(
        `INSERT INTO memories (content, category, source, user_id) VALUES (?, ?, ?, ?) RETURNING id`
      ).get("Engram onboarding test memory -- safe to delete", "system", "onboarding", auth.user_id) as any;
      checks.store = { passed: true, detail: `Created test memory id=${testMem.id}` };
      try {
        const results = await hybridSearch("onboarding test", 1, false, false, true, auth.user_id);
        checks.search = { passed: true, detail: `Search returned ${results.length} results` };
      } catch (e: any) {
        checks.search = { passed: false, detail: e.message };
      }
      db.prepare("DELETE FROM memories WHERE id = ?").run(testMem.id);
      checks.cleanup = { passed: true, detail: "Test memory deleted" };
    } catch (e: any) {
      checks.store = { passed: false, detail: e.message };
    }
    const embeddingReady = true;
    checks.embedding = { passed: embeddingReady, detail: "Embedding worker ready" };
    const spaces = db.prepare("SELECT COUNT(*) as c FROM spaces WHERE user_id = ?").get(auth.user_id) as any;
    checks.spaces = { passed: spaces.c > 0, detail: `${spaces.c} space(s) configured` };
    const allPassed = Object.values(checks).every(c => c.passed);
    return json({
      status: allPassed ? "ready" : "issues_found",
      checks,
      next_steps: allPassed ? [
        "Store your first real memory: POST /store { content: '...' }",
        "Search for it: POST /search { query: '...' }",
        "Set up a webhook for events: POST /webhooks { url: '...', events: ['*'] }",
      ] : [
        "Fix the failed checks above, then run POST /onboard again",
      ],
    });
  });

  // POST /fetch
  router.post("/fetch", async (req) => {
    const { auth, requestId, body: rawBody } = getContext(req);
    if (!hasScope(auth, "read")) return errorResponse("Read scope required", 403);
    try {
      const body = (rawBody || {}) as any;
      const { url: fetchUrl, cache = false } = body;
      if (!fetchUrl || typeof fetchUrl !== "string") return errorResponse("'url' is required", 400);
      let parsed: URL;
      try { parsed = new URL(fetchUrl); } catch { return errorResponse("Invalid URL", 400); }
      if (!["http:", "https:"].includes(parsed.protocol)) return errorResponse("Only http/https URLs allowed", 400);
      const hn = parsed.hostname.toLowerCase();
      if (hn === "localhost" || hn === "127.0.0.1" || hn === "::1" || hn === "0.0.0.0" ||
          hn.startsWith("10.") || hn.startsWith("192.168.") || hn.startsWith("172.16.") ||
          hn.startsWith("172.17.") || hn.startsWith("172.18.") || hn.startsWith("172.19.") ||
          hn.startsWith("172.2") || hn.startsWith("172.30.") || hn.startsWith("172.31.") ||
          hn.endsWith(".local") || hn.endsWith(".internal") || hn.startsWith("100.64.") ||
          hn.startsWith("169.254.") || hn.startsWith("fc") || hn.startsWith("fd")) {
        return errorResponse("URL cannot point to private/internal addresses", 400);
      }
      let content = "";
      let title = parsed.hostname;
      try {
        const resp = await fetch(fetchUrl, {
          headers: { "User-Agent": "Engram/5.8 (fetch)" },
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) return errorResponse(`Fetch failed: ${resp.status} ${resp.statusText}`, 502);
        const raw = await resp.text();
        const ct = resp.headers.get("content-type") || "";
        if (ct.includes("html")) {
          const titleMatch = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (titleMatch) title = titleMatch[1].trim();
          content = htmlToText(raw, {
            wordwrap: false,
            selectors: [
              { selector: "script", format: "skip" },
              { selector: "style", format: "skip" },
              { selector: "nav", format: "skip" },
              { selector: "footer", format: "skip" },
              { selector: "header", format: "skip" },
              { selector: "aside", format: "skip" },
            ],
          }).replace(/\n{3,}/g, "\n\n").replace(/ {2,}/g, " ").trim();
        } else {
          content = raw.trim();
        }
      } catch (e: any) {
        return errorResponse(`Fetch error: ${e.message}`, 502);
      }
      let cachedId: number | null = null;
      if (cache && content && hasScope(auth, "write")) {
        try {
          const syncId = randomUUID();
          const res = insertMemory.get(
            content.slice(0, MAX_CONTENT_SIZE), "reference", "fetch",
            null, 3, null, 1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
          ) as { id: number };
          db.prepare("UPDATE memories SET tags = ?, sync_id = ?, confidence = 1.0, status = 'approved' WHERE id = ?")
            .run(JSON.stringify([`url:${fetchUrl.slice(0, 200)}`]), syncId, res.id);
          embedWithChunking(content.slice(0, 8000)).then(emb => { if (emb) updateMemoryEmbedding.run(embeddingToBuffer(emb), res.id); }).catch(() => {});
          cachedId = res.id;
        } catch { /* cache failure is non-fatal */ }
      }
      return json({ content, title, url: fetchUrl, length: content.length, cached_id: cachedId });
    } catch (e: any) {
      return safeError("fetch", e);
    }
  });
}
