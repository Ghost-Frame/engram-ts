#!/usr/bin/env -S node --experimental-strip-types
// ============================================================================
// ENGRAM SERVER v6 - Modular entry point
// ============================================================================

import "./src/tracing.ts";
import { createServer } from "http";

import { PORT, HOST, PKG_VERSION, CORS_ORIGIN, OPEN_ACCESS } from "./src/config/index.ts";
import { log } from "./src/config/logger.ts";
import { createRouter } from "./src/router/index.ts";
import { createAuthMiddleware } from "./src/middleware/auth.ts";
import { setWebhookEmitter } from "./src/middleware/audit.ts";
import { securityHeaders, json } from "./src/helpers/index.ts";

// Database (importing triggers schema creation + migrations)
import { db } from "./src/db/connection.ts";

// Embeddings
import { initEmbedder, embed, isEmbedderReady, refreshEmbeddingCache, embeddingCacheLatest } from "./src/embeddings/index.ts";
import { initReranker } from "./src/reranker/index.ts";
import { isLLMAvailable } from "./src/llm/index.ts";

// GUI
import { reloadGuiHtml, guiAuthed } from "./src/gui/index.ts";

// Webhooks
import { emitWebhookEvent } from "./src/platform/webhooks.ts";

// Wire webhook emitter into middleware
setWebhookEmitter((userId, event, payload) => emitWebhookEvent(userId, event, payload));

// ============================================================================
// INITIALIZATION
// ============================================================================

await initEmbedder();
await initReranker();

// WAL checkpoint at startup
try {
  const result = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
  const r = result[0] || {};
  log.info({ msg: "wal_checkpoint", busy: r.busy, log: r.log, checkpointed: r.checkpointed });
} catch (e: any) {
  log.warn({ msg: "wal_checkpoint_failed", error: e.message });
}

// Pre-warm embeddings
{
  refreshEmbeddingCache();
  await embed("warmup");
  log.info({ msg: "warmup_complete", cache_size: embeddingCacheLatest.length });
}

// ============================================================================
// ROUTER
// ============================================================================

const router = createRouter();

// Auth middleware (skipped for health probes below)
router.use(createAuthMiddleware(guiAuthed));

// --- Health routes (no auth needed, registered before auth middleware applies) ---
// NOTE: These are registered first. The auth middleware runs for all routes,
// but health/live endpoints should work without auth. We handle this by
// checking the path in the auth middleware and skipping auth for these paths.
// TODO: Add pre-auth route support to router in a future iteration.

// --- Domain routes ---
import { registerMemoryRoutes } from "./src/memory/routes.ts";
import { registerSearchRoutes } from "./src/search/routes.ts";
import { registerEpisodeRoutes } from "./src/episodes/routes.ts";
import { registerGraphRoutes } from "./src/graph/routes.ts";
import { registerProjectRoutes } from "./src/projects/routes.ts";
import { registerIntelligenceRoutes } from "./src/intelligence/routes.ts";
import { registerConversationRoutes } from "./src/conversations/routes.ts";
import { registerContextRoutes } from "./src/context/routes.ts";
import { buildContextDeps } from "./src/context/deps.ts";
import { registerPackRoutes } from "./src/pack/routes.ts";
import { registerIngestionRoutes } from "./src/ingestion/routes.ts";
import { registerAuthKeysRoutes } from "./src/auth-keys/routes.ts";
import { registerAdminRoutes } from "./src/admin/routes.ts";
import { registerFsrsRoutes } from "./src/fsrs/routes.ts";
import { registerWebhookRoutes } from "./src/webhooks/routes.ts";
import { registerAgentRoutes } from "./src/agents/routes.ts";
import { registerScratchRoutes } from "./src/scratch/routes.ts";
import { registerSkillRoutes } from "./src/skills/routes.ts";
import { registerInboxRoutes } from "./src/inbox/routes.ts";
import { registerHealthRoutes } from "./src/health/routes.ts";
import { registerPromptRoutes } from "./src/prompts/routes.ts";
import { registerGuardRoutes } from "./src/guard/routes.ts";
import { registerDocsRoutes } from "./src/docs/routes.ts";
import { registerOnboardRoutes } from "./src/onboard/routes.ts";
import { registerArtifactRoutes } from "./src/artifacts/routes.ts";

registerHealthRoutes(router);       // pre-auth: /live, /ready, /health, /metrics
registerMemoryRoutes(router);
registerSearchRoutes(router);
registerEpisodeRoutes(router);
registerGraphRoutes(router);
registerProjectRoutes(router);
registerIntelligenceRoutes(router);
registerConversationRoutes(router);
registerContextRoutes(router, buildContextDeps());
registerPackRoutes(router);
registerIngestionRoutes(router);
registerAuthKeysRoutes(router);
registerAdminRoutes(router);
registerFsrsRoutes(router);
registerWebhookRoutes(router);
registerAgentRoutes(router);
registerScratchRoutes(router);
registerSkillRoutes(router);
registerInboxRoutes(router);
registerPromptRoutes(router);
registerGuardRoutes(router);
registerDocsRoutes(router);
registerOnboardRoutes(router);
registerArtifactRoutes(router);

// Syntheos consolidated services (legacy handler pattern -> router fallback)
import { handleThymusRoutes, handleSomaRoutes, handleChiasmRoutes, handleAxonRoutes, handleLoomRoutes, handleBrocaRoutes } from "./src/services/index.ts";

// Register Syntheos services as router fallbacks.
// These use the legacy (method, url, req, requestId) pattern.
// The fallback adapter runs auth middleware (already applied by router.use)
// then delegates to the handler chain.
const synthesosFallback = async (req: Request): Promise<Response | null> => {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const requestId = crypto.randomUUID().slice(0, 8);
  return (
    await handleThymusRoutes(method, url, req, requestId) ??
    await handleSomaRoutes(method, url, req, requestId) ??
    await handleChiasmRoutes(method, url, req, requestId) ??
    await handleAxonRoutes(method, url, req, requestId) ??
    await handleLoomRoutes(method, url, req, requestId) ??
    await handleBrocaRoutes(method, url, req, requestId)
  );
};
router.fallback(synthesosFallback);


// ============================================================================
// JOB QUEUE - Register handlers and start drain loop
// ============================================================================

import { registerJobHandler, drainJobs, recoverStuckJobs } from "./src/jobs/index.ts";
import { writeVec, db as jobDb } from "./src/db/index.ts";
import { autoLink } from "./src/memory/search.ts";
import { updateCooccurrences } from "./src/graph/cooccurrence.ts";
import { FSRSRating, fsrsProcessReview, calculateDecayScore } from "./src/fsrs/index.ts";

registerJobHandler("post_store", async (payload) => {
  const { memoryId, content, category, userId, importance, embeddingBase64, lightweight } = payload;
  if (!memoryId) return;

  // Write vec table entry for ANN search
  if (embeddingBase64) {
    try {
      const embArray = new Float32Array(Buffer.from(embeddingBase64, "base64").buffer);
      const vecJson = JSON.stringify(Array.from(embArray));
      writeVec.run(vecJson, memoryId);
    } catch {}
  }

  if (lightweight) return;

  // Auto-link with entities and projects
  if (content && userId) {
    try { await autoLink(memoryId, content, userId); } catch {}
  }

  // Update co-occurrences
  if (content && userId) {
    try { updateCooccurrences(memoryId, content, userId); } catch {}
  }

  // FSRS init if not already set
  if (memoryId) {
    try {
      const row = jobDb.prepare("SELECT fsrs_stability FROM memories WHERE id = ?").get(memoryId) as any;
      if (!row?.fsrs_stability) {
        const init = fsrsProcessReview(null, FSRSRating.Good, 0);
        const decay = calculateDecayScore(init.stability, init.difficulty, 0);
        jobDb.prepare(
          `UPDATE memories SET fsrs_stability=?, fsrs_difficulty=?, fsrs_storage_strength=?,
           fsrs_retrieval_strength=?, fsrs_learning_state=?, fsrs_reps=?, fsrs_lapses=?,
           fsrs_last_review_at=?, decay_score=? WHERE id=?`
        ).run(
          init.stability, init.difficulty, init.storage_strength, init.retrieval_strength,
          init.learning_state, init.reps, init.lapses, init.last_review_at, decay, memoryId
        );
      }
    } catch {}
  }
});

// Drain pending jobs every 5 seconds
recoverStuckJobs();
setInterval(async () => {
  try { await drainJobs(10); } catch {}
}, 5000);

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = createServer(async (req, res) => {
  try {
    const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const host = req.headers.host || `${HOST}:${PORT}`;
    const url = `${protocol}://${host}${req.url || "/"}`;
    const request = new Request(url, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v!])
      ),
      body: req.method !== "GET" && req.method !== "HEAD"
        ? await new Promise<Buffer>((resolve) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => resolve(Buffer.concat(chunks)));
          })
        : undefined,
      duplex: "half",
    } as any);

    const response = await router.handle(request);

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const body = await response.arrayBuffer();
    res.end(Buffer.from(body));
  } catch (e: any) {
    log.error({ msg: "unhandled_error", error: e.message, stack: e.stack?.split("\n")[1]?.trim() });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, HOST, () => {
  log.info({
    msg: "server_started",
    version: PKG_VERSION,
    host: HOST,
    port: PORT,
    open_access: OPEN_ACCESS,
    cors: CORS_ORIGIN,
  });
});
