// ============================================================================
// HEALTH DOMAIN - Route handlers (no auth required)
// ============================================================================

import type { Router } from "../router/types.ts";
import { json } from "../helpers/index.ts";
import { db } from "../db/connection.ts";
import { statSync } from "fs";
import { getAuthOrDefault, isAuthError, type AuthError } from "../auth/index.ts";
import { getClientIp } from "../middleware/auth.ts";
import { log, opsCounters } from "../config/logger.ts";
import { PKG_VERSION, DB_PATH, EMBEDDING_MODEL, EMBEDDING_PROVIDER, EMBEDDING_DIM, RERANKER_ENABLED, maintenanceMode, maintenanceReason } from "../config/index.ts";
import { isEmbedderReady, getEmbeddingCacheStats } from "../embeddings/index.ts";
import { isLocalModelAvailable, localModelStats } from "../llm/local.ts";
import { getJobStats } from "../jobs/index.ts";
import { countNoEmbedding, countNoEmbeddingForUser } from "../db/index.ts";
import { getOpenAPISpec } from "../openapi.ts";
import { isRerankerReady } from "../reranker/index.ts";
import { guiAuthed } from "../gui/index.ts";
import { securityHeaders } from "../helpers/index.ts";

export function registerHealthRoutes(router: Router): void {

  // GET /live - liveness probe (no auth required)
  router.get("/live", async (_req) => {
    return json({ status: "ok" });
  });

  // GET /ready - readiness probe: DB writable, embedding model loaded, LLM reachable
  router.get("/ready", async (_req) => {
    const checks: Record<string, boolean> = {};
    try { db.prepare("SELECT 1").get(); checks.db = true; } catch { checks.db = false; }
    try { checks.embeddings = isEmbedderReady(); } catch { checks.embeddings = false; }
    checks.llm = isLocalModelAvailable();
    const ready = checks.db && checks.embeddings;
    return json({ status: ready ? "ready" : "degraded", checks }, ready ? 200 : 503);
  });

  // GET /health - full health check (optional auth: unauthenticated gets minimal response)
  router.get("/health", async (req) => {
    log.debug({ msg: "req", method: "GET", path: "/health", status: 200, ip: getClientIp(req) });
    const healthAuth = getAuthOrDefault(req, guiAuthed);
    if (isAuthError(healthAuth)) {
      return json({ error: (healthAuth as AuthError).error }, (healthAuth as AuthError).status, {
        ...((healthAuth as AuthError).headers || {}),
      });
    }
    const isAuthed = !!healthAuth;
    if (!isAuthed) {
      return json({ status: "ok", version: PKG_VERSION });
    }
    // Full health for authenticated users - tenant-scoped for non-admins
    const uid = healthAuth.user_id;
    const isAdmin = healthAuth.is_admin;
    const memWhere = isAdmin ? "" : " AND user_id = ?";
    const memParams = isAdmin ? [] : [uid];
    const ownedWhere = isAdmin ? "" : " WHERE user_id = ?";
    const ownedParams = isAdmin ? [] : [uid];
    const convCount = db.prepare(`SELECT COUNT(*) as count FROM conversations${ownedWhere}`).get(...ownedParams) as { count: number };
    const msgCount = isAdmin
      ? db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number }
      : db.prepare("SELECT COUNT(*) as count FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)").get(uid) as { count: number };
    const linkCount = isAdmin
      ? db.prepare("SELECT COUNT(*) as count FROM memory_links").get() as { count: number }
      : db.prepare("SELECT COUNT(*) as count FROM memory_links WHERE source_id IN (SELECT id FROM memories WHERE user_id = ?)").get(uid) as { count: number };
    const embCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL${memWhere}`).get(...memParams) as { count: number };
    const noEmbCount2 = isAdmin
      ? (countNoEmbedding.get() as { count: number }).count
      : (countNoEmbeddingForUser.get(uid) as { count: number }).count;
    const forgottenCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE is_forgotten = 1${memWhere}`).get(...memParams) as { count: number };
    const staticCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE is_static = 1 AND is_forgotten = 0${memWhere}`).get(...memParams) as { count: number };
    const versionedCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE version > 1${memWhere}`).get(...memParams) as { count: number };
    const archivedCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE is_archived = 1 AND is_forgotten = 0${memWhere}`).get(...memParams) as { count: number };
    const pendingCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE status = 'pending' AND is_forgotten = 0${memWhere}`).get(...memParams) as { count: number };
    const rejectedCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE status = 'rejected'${memWhere}`).get(...memParams) as { count: number };
    const episodeCount = db.prepare(`SELECT COUNT(*) as count FROM episodes${ownedWhere}`).get(...ownedParams) as { count: number };
    const consolidationCount = db.prepare(`SELECT COUNT(*) as count FROM consolidations${ownedWhere}`).get(...ownedParams) as { count: number };
    const taggedCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE tags IS NOT NULL AND is_forgotten = 0${memWhere}`).get(...memParams) as { count: number };
    const entityCount = db.prepare(`SELECT COUNT(*) as count FROM entities${ownedWhere}`).get(...ownedParams) as { count: number };
    const projectCount = db.prepare(`SELECT COUNT(*) as count FROM projects${ownedWhere}`).get(...ownedParams) as { count: number };
    const agentCount = db.prepare(`SELECT COUNT(*) as count FROM agents WHERE is_active = 1${isAdmin ? "" : " AND user_id = ?"}`).get(...(isAdmin ? [] : [uid])) as { count: number };
    const scopedMemCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE 1=1${memWhere}`).get(...memParams) as { count: number };
    const dbSize = statSync(DB_PATH).size;
    return json({
      status: "ok",
      version: PKG_VERSION,
      memories: scopedMemCount.count,
      embedded: embCount.count,
      unembedded: noEmbCount2,
      links: linkCount.count,
      forgotten: forgottenCount.count,
      archived: archivedCount.count,
      pending: pendingCount.count,
      rejected: rejectedCount.count,
      static: staticCount.count,
      versioned: versionedCount.count,
      tagged: taggedCount.count,
      episodes: episodeCount.count,
      consolidations: consolidationCount.count,
      entities: entityCount.count,
      projects: projectCount.count,
      agents: agentCount.count,
      conversations: convCount.count,
      messages: msgCount.count,
      embedding_model: EMBEDDING_MODEL,
      embedding_provider: EMBEDDING_PROVIDER,
      embedding_dim: EMBEDDING_DIM,
      llm: isLocalModelAvailable() ? "local" : "down",
      llm_configured: isLocalModelAvailable(),
      features: {
        decay: "fsrs6",
        fsrs6: true,
        dual_strength: true,
        tags: true,
        episodes: true,
        consolidation: isLocalModelAvailable(),
        typed_relationships: true,
        access_tracking: true,
        confidence: true,
        webhooks: true,
        sync: true,
        pack: true,
        prompt_templates: true,
        auto_tagging: isLocalModelAvailable(),
        mem0_import: true,
        supermemory_import: true,
        entities: true,
        projects: true,
        scoped_search: true,
        reranker: RERANKER_ENABLED && isLocalModelAvailable(),
        cross_encoder: isRerankerReady(),
        conversation_extraction: isLocalModelAvailable(),
        derived_memories: isLocalModelAvailable(),
        graph: true,
        url_ingest: true,
        contradiction_detection: true,
        contradiction_resolution: isLocalModelAvailable(),
        time_travel: true,
        smart_context: true,
        reflections: isLocalModelAvailable(),
        scheduled_digests: true,
        agent_identity: true,
        trust_scoring: true,
        execution_signing: true,
      },
      warnings: (() => {
        const w: string[] = [];
        try {
          const sample = db.prepare("SELECT embedding FROM memories WHERE embedding IS NOT NULL LIMIT 1").get() as any;
          if (sample?.embedding) {
            const buf = sample.embedding instanceof ArrayBuffer ? sample.embedding
              : sample.embedding.buffer.slice(sample.embedding.byteOffset, sample.embedding.byteOffset + sample.embedding.byteLength);
            const storedDim = buf.byteLength / 4;
            if (storedDim !== EMBEDDING_DIM) {
              w.push(`Stored embeddings are ${storedDim}-dim but configured provider (${EMBEDDING_PROVIDER}) uses ${EMBEDDING_DIM}-dim. Run POST /admin/reembed to fix.`);
            }
          }
        } catch {}
        if (opsCounters.vec_write_failures > 0) w.push(`${opsCounters.vec_write_failures} vector column write failures since startup`);
        if (opsCounters.extraction_failures > 0) w.push(`${opsCounters.extraction_failures} LLM extraction failures since startup`);
        if (opsCounters.fts_rebuild_failures > 0) w.push(`${opsCounters.fts_rebuild_failures} FTS rebuild failures since startup`);
        const cacheStats = getEmbeddingCacheStats();
        if (cacheStats.total > 50000) {
          w.push(`Embedding cache contains ${cacheStats.total} vectors (${cacheStats.size_mb}MB). Linear scan will degrade. Enable tiered search (Phase 8.2) or external vector DB.`);
        } else if (cacheStats.total > 10000) {
          w.push(`Embedding cache: ${cacheStats.total} vectors (${cacheStats.size_mb}MB). Approaching linear scan limits. Monitor search latency via /metrics.`);
        }
        if (cacheStats.avg_search_ms > 200) {
          w.push(`Average search latency is ${cacheStats.avg_search_ms}ms. Consider enabling ANN index or reducing candidate pool.`);
        }
        return w.length > 0 ? w : undefined;
      })(),
      embedding_cache: getEmbeddingCacheStats(),
      ...(maintenanceMode ? { maintenance: { active: true, reason: maintenanceReason } } : {}),
      ops_counters: isAdmin ? opsCounters : undefined,
      ...(isAdmin ? { db_size_mb: Math.round(dbSize / 1048576 * 100) / 100 } : {}),
    });
  });

  // GET /metrics - prometheus-format metrics (no auth required)
  router.get("/metrics", async (_req) => {
    const stats = getJobStats();
    const memCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE is_forgotten = 0").get() as any;
    const embCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL AND is_forgotten = 0").get() as any;
    const dbSize = statSync(DB_PATH).size;
    const cacheStats = getEmbeddingCacheStats();

    const searchP200 = opsCounters.sla_search_total > 0
      ? Math.round(opsCounters.sla_search_under_200ms / opsCounters.sla_search_total * 10000) / 100
      : 100;
    const errorRate = opsCounters.request_count > 0
      ? Math.round(opsCounters.sla_errors_5xx / opsCounters.request_count * 10000) / 100
      : 0;

    const lines: string[] = [
      "# HELP engram_memories_total Total non-forgotten memories",
      "# TYPE engram_memories_total gauge",
      `engram_memories_total ${memCount.c}`,
      "",
      "# HELP engram_embedded_total Memories with embeddings",
      "# TYPE engram_embedded_total gauge",
      `engram_embedded_total ${embCount.c}`,
      "",
      "# HELP engram_db_size_bytes Database file size",
      "# TYPE engram_db_size_bytes gauge",
      `engram_db_size_bytes ${dbSize}`,
      "",
      "# HELP engram_jobs_total Jobs by status",
      "# TYPE engram_jobs_total gauge",
      `engram_jobs_total{status="pending"} ${stats.pending || 0}`,
      `engram_jobs_total{status="running"} ${stats.running || 0}`,
      `engram_jobs_total{status="completed"} ${stats.completed || 0}`,
      `engram_jobs_total{status="failed"} ${stats.failed || 0}`,
      "",
      "# HELP engram_requests_total Total HTTP requests",
      "# TYPE engram_requests_total counter",
      `engram_requests_total ${opsCounters.request_count}`,
      "",
      "# HELP engram_request_errors_total Total HTTP 5xx errors",
      "# TYPE engram_request_errors_total counter",
      `engram_request_errors_total ${opsCounters.request_errors}`,
      "",
      "# HELP engram_embedding_latency_avg_ms Average embedding latency",
      "# TYPE engram_embedding_latency_avg_ms gauge",
      `engram_embedding_latency_avg_ms ${opsCounters.embedding_count > 0 ? (opsCounters.embedding_latency_sum_ms / opsCounters.embedding_count).toFixed(1) : 0}`,
      "",
      "# HELP engram_search_latency_avg_ms Average search latency",
      "# TYPE engram_search_latency_avg_ms gauge",
      `engram_search_latency_avg_ms ${opsCounters.search_count > 0 ? (opsCounters.search_latency_sum_ms / opsCounters.search_count).toFixed(1) : 0}`,
      "",
      "# HELP engram_db_lock_waits_total Write lock contention events",
      "# TYPE engram_db_lock_waits_total counter",
      `engram_db_lock_waits_total ${opsCounters.db_lock_waits || 0}`,
      "",
      "# HELP engram_db_lock_timeouts_total SQLite BUSY timeout events",
      "# TYPE engram_db_lock_timeouts_total counter",
      `engram_db_lock_timeouts_total ${opsCounters.db_lock_timeouts || 0}`,
      "",
      "# HELP engram_uptime_seconds Server uptime",
      "# TYPE engram_uptime_seconds gauge",
      `engram_uptime_seconds ${Math.floor(process.uptime())}`,
      "",
      "# HELP engram_embedding_cache_count Vectors in embedding cache",
      "# TYPE engram_embedding_cache_count gauge",
      `engram_embedding_cache_count ${cacheStats.total}`,
      "",
      "# HELP engram_embedding_cache_bytes Embedding cache memory usage",
      "# TYPE engram_embedding_cache_bytes gauge",
      `engram_embedding_cache_bytes ${cacheStats.total * EMBEDDING_DIM * 4}`,
      "",
      "# HELP engram_search_p50_ms Estimated search latency (average as proxy)",
      "# TYPE engram_search_p50_ms gauge",
      `engram_search_p50_ms ${cacheStats.avg_search_ms}`,
      "",
      "# HELP engram_sla_search_p200_pct Percentage of searches under 200ms",
      "# TYPE engram_sla_search_p200_pct gauge",
      `engram_sla_search_p200_pct ${searchP200}`,
      "",
      "# HELP engram_sla_error_rate_pct 5xx error rate percentage",
      "# TYPE engram_sla_error_rate_pct gauge",
      `engram_sla_error_rate_pct ${errorRate}`,
      "",
    ];

    return new Response(lines.join("\n") + "\n", {
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  });

  // GET /openapi.json - OpenAPI spec
  router.get("/openapi.json", async (_req) => {
    return new Response(JSON.stringify(getOpenAPISpec(), null, 2), {
      headers: securityHeaders({ "Content-Type": "application/json" }),
    });
  });

  // GET /api/examples - API usage examples
  router.get("/api/examples", async (_req) => {
    return json({
      description: "Example request/response pairs for Engram API endpoints",
      examples: {
        "POST /store": {
          request: {
            content: "TypeScript is our primary language for all Syntheos products",
            category: "decision",
            source: "claude-code",
            importance: 8,
            tags: ["tech-stack", "typescript"],
          },
          response: {
            id: 1234,
            created_at: "2026-03-21T12:00:00Z",
            job_id: 567,
          },
        },
        "POST /search": {
          request: {
            query: "What programming language do we use?",
            limit: 5,
          },
          response: {
            results: [{
              id: 1234,
              content: "TypeScript is our primary language for all Syntheos products",
              category: "decision",
              source: "claude-code",
              importance: 8,
              score: 0.89,
              semantic_score: 0.92,
              fts_score: 0.85,
              created_at: "2026-03-21T12:00:00Z",
              tags: ["tech-stack", "typescript"],
            }],
            count: 1,
            question_type: "fact_recall",
            reranked: true,
          },
        },
        "POST /recall": {
          request: { query: "our tech stack", budget: 2000 },
          response: {
            context: "Based on 3 memories:\n- TypeScript is our primary language...",
            memories_used: 3,
            tokens_used: 450,
            budget: 2000,
          },
        },
        "POST /conversations": {
          request: {
            agent: "claude-code",
            title: "Debugging session",
            messages: [
              { role: "user", content: "Why is the build failing?" },
              { role: "assistant", content: "The TypeScript compiler found 3 errors..." },
            ],
          },
          response: {
            id: 89,
            agent: "claude-code",
            title: "Debugging session",
            started_at: "2026-03-21T12:00:00Z",
          },
        },
        "Authorization": {
          header: "Authorization: Bearer eg_a1b2c3d4e5f6...",
          note: "Get your key from POST /bootstrap (first setup) or POST /keys (admin creates more)",
        },
      },
    });
  });
}
