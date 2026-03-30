// ============================================================================
// DOCS DOMAIN -- Route handlers (/docs/resolve, /errors)
// ============================================================================

import { randomUUID } from "crypto";
import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { MAX_CONTENT_SIZE } from "../config/index.ts";
import { log } from "../config/logger.ts";
import { db, insertMemory, updateMemoryEmbedding } from "../db/index.ts";
import { embedWithChunking, embeddingToBuffer } from "../embeddings/index.ts";
import { checkSimHashDuplicate, storeSimHash, boostDuplicate } from "../memory/simhash.ts";

export function registerDocsRoutes(router: Router): void {

  // POST /docs/resolve
  router.post("/docs/resolve", async (req) => {
    const { auth, requestId, body: rawBody } = getContext(req);
    if (!hasScope(auth, "read")) return errorResponse("Read scope required", 403);
    try {
      const body = (rawBody || {}) as any;
      const { library, version, force_refresh = false } = body;
      if (!library || typeof library !== "string") return errorResponse("'library' is required", 400);
      const libKey = library.trim().toLowerCase();
      const cacheTag = `docs:${libKey.replace(/[^a-z0-9@/._-]/g, "")}`;
      const twentyFourHoursAgo = new Date(Date.now() - 86400000).toISOString();

      if (!force_refresh) {
        const cached = db.prepare(
          "SELECT id, content, created_at FROM memories WHERE user_id = ? AND category = 'docs' AND tags LIKE ? AND status = 'approved' AND created_at > ? ORDER BY created_at DESC LIMIT 1"
        ).get(auth.user_id, `%${cacheTag}%`, twentyFourHoursAgo) as any;
        if (cached) {
          log.info({ msg: "docs_cache_hit", library: libKey, id: cached.id, rid: requestId });
          return json({ content: cached.content, library: libKey, cached: true, cached_at: cached.created_at, memory_id: cached.id });
        }
      }

      let content = "";
      let resolvedFrom = "";

      // 1. Try npm (use /latest endpoint to avoid 800KB+ full registry documents)
      try {
        const npmResp = await fetch(`https://registry.npmjs.org/${encodeURIComponent(library)}/latest`, {
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(10000),
        });
        if (npmResp.ok) {
          const pkgInfo = await npmResp.json() as any;
          const latest = pkgInfo.version || "unknown";
          let readme = pkgInfo.readme || "";
          const repoUrl = pkgInfo.repository?.url || "";
          const ghMatch = repoUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/i);
          if (ghMatch) {
            const [, owner, repo] = ghMatch;
            let ghDone = false;
            for (const branch of ["main", "master"]) {
              if (ghDone) break;
              for (const filename of ["README.md", "Readme.md", "readme.md"]) {
                if (ghDone) break;
                try {
                  const rawResp = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`, {
                    signal: AbortSignal.timeout(10000),
                  });
                  if (rawResp.ok) {
                    let text = await rawResp.text();
                    // Handle monorepo pointer files (e.g. "packages/foo/README.md")
                    if (text.length < 200 && /^[\w./-]+\.md$/m.test(text.trim())) {
                      const ptr = text.trim();
                      const ptrResp = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${ptr}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
                      if (ptrResp?.ok) text = await ptrResp.text();
                    }
                    if (text.length > 100) { readme = text; resolvedFrom = `github:${owner}/${repo}`; ghDone = true; }
                  }
                } catch { /* try next */ }
              }
            }
          }
          if (!resolvedFrom && readme) resolvedFrom = `npm:${library}`;
          if (readme) content = `# ${library}\n\n**Version**: ${latest}\n**Source**: ${resolvedFrom || `npm:${library}`}\n\n${readme}`.slice(0, MAX_CONTENT_SIZE);
        }
      } catch { /* fall through */ }

      // 2. Try PyPI
      if (!content) {
        try {
          const pypiResp = await fetch(`https://pypi.org/pypi/${encodeURIComponent(library)}/json`, {
            signal: AbortSignal.timeout(10000),
          });
          if (pypiResp.ok) {
            const pypiData = await pypiResp.json() as any;
            const info = pypiData.info || {};
            const readme = info.description || "";
            if (readme) {
              resolvedFrom = `pypi:${library}`;
              content = `# ${library}\n\n**Version**: ${info.version || "unknown"}\n**Source**: pypi\n\n${readme}`.slice(0, MAX_CONTENT_SIZE);
            }
          }
        } catch { /* fall through */ }
      }

      // 3. Try GitHub directly (owner/repo format)
      if (!content && library.includes("/")) {
        const [owner, repo] = library.split("/");
        let ghDirectDone = false;
        for (const branch of ["main", "master"]) {
          if (ghDirectDone) break;
          for (const filename of ["README.md", "Readme.md", "readme.md"]) {
            if (ghDirectDone) break;
            try {
              const rawResp = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`, { signal: AbortSignal.timeout(10000) });
              if (rawResp.ok) {
                let text = await rawResp.text();
                if (text.length < 200 && /^[\w./-]+\.md$/m.test(text.trim())) {
                  const ptrResp = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${text.trim()}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
                  if (ptrResp?.ok) text = await ptrResp.text();
                }
                if (text.length > 100) { resolvedFrom = `github:${owner}/${repo}`; content = text.slice(0, MAX_CONTENT_SIZE); ghDirectDone = true; }
              }
            } catch { /* try next */ }
          }
        }
      }

      if (!content) return errorResponse(`Could not resolve docs for '${library}'`, 404);

      let memoryId: number | null = null;
      if (hasScope(auth, "write")) {
        try {
          const syncId = randomUUID();
          const res = insertMemory.get(
            content, "docs", "docs-resolver",
            null, 3, null, 1, 1, null, null, 1, 1, 0, null, null, 0, null, auth.user_id, auth.space_id || null
          ) as { id: number };
          const tagsArr = [cacheTag, `source:${resolvedFrom}`, ...(version ? [`version:${version}`] : [])];
          db.prepare("UPDATE memories SET tags = ?, sync_id = ?, confidence = 1.0, status = 'approved' WHERE id = ?")
            .run(JSON.stringify(tagsArr), syncId, res.id);
          embedWithChunking(content.slice(0, 8000)).then(emb => { if (emb) updateMemoryEmbedding.run(embeddingToBuffer(emb), res.id); }).catch(() => {});
          memoryId = res.id;
          log.info({ msg: "docs_cached", library: libKey, id: res.id, source: resolvedFrom, rid: requestId });
        } catch { /* cache failure non-fatal */ }
      }
      return json({ content, library: libKey, cached: false, source: resolvedFrom, memory_id: memoryId });
    } catch (e: any) {
      return safeError("docs resolve", e);
    }
  });

  // POST /errors
  router.post("/errors", async (req) => {
    const { auth, requestId, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = (rawBody || {}) as any;
      const { type, message, stack, source: errSource, severity = "error", context } = body;
      if (!message || typeof message !== "string") return errorResponse("'message' is required", 400);
      const errType = (type || "Error").trim();
      const errSeverity = ["fatal", "error", "warning", "info"].includes(severity) ? severity : "error";
      const importance = errSeverity === "fatal" ? 9 : errSeverity === "error" ? 7 : errSeverity === "warning" ? 5 : 3;
      const content = [
        `[${errSeverity.toUpperCase()}] ${errType}: ${message}`,
        stack ? `\nStack:\n${String(stack).slice(0, 2000)}` : "",
        context ? `\nContext: ${typeof context === "string" ? context : JSON.stringify(context).slice(0, 500)}` : "",
      ].filter(Boolean).join("");
      const tags = [`error-type:${errType}`, `severity:${errSeverity}`, `agent:${errSource || "unknown"}`];
      const simhashResult = checkSimHashDuplicate(content, auth.user_id);
      if (simhashResult.isDuplicate && simhashResult.existingId) {
        boostDuplicate(simhashResult.existingId);
        return json({ stored: false, duplicate: true, existing_id: simhashResult.existingId, boosted: true });
      }
      const syncId = randomUUID();
      const res = insertMemory.get(
        content, "error", errSource || "unknown",
        null, importance, null, 1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
      ) as { id: number };
      db.prepare("UPDATE memories SET tags = ?, sync_id = ?, confidence = 1.0, status = 'approved' WHERE id = ?")
        .run(JSON.stringify(tags), syncId, res.id);
      if (simhashResult.simhash) storeSimHash(res.id, simhashResult.simhash);
      embedWithChunking(content).then(emb => { if (emb) updateMemoryEmbedding.run(embeddingToBuffer(emb), res.id); }).catch(() => {});
      log.info({ msg: "error_stored", type: errType, severity: errSeverity, id: res.id, rid: requestId });
      return json({ stored: true, id: res.id, type: errType, severity: errSeverity });
    } catch (e: any) {
      return safeError("errors post", e);
    }
  });

  // GET /errors
  router.get("/errors", (req) => {
    const { auth, url } = getContext(req);
    if (!hasScope(auth, "read")) return Promise.resolve(errorResponse("Read scope required", 403));
    try {
      const windowParam = url.searchParams.get("window") || "24h";
      const agentParam = url.searchParams.get("agent");
      const typeParam = url.searchParams.get("type");
      const limitParam = Math.min(Number(url.searchParams.get("limit") || "100"), 500);
      const windowMs: Record<string, number> = { "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
      const ms = windowMs[windowParam] || 86400000;
      const since = new Date(Date.now() - ms).toISOString();
      let query = "SELECT id, content, tags, created_at, source FROM memories WHERE user_id = ? AND category = 'error' AND status = 'approved' AND created_at > ?";
      const params: any[] = [auth.user_id, since];
      if (agentParam) { query += " AND (tags LIKE ? OR source = ?)"; params.push(`%agent:${agentParam}%`, agentParam); }
      if (typeParam) { query += " AND tags LIKE ?"; params.push(`%error-type:${typeParam}%`); }
      query += " ORDER BY created_at DESC LIMIT ?";
      params.push(limitParam);
      const errors = db.prepare(query).all(...params) as any[];
      const grouped: Record<string, { type: string; count: number; severity: string; last_seen: string; first_seen: string; examples: any[] }> = {};
      for (const e of errors) {
        const eTags = JSON.parse(e.tags || "[]") as string[];
        const errType = eTags.find(t => t.startsWith("error-type:"))?.replace("error-type:", "") || "Unknown";
        const sev = eTags.find(t => t.startsWith("severity:"))?.replace("severity:", "") || "error";
        if (!grouped[errType]) grouped[errType] = { type: errType, count: 0, severity: sev, last_seen: e.created_at, first_seen: e.created_at, examples: [] };
        grouped[errType].count++;
        if (e.created_at > grouped[errType].last_seen) grouped[errType].last_seen = e.created_at;
        if (e.created_at < grouped[errType].first_seen) grouped[errType].first_seen = e.created_at;
        if (grouped[errType].examples.length < 3) grouped[errType].examples.push({ id: e.id, message: e.content.split("\n")[0], created_at: e.created_at, source: e.source });
      }
      const issues = Object.values(grouped).sort((a, b) => b.count - a.count);
      return Promise.resolve(json({ issues, total: errors.length, window: windowParam, since }));
    } catch (e: any) {
      return Promise.resolve(safeError("errors get", e));
    }
  });
}
