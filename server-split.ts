#!/usr/bin/env -S node --experimental-strip-types
// ============================================================================
// ENGRAM SERVER �?" Modular entry point
// Run: node --experimental-strip-types server-split.ts
// ============================================================================

// OTel tracing -- must be first import to instrument HTTP
import "./src/tracing.ts";

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { existsSync, copyFileSync, statSync, unlinkSync, readdirSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";

// Config
import { PORT, HOST, OPEN_ACCESS, CORS_ORIGIN, ALLOWED_IPS, CONSOLIDATION_INTERVAL, FORGET_SWEEP_INTERVAL, PKG_VERSION, BACKUP_DIR, BACKUP_RETENTION_DAYS, BACKUP_SCHEDULE_HOURS, DATA_DIR, ENGRAM_SKILL_DIRS } from "./src/config/index.ts";
import { syncSkills } from "./src/skills/index.ts";
import { log } from "./src/config/logger.ts";

// Pre-migration schema backup (Phase 6.2)
{
  const _dbPath = process.env.ENGRAM_DATA_DIR
    ? resolve(process.env.ENGRAM_DATA_DIR, "memory.db")
    : resolve(process.cwd(), "data", "memory.db");
  const _dataDir = process.env.ENGRAM_DATA_DIR || resolve(process.cwd(), "data");
  if (existsSync(_dbPath)) {
    const preBackupPath = resolve(_dataDir, `pre-migration-${Date.now()}.db`);
    try {
      copyFileSync(_dbPath, preBackupPath);
      const files = readdirSync(_dataDir).filter((f: string) => f.startsWith("pre-migration-")).sort().reverse();
      for (const f of files.slice(3)) {
        try { unlinkSync(resolve(_dataDir, f)); } catch {}
      }
    } catch {}
  }
}

// Crash-loop protection: if we crashed within 60s, enter safe mode
const CRASH_SENTINEL = resolve(DATA_DIR, ".engram-startup-ts");
let SAFE_MODE = false;
try {
  if (existsSync(CRASH_SENTINEL)) {
    const lastStart = parseInt(readFileSync(CRASH_SENTINEL, "utf-8").trim(), 10);
    if (!isNaN(lastStart) && Date.now() - lastStart < 60000) {
      SAFE_MODE = true;
      log.warn({ msg: "safe_mode_activated", reason: "crash_loop_detected", last_start_ms_ago: Date.now() - lastStart });
    }
  }
} catch {}
try { writeFileSync(CRASH_SENTINEL, String(Date.now())); } catch {}

// Database (importing triggers schema creation + migrations)
import { db, updateMemoryEmbedding, writeVec, purgeExpiredScratchpad, getExpiredScratchSessions, insertMemory, updateMemoryVec, cleanupOldUsage, probeVectorHealth, rebuildVectorIndex, isRebuildInProgress } from "./src/db/index.ts";

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
import { cleanupRateLimits } from "./src/db/index.ts";
import { withLease, releaseAllLeases, INSTANCE_ID } from "./src/jobs/scheduler.ts";

// Extraction + Personality (for job handlers)
import { extractFacts, processExtractionResult } from "./src/llm/index.ts";
import { extractPersonalitySignals, synthesizePersonalityProfile } from "./src/intelligence/personality.ts";
import { cosineSimilarity, getCachedEmbeddings } from "./src/embeddings/index.ts";
import { LLM_API_KEY } from "./src/config/index.ts";

// ============================================================================
// INITIALIZATION
// ============================================================================

await initEmbedder();
await initReranker();

// WAL checkpoint at startup - merge WAL into main DB file before serving requests.
// Without this, a large WAL (from previous sessions) causes synchronous SQLite reads
// to scan the WAL for every page, making all DB queries extremely slow.
{
  const _walStart = Date.now();
  try {
    const result = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
    const r = result[0] || {};
    log.info({ msg: "wal_checkpoint", busy: r.busy, log: r.log, checkpointed: r.checkpointed, ms: Date.now() - _walStart });
  } catch (e: any) {
    log.warn({ msg: "wal_checkpoint_failed", error: e.message });
  }
}

// Startup vector health check
if (!SAFE_MODE) {
  if (!probeVectorHealth()) {
    log.warn({ msg: "startup_corruption_detected", action: "rebuilding_vector_index" });
    const result = rebuildVectorIndex();
    log.info({ msg: "startup_vector_rebuild", ...result });
  }
} else {
  log.warn({ msg: "safe_mode_skip_vector_check" });
}

// Pre-warm: load embedding cache + JIT-compile ONNX model
{
  const _warmStart = Date.now();
  refreshEmbeddingCache();
  await embed("warmup");
  log.info({ msg: "warmup_complete", cache_size: embeddingCacheLatest.length, ms: Date.now() - _warmStart });
}

// ============================================================================
// JOB HANDLERS �?" Durable processing for post-store pipeline
// ============================================================================

registerJobHandler("post_store", async (payload) => {
  const { memoryId, content, category, userId, importance, embeddingBase64, lightweight } = payload;
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

  // 2-4: Heavy processing (skip if lightweight/benchmark mode)
  if (!lightweight) {
    // 2. Auto-link
    await autoLink(memoryId, embArray, userId);

    // 3. Fact extraction
    if (LLM_API_KEY || isLLMAvailable()) {
      const allMems = getCachedEmbeddings(true, userId);
      const similarities: Array<{ id: number; content: string; category: string; score: number }> = [];
      for (let i = 0; i < allMems.length; i++) {
        const mem = allMems[i];
        if (mem.id === memoryId) continue;
        const sim = cosineSimilarity(embArray, mem.embedding);
        if (sim > 0.4) similarities.push({ id: mem.id, content: mem.content, category: mem.category, score: sim });
        // Yield event loop every 500 comparisons to prevent blocking HTTP requests
        if (i > 0 && i % 500 === 0) await new Promise<void>(r => setImmediate(r));
      }
      similarities.sort((a, b) => b.score - a.score);
      const extraction = await extractFacts(content, category, similarities.slice(0, 3));
      if (extraction) processExtractionResult(memoryId, extraction, embArray, userId);
    }

    // 4. Personality signals
    await extractPersonalitySignals(content, memoryId, userId);
  } else {
    log.info({ msg: "post_store_lightweight", memory_id: memoryId });
  }

  // 5. Community detection + PageRank (throttled: every 25th memory)
  try {
    const memCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM memories WHERE user_id = ? AND is_forgotten = 0"
    ).get(userId) as { cnt: number };
    if (memCount.cnt > 0 && memCount.cnt % 25 === 0) {
      const { detectCommunities } = await import("./src/graph/communities.ts");
      detectCommunities(userId);
      const { updatePageRankScores } = await import("./src/graph/pagerank.ts");
      updatePageRankScores(userId);
      log.info({ msg: "post_store_graph_analysis", memory_id: memoryId, total_memories: memCount.cnt });
    }
  } catch (e: any) {
    log.warn({ msg: "post_store_graph_analysis_failed", error: e.message });
  }
});

registerJobHandler("profile_resynthesize", async (payload) => {
  const { userId } = payload;
  if (!userId) return;
  try {
    await synthesizePersonalityProfile(userId);
    log.info({ msg: "profile_resynthesized_bg", userId });
  } catch (e: any) {
    log.warn({ msg: "profile_resynthesize_failed", userId, error: e.message });
    throw e;
  }
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

// HTTP timeouts to prevent connection accumulation and detect hung requests
server.timeout = 120_000;           // 2min max request lifetime
server.keepAliveTimeout = 30_000;   // 30s idle keep-alive before close
server.headersTimeout = 15_000;     // 15s to receive headers
server.requestTimeout = 120_000;    // 2min to receive full request

server.listen(PORT, HOST, () => {
  log.info({ msg: "node_http_server_listening", host: HOST, port: PORT });
  // Clear crash sentinel after successful startup (proves we survived)
  setTimeout(() => {
    try { unlinkSync(CRASH_SENTINEL); } catch {}
  }, 120000);
});

// Skill directory sync (fire-and-forget, does not block startup)
if (ENGRAM_SKILL_DIRS.length > 0) {
  syncSkills(ENGRAM_SKILL_DIRS).then(r => {
    log.info({ msg: "startup_skill_sync", synced: r.synced, errors: r.errors.length });
  }).catch(e => {
    log.warn({ msg: "startup_skill_sync_failed", error: e?.message });
  });
}

// ============================================================================
// WAL CHECKPOINT (every 5 minutes)
// ============================================================================
function walCheckpoint(mode: "PASSIVE" | "TRUNCATE" = "PASSIVE") {
  if (isRebuildInProgress()) {
    log.info({ msg: "wal_checkpoint_skipped", reason: "rebuild_in_progress" });
    return;
  }
  try {
    const cpStart = performance.now();
    db.exec(`PRAGMA wal_checkpoint(${mode})`);
    const cpMs = (performance.now() - cpStart).toFixed(1);
    log.info({ msg: "wal_checkpoint", mode, ms: cpMs });
    if (Number(cpMs) > 1000) {
      log.warn({ msg: "wal_checkpoint_slow", mode, ms: cpMs });
    }
  } catch (e: any) {
    log.error({ msg: "wal_checkpoint_failed", mode, error: e.message });
  }
}
setInterval(walCheckpoint, 5 * 60 * 1000);

// Periodic vector health probe (every 6 hours)
setInterval(() => {
  try {
    if (!probeVectorHealth()) {
      log.warn({ msg: "periodic_corruption_detected", action: "rebuilding_vector_index" });
      const result = rebuildVectorIndex();
      log.info({ msg: "periodic_vector_rebuild", ...result });
    }
  } catch (e: any) {
    log.error({ msg: "periodic_health_probe_error", error: e.message });
  }
}, 6 * 60 * 60 * 1000);

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

// Backfill unembedded memories (deferred to let HTTP server stabilize first)
const countNoEmbedding = db.prepare("SELECT COUNT(*) as count FROM memories WHERE embedding IS NULL");
const noEmb = (countNoEmbedding.get() as { count: number }).count;
if (noEmb > 0) {
  log.info({ msg: "backfill_scheduled", count: noEmb, delay_s: 30 });
  setTimeout(() => {
    backfillEmbeddings(10).then((n) => {
      log.info({ msg: "backfill_done", backfilled: n, remaining: noEmb - n });
    }).catch(e => log.error({ msg: "backfill_error", error: String(e) }));
  }, 30_000);
}

// Auto-forget sweep timer (lease-protected)
setInterval(withLease("forget_sweep", () => {
  const swept = sweepExpiredMemories();
  if (swept > 0) log.info({ msg: "auto_forget_sweep", swept });
}, 600), FORGET_SWEEP_INTERVAL);

// Scratchpad TTL sweep �?" summarize expired sessions before purging (lease-protected)
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
      // Only summarize multi-entry sessions �?" single entries aren't worth an LLM call
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
  try {
    const updated = updateDecayScores();
    if (updated > 0) log.info({ msg: "decay_refresh", updated });
  } catch (e: any) {
    log.error({ msg: "decay_refresh_error", error: e.message, code: e.code });
  }
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
try { updateDecayScores(); } catch (e: any) {
  log.error({ msg: "startup_decay_refresh_error", error: e.message, code: e.code });
}
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

// Digest scheduler �?" check every 5 minutes for due digests (lease-protected)
setInterval(withLease("digest_scheduler", async () => {
  try {
    const sent = await processScheduledDigests();
    if (sent > 0) log.info({ msg: "digest_sent", count: sent });
  } catch (e: any) {
    log.error({ msg: "digest_scheduler_error", error: e.message });
  }
}, 600), 5 * 60 * 1000);

// Job worker loop �?" process durable queue every 2 seconds
// Concurrency lock prevents overlapping drains from stacking CPU-bound work
let jobWorkerRunning = false;
setInterval(async () => {
  if (jobWorkerRunning) return; // skip if previous drain is still running
  jobWorkerRunning = true;
  try {
    const processed = await drainJobs(3);
    if (processed > 0) log.debug({ msg: "jobs_drained", count: processed });
  } catch (e: any) {
    log.error({ msg: "job_worker_error", error: e.message });
  } finally {
    jobWorkerRunning = false;
  }
}, 2000);

// Job cleanup �?" purge completed jobs older than 1 day (every hour)
setInterval(withLease("job_cleanup", () => {
  const cleaned = cleanupCompletedJobs();
  const recovered = recoverStuckJobs();
  cleanupRateLimits.run();
  if (cleaned > 0 || recovered > 0) log.info({ msg: "job_maintenance", cleaned, recovered });
}, 7200), 60 * 60 * 1000);

// Auto backup schedule (Phase 2.3.4)
if (BACKUP_SCHEDULE_HOURS > 0) {
  const backupIntervalMs = BACKUP_SCHEDULE_HOURS * 60 * 60 * 1000;
  setInterval(withLease("auto_backup", async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = resolve(BACKUP_DIR, `engram-auto-${timestamp}.db`);
    try {
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      const size = statSync(backupPath).size;
      log.info({ msg: "auto_backup_created", path: backupPath, size_mb: Math.round(size / 1048576 * 100) / 100 });

      const files = readdirSync(BACKUP_DIR).filter((f: string) => f.startsWith("engram-auto-") && f.endsWith(".db"));
      const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      for (const f of files) {
        const fPath = resolve(BACKUP_DIR, f);
        try {
          if (statSync(fPath).mtimeMs < cutoff) {
            unlinkSync(fPath);
            log.info({ msg: "auto_backup_pruned", path: fPath });
          }
        } catch {}
      }
    } catch (e: any) {
      log.error({ msg: "auto_backup_failed", error: e.message });
    }
  }), backupIntervalMs);
  log.info({ msg: "auto_backup_enabled", interval_hours: BACKUP_SCHEDULE_HOURS, retention_days: BACKUP_RETENTION_DAYS });
}

// Daily garbage collection (runs at 4 AM, lease-protected)
setInterval(withLease("garbage_collection", async () => {
  const hour = new Date().getHours();
  if (hour !== 4) return;
  try {
    const gcTransaction = db.transaction(() => {
      const forgotten = db.prepare("DELETE FROM memories WHERE is_forgotten = 1 AND updated_at < datetime('now', '-30 days')").run();
      const links = db.prepare("DELETE FROM memory_links WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.source_id AND m.is_forgotten = 0) OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.target_id AND m.is_forgotten = 0)").run();
      const scratch = db.prepare("DELETE FROM scratchpad WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
      const audit_old = db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')").run();
      try { cleanupOldUsage.run(180); } catch {}
      return ((forgotten as any).changes || 0) + ((links as any).changes || 0) +
        ((scratch as any).changes || 0) + ((audit_old as any).changes || 0);
    });
    const total = gcTransaction();
    if (total > 0) {
      refreshEmbeddingCache();
      log.info({ msg: "gc_completed", deleted: total });
    }
  } catch (e: any) {
    log.error({ msg: "gc_error", error: e.message });
  }
}), 60 * 60 * 1000);

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

log.info({ msg: "server_started", version: PKG_VERSION, host: HOST, port: PORT, open_access: OPEN_ACCESS, cors: CORS_ORIGIN, log_level: process.env.ENGRAM_LOG_LEVEL || "info", allowed_ips: ALLOWED_IPS.length || "any" });
