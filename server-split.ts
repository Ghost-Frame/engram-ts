#!/usr/bin/env -S node --experimental-strip-types
// ============================================================================
// ENGRAM SERVER â€” Modular entry point
// Run: node --experimental-strip-types server-split.ts
// ============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from "http";

// Config
import { PORT, HOST, OPEN_ACCESS, CORS_ORIGIN, ALLOWED_IPS, CONSOLIDATION_INTERVAL, FORGET_SWEEP_INTERVAL } from "./src/config/index.ts";
import { log } from "./src/config/logger.ts";

// Database (importing triggers schema creation + migrations)
import { db, updateMemoryEmbedding, writeVec, purgeExpiredScratchpad, getExpiredScratchSessions, insertMemory, updateMemoryVec } from "./src/db/index.ts";

// Embeddings
import { initEmbedder, embed, refreshEmbeddingCache, embeddingCacheLatest, embeddingToBuffer, embeddingToVectorJSON, addToEmbeddingCache } from "./src/embeddings/index.ts";

// Config (for embedding dimension check)
import { EMBEDDING_DIM, EMBEDDING_PROVIDER } from "./src/config/index.ts";

// Cross-encoder reranker
import { initReranker } from "./src/reranker/index.ts";

// GUI (importing triggers HMAC secret init)
import { reloadGuiHtml } from "./src/gui/index.ts";

// Routes
import { fetchHandler, sweepExpiredMemories, backfillEmbeddings } from "./src/routes/index.ts";
import { updateDecayScores } from "./src/db/index.ts";

// Intelligence
import { runConsolidationSweep } from "./src/intelligence/consolidation.ts";

// LLM
import { callLLM, isLLMAvailable } from "./src/llm/index.ts";

// Search (autoLink)
import { autoLink } from "./src/memory/search.ts";

// Platform
import { processScheduledDigests } from "./src/platform/digest.ts";
import { drainWebhooks } from "./src/platform/webhooks.ts";

// Jobs
import { registerJobHandler, drainJobs, getJobStats, cleanupCompletedJobs, recoverStuckJobs } from "./src/jobs/index.ts";
import { withLease, releaseAllLeases, INSTANCE_ID } from "./src/jobs/scheduler.ts";

// Extraction + Personality (for job handlers)
import { extractFacts, processExtractionResult } from "./src/llm/index.ts";
import { extractPersonalitySignals } from "./src/intelligence/personality.ts";
import { cosineSimilarity, getCachedEmbeddings } from "./src/embeddings/index.ts";
import { LLM_API_KEY } from "./src/config/index.ts";

// ============================================================================
// INITIALIZATION
// ============================================================================

await initEmbedder();
await initReranker();

// Pre-warm: load embedding cache + JIT-compile ONNX model
{
  const _warmStart = Date.now();
  refreshEmbeddingCache();
  await embed("warmup");
  log.info({ msg: "warmup_complete", cache_size: embeddingCacheLatest.length, ms: Date.now() - _warmStart });
}

// ============================================================================
// JOB HANDLERS â€” Durable processing for post-store pipeline
// ============================================================================

registerJobHandler("post_store", async (payload) => {
  const { memoryId, content, category, userId, importance, embeddingBase64 } = payload;
  const embArray = embeddingBase64 ? new Float32Array(Buffer.from(embeddingBase64, "base64").buffer) : null;

  if (!embArray) return;

  // Verify the memory still exists (could be deleted between enqueue and processing)
  const exists = db.prepare("SELECT id FROM memories WHERE id = ?").get(memoryId);
  if (!exists) {
    log.info({ msg: "job_skipped_deleted", memory_id: memoryId });
    return;
  }

  // 1. Write vector column + update cache
  writeVec(memoryId, embArray);
  addToEmbeddingCache({
    id: memoryId, user_id: userId, content, category,
    importance, embedding: embArray,
    is_static: false, source_count: 1, is_latest: true, is_forgotten: false,
  });

  // 2. Auto-link
  await autoLink(memoryId, embArray, userId);

  // 3. Fact extraction
  if (LLM_API_KEY || isLLMAvailable()) {
    const allMems = getCachedEmbeddings(true, userId);
    const similarities: Array<{ id: number; content: string; category: string; score: number }> = [];
    for (const mem of allMems) {
      if (mem.id === memoryId) continue;
      const sim = cosineSimilarity(embArray, mem.embedding);
      if (sim > 0.4) similarities.push({ id: mem.id, content: mem.content, category: mem.category, score: sim });
    }
    similarities.sort((a, b) => b.score - a.score);
    const extraction = await extractFacts(content, category, similarities.slice(0, 3));
    if (extraction) processExtractionResult(memoryId, extraction, embArray, userId);
  }

  // 4. Personality signals
  await extractPersonalitySignals(content, memoryId, userId);
});

// Recover any jobs that were running when the process crashed
{
  const recovered = recoverStuckJobs();
  if (recovered > 0) log.info({ msg: "jobs_recovered", count: recovered });
}

// ============================================================================
// HTTP SERVER
// ============================================================================

async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const proto = nodeReq.headers["x-forwarded-proto"] || "http";
  const host = nodeReq.headers.host || `${HOST}:${PORT}`;
  const url = new URL(nodeReq.url || "/", `${proto}://${host}`);
  const method = nodeReq.method || "GET";
  const headers = new Headers();
  for (const [key, val] of Object.entries(nodeReq.headers)) {
    if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
  }
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const MAX_BODY = Number(process.env.ENGRAM_MAX_BODY_SIZE || 1_048_576);
    body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      nodeReq.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) { nodeReq.destroy(); reject(new Error("Body too large")); return; }
        chunks.push(c);
      });
      nodeReq.on("end", () => resolve(Buffer.concat(chunks)));
      nodeReq.on("error", reject);
    });
  }
  return new Request(url.toString(), { method, headers, body, duplex: "half" } as any);
}

async function writeWebResponse(nodeRes: ServerResponse, webRes: Response) {
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  const body = webRes.body;
  if (!body) { nodeRes.end(); return; }
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    nodeRes.write(value);
  }
  nodeRes.end();
}

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    const clientIp = nodeReq.socket.remoteAddress?.replace(/^::ffff:/, "") || "unknown";
    const webReq = await nodeToWebRequest(nodeReq);
    const webRes = await fetchHandler(webReq, clientIp);
    await writeWebResponse(nodeRes, webRes);
  } catch (err: any) {
    if (err.message === "Body too large") {
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(413, { "Content-Type": "application/json" });
      }
      nodeRes.end(JSON.stringify({ error: "Request body too large" }));
      return;
    }
    log.error({ msg: "unhandled_request_error", error: err.message });
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(500, { "Content-Type": "application/json" });
    }
    nodeRes.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, HOST, () => {
  log.info({ msg: "node_http_server_listening", host: HOST, port: PORT });
});

// ============================================================================
// WAL CHECKPOINT (every 5 minutes)
// ============================================================================
function walCheckpoint() {
  try {
    const result = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as any;
    if (result && result.checkpointed > 0) log.debug({ msg: "wal_checkpoint", ...result });
  } catch (e: any) {
    log.error({ msg: "wal_checkpoint_failed", error: e.message });
  }
}
setInterval(walCheckpoint, 5 * 60 * 1000);

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ msg: "shutdown_start", signal });

  // 1. Stop accepting new connections
  server.close();
  log.info({ msg: "http_server_closed" });

  // 2. Drain in-flight webhook deliveries (max 11s, matching fetch timeout)
  await Promise.race([drainWebhooks(), new Promise(r => setTimeout(r, 11000))]);

  // 3. Drain remaining jobs (up to 5 seconds)
  const drainStart = Date.now();
  while (Date.now() - drainStart < 5000) {
    const had = await drainJobs(5);
    if (!had) break;
  }
  log.info({ msg: "jobs_drained_on_shutdown", ms: Date.now() - drainStart });

  // 4. Release leases
  releaseAllLeases();

  // 5. Final WAL checkpoint
  try {
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    log.info({ msg: "wal_final_checkpoint" });
  } catch (e: any) {
    log.error({ msg: "wal_checkpoint_failed", error: e.message });
  }
  try { db.close(); } catch {}
  log.info({ msg: "shutdown_complete", signal });
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGHUP", () => reloadGuiHtml());

// ============================================================================
// STARTUP TASKS
// ============================================================================

// Backfill unembedded memories
const countNoEmbedding = db.prepare("SELECT COUNT(*) as count FROM memories WHERE embedding IS NULL");
const noEmb = (countNoEmbedding.get() as { count: number }).count;
if (noEmb > 0) {
  log.info({ msg: "backfill_start", count: noEmb });
  backfillEmbeddings(200).then((n) => {
    log.info({ msg: "backfill_done", backfilled: n, remaining: noEmb - n });
  }).catch(e => log.error({ msg: "backfill_error", error: String(e) }));
}

// Auto-forget sweep timer (lease-protected)
setInterval(withLease("forget_sweep", () => {
  const swept = sweepExpiredMemories();
  if (swept > 0) log.info({ msg: "auto_forget_sweep", swept });
}, 600), FORGET_SWEEP_INTERVAL);

// Scratchpad TTL sweep â€” summarize expired sessions before purging (lease-protected)
setInterval(withLease("scratchpad_ttl", async () => {
  try {
    // Fetch all expired entries before deleting them
    const expired = getExpiredScratchSessions.all() as Array<{
      user_id: number; session: string; agent: string; model: string;
      entry_key: string; value: string | null;
      created_at: string; updated_at: string;
    }>;
    if (expired.length === 0) return;

    // Group by user_id + session (prevent cross-tenant leakage)
    const sessions = new Map<string, typeof expired>();
    for (const row of expired) {
      const key = `${row.user_id}:${row.session}`;
      const arr = sessions.get(key) || [];
      arr.push(row);
      sessions.set(key, arr);
    }

    let summarized = 0;
    for (const [_key, rows] of sessions) {
      // Only summarize multi-entry sessions â€” single entries aren't worth an LLM call
      if (rows.length >= 2 && isLLMAvailable()) {
        const userId = rows[0].user_id;
        const session = rows[0].session;
        try {
          const agent = rows[0].agent;
          const model = rows[0].model;
          const entriesText = rows.map(r =>
            `[${r.entry_key}] ${r.value || "(empty)"}`
          ).join("\n");

          const summary = await callLLM(
            `You extract lasting knowledge from agent work sessions. Given an agent's scratchpad entries, identify facts worth remembering long-term (infrastructure details, endpoints, architectural decisions, bugs found, solutions). Ignore transient state. If nothing is worth keeping, say "nothing". Be concise.`,
            `Agent: ${agent}\nModel: ${model}\n\nEntries:\n${entriesText}`
          );

          if (summary && summary.toLowerCase().trim() !== "nothing") {
            const content = `[Session summary: ${agent}/${model} #${session.slice(0, 8)}] ${summary.trim()}`;
            const result = insertMemory.get(content, "discovery", agent, null, 5, null, 1, 1, null, null, 1, 0, 0, null, null, 0, model, userId, null) as { id: number; created_at: string };
            try {
              const emb = await embed(content);
              updateMemoryEmbedding.run(embeddingToBuffer(emb), result.id);
              try { updateMemoryVec.run(embeddingToVectorJSON(emb), result.id); } catch {}
              addToEmbeddingCache({ id: result.id, embedding: emb, content, category: "discovery", importance: 5, is_static: 0, source_count: 1, user_id: userId, is_latest: 1, is_forgotten: 0 } as any);
              await autoLink(result.id, emb, userId);
            } catch {}
            summarized++;
            log.info({ msg: "scratchpad_ttl_summarized", session: session.slice(0, 8), memory_id: result.id, user_id: userId, entries: rows.length });
          }
        } catch (e: any) {
          log.warn({ msg: "scratchpad_ttl_summarize_failed", session: session.slice(0, 8), error: e.message });
        }
      }
    }

    // Now purge all expired entries
    const purged = purgeExpiredScratchpad();
    if (purged > 0 || summarized > 0) {
      log.info({ msg: "scratchpad_sweep", purged, summarized, sessions: sessions.size });
    }
  } catch (e: any) {
    log.error({ msg: "scratchpad_sweep_error", error: e.message });
    // Fallback: still purge even if summarization fails
    purgeExpiredScratchpad();
  }
}, 600), 5 * 60 * 1000);

// Decay score refresh (every 15 minutes, lease-protected)
setInterval(withLease("decay_refresh", () => {
  const updated = updateDecayScores();
  if (updated > 0) log.info({ msg: "decay_refresh", updated });
}, 1200), 15 * 60 * 1000);

// Probe LLM reachability (sets cached flag for isLLMAvailable)
import { probeLLM } from "./src/llm/index.ts";
await probeLLM();

// Auto-consolidation sweep (if LLM configured, lease-protected)
if (isLLMAvailable()) {
  setInterval(withLease("consolidation", async () => {
    try {
      const consolidated = await runConsolidationSweep();
      if (consolidated > 0) log.info({ msg: "auto_consolidation", consolidated });
    } catch (e: any) {
      log.error({ msg: "auto_consolidation_error", error: e.message });
    }
  }, 3600), CONSOLIDATION_INTERVAL);
}

// Initial sweeps
sweepExpiredMemories();
updateDecayScores();
purgeExpiredScratchpad();

// Startup embedding dimension check: warn if stored vectors don't match configured provider/dimension
{
  const sample = db.prepare(
    "SELECT id, embedding FROM memories WHERE embedding IS NOT NULL LIMIT 1"
  ).get() as { id: number; embedding: ArrayBuffer | Buffer } | undefined;
  if (sample) {
    const buf = sample.embedding instanceof ArrayBuffer ? sample.embedding
      : sample.embedding.buffer.slice(sample.embedding.byteOffset, sample.embedding.byteOffset + sample.embedding.byteLength);
    const storedDim = buf.byteLength / 4;
    if (storedDim !== EMBEDDING_DIM) {
      log.warn({
        msg: "embedding_dimension_mismatch",
        stored_dim: storedDim,
        configured_dim: EMBEDDING_DIM,
        configured_provider: EMBEDDING_PROVIDER,
        action: "Run POST /admin/reembed to re-embed all memories with the current provider. Search quality will be degraded until re-embedding completes.",
      });
    } else {
      log.info({ msg: "embedding_dimension_ok", dim: storedDim, provider: EMBEDDING_PROVIDER });
    }
  }
}

// Digest scheduler â€” check every 5 minutes for due digests (lease-protected)
setInterval(withLease("digest_scheduler", async () => {
  try {
    const sent = await processScheduledDigests();
    if (sent > 0) log.info({ msg: "digest_sent", count: sent });
  } catch (e: any) {
    log.error({ msg: "digest_scheduler_error", error: e.message });
  }
}, 600), 5 * 60 * 1000);

// Job worker loop â€” process durable queue every 2 seconds
setInterval(async () => {
  try {
    const processed = await drainJobs(10);
    if (processed > 0) log.debug({ msg: "jobs_drained", count: processed });
  } catch (e: any) {
    log.error({ msg: "job_worker_error", error: e.message });
  }
}, 2000);

// Job cleanup â€” purge completed jobs older than 1 day (every hour)
setInterval(withLease("job_cleanup", () => {
  const cleaned = cleanupCompletedJobs();
  const recovered = recoverStuckJobs();
  if (cleaned > 0 || recovered > 0) log.info({ msg: "job_maintenance", cleaned, recovered });
}, 7200), 60 * 60 * 1000);

// Warn if GUI auth is shared across multiple users
import { GUI_AUTH_CONFIGURED } from "./src/gui/index.ts";
{
  const userCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number }).count;
  if (GUI_AUTH_CONFIGURED && userCount > 1) {
    log.warn({ msg: "gui_shared_owner_auth", users: userCount, detail: "GUI password maps all browser sessions to owner (user_id=1). For multi-tenant, use API keys." });
  }
  // Warn if bootstrap is available (no API keys exist)
  const keyCount = (db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE is_active = 1").get() as { count: number }).count;
  if (keyCount === 0) {
    log.warn({ msg: "bootstrap_available", detail: "No API keys exist. POST /bootstrap from localhost to create admin key." });
  }
}

log.info({ msg: "server_started", version: "5.8.1", host: HOST, port: PORT, open_access: OPEN_ACCESS, cors: CORS_ORIGIN, log_level: process.env.ENGRAM_LOG_LEVEL || "info", allowed_ips: ALLOWED_IPS.length || "any" });
