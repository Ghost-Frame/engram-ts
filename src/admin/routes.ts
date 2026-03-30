// ============================================================================
// ADMIN DOMAIN -- Route handlers
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { db } from "../db/connection.ts";
import { audit } from "../db/index.ts";
import { log, opsCounters } from "../config/logger.ts";
import { statSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import {
  DATA_DIR, DB_PATH, OPEN_ACCESS, DEFAULT_RATE_LIMIT,
  COLD_STORAGE_DAYS, COLD_STORAGE_MIN_MEMORIES,
  ANN_PREFILTER_THRESHOLD, ANN_CANDIDATE_MULTIPLIER,
  LLM_PROVIDERS, LLM_STRATEGY,
  maintenanceMode, maintenanceReason, setMaintenanceMode,
} from "../config/index.ts";
import { generateApiKey } from "../auth/index.ts";
import { isProviderAvailable } from "../llm/index.ts";
import { EMBEDDING_PROVIDER, EMBEDDING_MODEL, EMBEDDING_DIM, RERANKER_ENABLED, RERANKER_TOP_K } from "../config/index.ts";
import { isRerankerReady } from "../reranker/index.ts";
import { refreshEmbeddingCache, getEmbeddingCacheStats, invalidateEmbeddingCache } from "../embeddings/index.ts";
import { getQuota, upsertQuota, getUsageSummary, getUsageTimeline, cleanupOldUsage } from "../db/index.ts";
import { getSchemaSnapshot, getSchemaVersion, detectSchemaDrift } from "../db/index.ts";
import { securityHeaders } from "../helpers/index.ts";
import {
  runReembed, runBackfillFacts, runRebuildCooccurrences, runDetectCommunities,
  runRebuildFts, runCompact, runGc,
} from "./operations.ts";
import {
  buildAuditQuery, countAuditLog, walCheckpoint,
  integrityCheck, foreignKeyCheck, walCheckpointPassive, countAllMemories, countAllTables,
  tenantsQuery, allQuotas, adminUsageByUser, adminUsageTotals,
  countTotalNonForgotten, countWithEmbedding, coldStorageDistribution,
  schemaIndexes, getSchemaMigrations,
  exportMemories, exportMemoriesWithSpace, exportLinks,
  stateByKey, stateAll, deleteStateByKey, deleteStateAll,
  insertUser, insertDefaultSpace, selectUser, deleteUser,
  countUserMemories, countUserConversations, deleteUserMemories,
} from "./db.ts";

export function registerAdminRoutes(router: Router): void {

  // ==========================================================================
  // RE-EMBED -- re-embed all memories with current provider
  // ==========================================================================

  router.post("/admin/reembed", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
    try {
      const result = await runReembed(auth.user_id);
      return json(result);
    } catch (e: any) {
      return safeError("Re-embed", e);
    }
  });

  // ==========================================================================
  // EMBEDDING INFO -- current embedding configuration
  // ==========================================================================

  router.get("/admin/embedding-info", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
    try {
      const { getEmbeddingProviderInfo } = await import("../embeddings/index.ts");
      return json(getEmbeddingProviderInfo());
    } catch (e: any) {
      return safeError("Embedding info", e);
    }
  });

  // ==========================================================================
  // BACKFILL FACTS -- populate valid_at for existing facts
  // ==========================================================================

  router.post("/admin/backfill-facts", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
    try {
      const result = await runBackfillFacts(auth.user_id);
      return json(result);
    } catch (e: any) {
      return safeError("Fact backfill", e);
    }
  });

  // ==========================================================================
  // REBUILD COOCCURRENCES -- rebuild entity cooccurrence graph
  // ==========================================================================

  router.post("/admin/rebuild-cooccurrences", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
    try {
      const result = await runRebuildCooccurrences(auth.user_id);
      return json(result);
    } catch (e: any) {
      return safeError("Cooccurrence rebuild", e);
    }
  });

  // ==========================================================================
  // DETECT COMMUNITIES -- Louvain community detection
  // ==========================================================================

  router.post("/admin/detect-communities", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
    try {
      const result = await runDetectCommunities(auth.user_id);
      return json(result);
    } catch (e: any) {
      return safeError("Community detection", e);
    }
  });

  // ==========================================================================
  // REBUILD FTS -- drop and rebuild full-text search index
  // ==========================================================================

  router.post("/admin/rebuild-fts", async (req) => {
    const { auth, clientIp, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    try {
      const result = runRebuildFts();
      audit(auth.user_id, "admin.rebuild_fts", null, null, `${result.rows} rows in ${result.elapsed_ms}ms`, clientIp, requestId);
      return json(result);
    } catch (e: any) {
      return safeError("Rebuild FTS", e, 500, requestId);
    }
  });

  // ==========================================================================
  // REFRESH CACHE -- force reload embedding cache from DB
  // ==========================================================================

  router.post("/admin/refresh-cache", async (req) => {
    const { auth, clientIp, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const startMs = performance.now();
    refreshEmbeddingCache();
    const stats = getEmbeddingCacheStats();
    const elapsedMs = Math.round(performance.now() - startMs);
    audit(auth.user_id, "admin.refresh_cache", null, null, `${stats.total} vectors in ${elapsedMs}ms`, clientIp, requestId);
    return json({ refreshed: true, ...stats, elapsed_ms: elapsedMs });
  });

  // ==========================================================================
  // COMPACT -- VACUUM + ANALYZE the database
  // ==========================================================================

  router.post("/admin/compact", async (req) => {
    const { auth, clientIp, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    try {
      const result = runCompact();
      audit(auth.user_id, "admin.compact", null, null,
        `before=${result.before_size_mb}MB after=${result.after_size_mb}MB saved=${result.saved_mb}MB ms=${result.elapsed_ms}`,
        clientIp, requestId);
      return json(result);
    } catch (e: any) {
      return safeError("Compact", e, 500, requestId);
    }
  });

  // ==========================================================================
  // MAINTENANCE -- toggle maintenance mode
  // ==========================================================================

  router.post("/admin/maintenance", async (req) => {
    const { auth, body, clientIp, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const b = body as any;
    const enabled = !!b?.enabled;
    const reason = String(b?.reason || "").trim();
    setMaintenanceMode(enabled, reason);
    audit(auth.user_id, enabled ? "maintenance.start" : "maintenance.end", null, null, reason, clientIp, requestId);
    log.info({ msg: enabled ? "maintenance_mode_on" : "maintenance_mode_off", reason });
    return json({ maintenance: enabled, reason });
  });

  router.get("/admin/maintenance", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    return json({ maintenance: maintenanceMode, reason: maintenanceReason });
  });

  // ==========================================================================
  // SCALE REPORT -- scale tier assessment with recommendations
  // ==========================================================================

  router.get("/admin/scale-report", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const cacheStats = getEmbeddingCacheStats();
    const total = (countTotalNonForgotten.get() as any).c;
    const tier = total < 1000 ? "micro" : total < 10000 ? "small" : total < 50000 ? "medium" : total < 200000 ? "large" : "xlarge";
    const recommendations: string[] = [];
    if (total > 50000 && COLD_STORAGE_DAYS === 0) {
      recommendations.push("Enable cold storage: set ENGRAM_COLD_STORAGE_DAYS=180 to exclude rarely-accessed memories from hot cache");
    }
    if (cacheStats.avg_search_ms > 100) {
      recommendations.push(`Average search latency is ${cacheStats.avg_search_ms}ms. Consider enabling ANN index via ENGRAM_ANN_THRESHOLD.`);
    }
    if (total > 10000 && cacheStats.cold_count === 0) {
      recommendations.push("Consider enabling cold storage to reduce embedding cache memory usage");
    }
    return json({
      tier,
      total_memories: total,
      embedding_cache: cacheStats,
      ann_prefilter: {
        enabled: total >= ANN_PREFILTER_THRESHOLD,
        threshold: ANN_PREFILTER_THRESHOLD,
        candidate_multiplier: ANN_CANDIDATE_MULTIPLIER,
      },
      cold_storage: {
        enabled: COLD_STORAGE_DAYS > 0,
        days: COLD_STORAGE_DAYS,
        min_memories: COLD_STORAGE_MIN_MEMORIES,
        active: COLD_STORAGE_DAYS > 0 && total >= COLD_STORAGE_MIN_MEMORIES,
      },
      recommendations,
    });
  });

  // ==========================================================================
  // COLD STORAGE -- memory access distribution and cold storage config
  // ==========================================================================

  router.get("/admin/cold-storage", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const total = countTotalNonForgotten.get() as any;
    const withEmbedding = countWithEmbedding.get() as any;
    const distribution = coldStorageDistribution.all() as any[];
    const cacheStats = getEmbeddingCacheStats();
    return json({
      config: {
        cold_storage_days: COLD_STORAGE_DAYS,
        cold_min_memories: COLD_STORAGE_MIN_MEMORIES,
        enabled: COLD_STORAGE_DAYS > 0 && total.c >= COLD_STORAGE_MIN_MEMORIES,
      },
      totals: {
        all_memories: total.c,
        with_embedding: withEmbedding.c,
        in_hot_cache: cacheStats.total,
        in_cold_storage: cacheStats.cold_count,
      },
      distribution,
      recommendation: total.c > 10000 && COLD_STORAGE_DAYS === 0
        ? "Consider setting ENGRAM_COLD_STORAGE_DAYS=180 to reduce cache size by ~" +
          Math.round(((distribution.find((d: any) => d.tier.includes("90d"))?.count) || 0) / total.c * 100) + "%"
        : null,
    });
  });

  // ==========================================================================
  // GC -- garbage collection
  // ==========================================================================

  router.post("/admin/gc", async (req) => {
    const { auth, body, clientIp, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const b = body as any;
    const dryRun = b?.dry_run !== false;
    const result = runGc(dryRun);
    if (!dryRun) {
      audit(auth.user_id, "admin.gc", null, null, `deleted=${result.reclaimable_rows}`, clientIp, requestId);
    }
    return json(result);
  });

  // ==========================================================================
  // SCHEMA -- schema snapshot and drift detection
  // ==========================================================================

  router.get("/admin/schema", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const snapshot = getSchemaSnapshot();
    const drift = detectSchemaDrift();
    const version = getSchemaVersion();
    const indexes = schemaIndexes.all();
    const migrations = getSchemaMigrations();
    return json({
      schema_version: version,
      tables: Object.keys(snapshot).length,
      indexes: (indexes as any[]).length,
      drift: {
        has_drift: drift.missing.length > 0 || drift.extra.length > 0,
        missing_tables: drift.missing,
        unexpected_tables: drift.extra,
      },
      table_details: snapshot,
      migrations,
    });
  });

  // ==========================================================================
  // SLA -- SLA metrics and targets
  // ==========================================================================

  router.get("/admin/sla", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const uptimeMs = Date.now() - opsCounters.sla_period_start;
    const uptimeHours = Math.round(uptimeMs / 3600000 * 10) / 10;
    const searchP200 = opsCounters.sla_search_total > 0
      ? Math.round(opsCounters.sla_search_under_200ms / opsCounters.sla_search_total * 10000) / 100
      : 100;
    const storeP500 = opsCounters.sla_store_total > 0
      ? Math.round(opsCounters.sla_store_under_500ms / opsCounters.sla_store_total * 10000) / 100
      : 100;
    const errorRate = opsCounters.request_count > 0
      ? Math.round(opsCounters.sla_errors_5xx / opsCounters.request_count * 10000) / 100
      : 0;
    return json({
      period: { start: new Date(opsCounters.sla_period_start).toISOString(), duration_hours: uptimeHours },
      targets: {
        search_p95_under_200ms: { target: 95, actual: searchP200, met: searchP200 >= 95 },
        store_p95_under_500ms: { target: 95, actual: storeP500, met: storeP500 >= 95 },
        error_rate_under_1pct: { target: 1, actual: errorRate, met: errorRate < 1 },
      },
      raw: {
        total_requests: opsCounters.request_count,
        total_errors_5xx: opsCounters.sla_errors_5xx,
        search_total: opsCounters.sla_search_total,
        search_under_200ms: opsCounters.sla_search_under_200ms,
        store_total: opsCounters.sla_store_total,
        store_under_500ms: opsCounters.sla_store_under_500ms,
      },
      overall_health: searchP200 >= 95 && storeP500 >= 95 && errorRate < 1 ? "healthy" : "degraded",
    });
  });

  router.post("/admin/sla/reset", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    opsCounters.sla_search_under_200ms = 0;
    opsCounters.sla_search_total = 0;
    opsCounters.sla_store_under_500ms = 0;
    opsCounters.sla_store_total = 0;
    opsCounters.sla_errors_5xx = 0;
    opsCounters.sla_period_start = Date.now();
    return json({ reset: true, new_period_start: new Date().toISOString() });
  });

  // ==========================================================================
  // USAGE -- admin-wide usage metrics
  // ==========================================================================

  router.get("/admin/usage", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const url = new URL(req.url);
    const since = url.searchParams.get("since") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const byUser = adminUsageByUser.all(since);
    const totals = adminUsageTotals.all(since);
    return json({ period_start: since, totals, by_user: byUser });
  });

  // ==========================================================================
  // QUOTAS -- tenant quota management
  // ==========================================================================

  router.get("/admin/quotas", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const url = new URL(req.url);
    const userId = Number(url.searchParams.get("user_id"));
    if (userId) {
      const quota = getQuota.get(userId);
      return json({ quota: quota || null });
    }
    const all = allQuotas.all();
    return json({ quotas: all });
  });

  router.put("/admin/quotas", async (req) => {
    const { auth, body, clientIp, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const b = body as any;
    const userId = Number(b?.user_id);
    if (!userId) return errorResponse("user_id is required", 400, requestId);
    upsertQuota.run(
      userId,
      b.max_memories ?? 10000,
      b.max_conversations ?? 1000,
      b.max_api_keys ?? 10,
      b.max_spaces ?? 5,
      b.max_memory_size_bytes ?? 102400,
      b.rate_limit_override ?? null,
    );
    audit(auth.user_id, "quota.update", "user", userId, JSON.stringify(b), clientIp, requestId);
    return json({ updated: true, user_id: userId });
  });

  // ==========================================================================
  // TENANTS -- list all tenants with usage statistics
  // ==========================================================================

  router.get("/admin/tenants", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const tenants = tenantsQuery.all();
    return json({ tenants });
  });

  // ==========================================================================
  // PROVIDERS -- LLM/embedding provider configuration
  // ==========================================================================

  router.get("/admin/providers", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const providers = LLM_PROVIDERS.map((p, i) => ({
      index: i,
      name: p.name,
      model: p.model,
      url: p.url.replace(/\/\/.*@/, "//***@"),
      has_key: !!p.key,
      available: isProviderAvailable(p),
    }));
    return json({
      embedding: { provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL, dimension: EMBEDDING_DIM },
      llm_providers: providers,
      llm_strategy: LLM_STRATEGY,
      reranker: { enabled: RERANKER_ENABLED, cross_encoder: isRerankerReady(), top_k: RERANKER_TOP_K },
    });
  });

  // ==========================================================================
  // TENANT PROVISION / DEPROVISION
  // ==========================================================================

  router.post("/tenants/provision", async (req) => {
    const { auth, body, clientIp, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const b = body as any;
    const { username, email, role } = b || {};
    if (!username) return errorResponse("username is required", 400, requestId);
    try {
      const userResult = insertUser.get(
        username, email || null, role || "writer", role === "admin" ? 1 : 0
      ) as any;
      const userId = userResult.id;
      insertDefaultSpace.run(userId, "default", "Default memory space");
      const { key, prefix, hash } = generateApiKey();
      const keyResult = db.prepare(
        "INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
      ).get(userId, prefix, hash, "initial", role === "admin" ? "read,write,admin" : "read,write", DEFAULT_RATE_LIMIT) as any;
      audit(auth.user_id, "tenant.provision", "user", userId, `key_id=${keyResult.id}`, clientIp, requestId);
      return json({ user_id: userId, username, api_key: key, api_key_id: keyResult.id, space: "default" }, 201);
    } catch (e: any) {
      if (String(e).includes("UNIQUE constraint")) {
        return errorResponse(`Username '${username}' already exists`, 409, requestId);
      }
      return safeError("Tenant provision", e, 500, requestId);
    }
  });

  router.post("/tenants/deprovision", async (req) => {
    const { auth, body, clientIp, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const b = body as any;
    const userId = Number(b?.user_id);
    const confirm = b?.confirm;
    if (!userId) return errorResponse("user_id is required", 400, requestId);
    if (userId === 1) return errorResponse("Cannot deprovision the primary user", 400, requestId);
    if (confirm !== `delete-user-${userId}`) {
      return errorResponse(`Set confirm to 'delete-user-${userId}' to proceed`, 400, requestId);
    }
    const user = selectUser.get(userId) as any;
    if (!user) return errorResponse("User not found", 404, requestId);
    const memCount = countUserMemories.get(userId) as any;
    const convCount = countUserConversations.get(userId) as any;
    const tables = [
      "scratchpad", "personality_signals", "personality_profiles",
      "structured_facts", "memory_entities", "memory_links", "memory_projects",
      "consolidations", "reflections", "temporal_patterns", "reconsolidations",
      "causal_links", "causal_chains", "current_state", "user_preferences",
      "webhooks", "digests", "episodes", "messages", "conversations",
      "entity_relationships", "entity_cooccurrences", "entities",
      "projects", "spaces", "api_keys", "agents",
    ];
    let totalDeleted = 0;
    for (const table of tables) {
      try {
        const result = db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
        totalDeleted += (result as any).changes || 0;
      } catch {}
    }
    const memResult = deleteUserMemories.run(userId);
    totalDeleted += (memResult as any).changes || 0;
    deleteUser.run(userId);
    refreshEmbeddingCache();
    audit(auth.user_id, "tenant.deprovision", "user", userId,
      `memories=${memCount.c} conversations=${convCount.c} total_rows=${totalDeleted}`,
      clientIp, requestId);
    return json({ deprovisioned: true, user_id: userId, username: user.username, rows_deleted: totalDeleted });
  });

  // ==========================================================================
  // WAL CHECKPOINT
  // ==========================================================================

  router.post("/checkpoint", async (req) => {
    const { auth, clientIp, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const result = walCheckpoint.get() as any;
    audit(auth.user_id, "checkpoint", null, null, JSON.stringify(result), clientIp, requestId);
    log.info({ msg: "wal_checkpoint_manual", result, rid: requestId });
    return json({ checkpointed: true, ...result }, 200, { "X-Request-Id": requestId });
  });

  // ==========================================================================
  // BACKUP -- download SQLite DB (consistent snapshot)
  // ==========================================================================

  router.get("/backup", async (req) => {
    const { auth, clientIp, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    try {
      const backupPath = resolve(DATA_DIR, `backup-${Date.now()}.db`);
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      const fileStat = statSync(backupPath);
      const fileBuffer = readFileSync(backupPath);
      try { unlinkSync(backupPath); } catch {}
      audit(auth.user_id, "backup", null, null, `${fileStat.size} bytes`, clientIp, requestId);
      log.info({ msg: "backup_created", size: fileStat.size, method: "VACUUM_INTO", rid: requestId });
      return new Response(fileBuffer, {
        headers: securityHeaders({
          "Content-Type": "application/x-sqlite3",
          "Content-Disposition": `attachment; filename="engram-${new Date().toISOString().slice(0, 10)}.db"`,
        }),
      });
    } catch (e: any) {
      return safeError("Backup", e, 500, requestId);
    }
  });

  // ==========================================================================
  // BACKUP VERIFY -- run integrity checks on live database
  // ==========================================================================

  router.post("/backup/verify", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    try {
      const integrity = integrityCheck.get() as any;
      const fkCheck = foreignKeyCheck.all();
      const walPages = walCheckpointPassive.get() as any;
      const memCount = countAllMemories.get() as { count: number };
      const tableCount = countAllTables.get() as { count: number };
      return json({
        integrity: integrity?.integrity_check || "unknown",
        foreign_key_violations: fkCheck.length,
        foreign_key_details: fkCheck.length > 0 ? fkCheck.slice(0, 10) : undefined,
        wal_pages: walPages,
        memories: memCount.count,
        tables: tableCount.count,
        db_size_mb: Math.round(statSync(DB_PATH).size / 1048576 * 100) / 100,
      });
    } catch (e: any) {
      return safeError("Backup verify", e, 500, requestId);
    }
  });

  // ==========================================================================
  // EXPORT -- download all memories as JSON or JSONL
  // ==========================================================================

  router.get("/export", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "read")) return errorResponse("Read scope required", 403);
    const url = new URL(req.url);
    const format = url.searchParams.get("format") || "json";

    const mems = auth.space_id
      ? exportMemoriesWithSpace.all(auth.user_id, auth.space_id)
      : exportMemories.all(auth.user_id);
    const memLinks = exportLinks.all(auth.user_id);

    if (format === "jsonl") {
      const lines = (mems as any[]).map(m => JSON.stringify(m)).join("\n");
      return new Response(lines, {
        headers: securityHeaders({
          "Content-Type": "application/x-ndjson",
          "Content-Disposition": "attachment; filename=engram-export.jsonl",
        }),
      });
    }

    const exportData = {
      version: "engram-v5.9",
      exported_at: new Date().toISOString(),
      memories: mems,
      links: memLinks,
      stats: { memory_count: (mems as any[]).length, link_count: (memLinks as any[]).length },
    };

    try {
      const { recordUsage } = await import("../db/index.ts");
      recordUsage.run(auth.user_id, "export.download", 1, JSON.stringify({ memories: (mems as any[]).length }));
    } catch {}

    return new Response(JSON.stringify(exportData, null, 2), {
      headers: securityHeaders({
        "Content-Type": "application/json",
        "Content-Disposition": "attachment; filename=engram-export.json",
      }),
    });
  });

  // ==========================================================================
  // IMPORT -- bulk import memories
  // ==========================================================================

  router.post("/import", async (req) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const b = body as any;
      const items = b?.memories || b?.items || b;
      if (!Array.isArray(items)) return errorResponse("Expected memories array");
      if (items.length > 1000) return errorResponse("Import batch too large (max 1000 items per request)", 400);

      let imported = 0, failed = 0;
      const importedIds: number[] = [];

      const importTransaction = db.transaction(() => {
        for (const item of items) {
          try {
            if (!item.content || typeof item.content !== "string") { failed++; continue; }
            const row = db.prepare(
              `INSERT INTO memories (content, category, source, importance, user_id, space_id,
                 is_static, version, source_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
               RETURNING id`
            ).get(
              item.content.trim(),
              item.category || "general",
              item.source || "import",
              Math.max(1, Math.min(10, Number(item.importance) || 5)),
              auth.user_id,
              auth.space_id || null,
              item.is_static ? 1 : 0,
              item.version || 1,
              item.source_count || 1,
              item.created_at || null,
              item.updated_at || null,
            ) as { id: number };
            importedIds.push(row.id);
            imported++;
          } catch { failed++; }
        }
      });
      importTransaction();

      // Backfill embeddings for the exact rows just imported (async, non-blocking)
      if (importedIds.length > 0) {
        (async () => {
          try {
            const { embedWithChunking, embeddingToBuffer, addToEmbeddingCache, invalidateEmbeddingCache: invalidateCache } = await import("../embeddings/index.ts");
            const { updateMemoryEmbedding } = await import("../db/index.ts");
            const placeholders = importedIds.map(() => "?").join(",");
            const rows = db.prepare(
              `SELECT id, content, category, importance, is_static, source_count FROM memories WHERE id IN (${placeholders}) AND embedding IS NULL`
            ).all(...importedIds) as Array<{ id: number; content: string }>;
            for (const mem of rows) {
              try {
                const emb = await embedWithChunking(mem.content);
                updateMemoryEmbedding.run(embeddingToBuffer(emb), mem.id);
                addToEmbeddingCache({ id: mem.id, user_id: auth.user_id, content: mem.content, category: (mem as any).category ?? "general", importance: (mem as any).importance ?? 5, embedding: emb, is_static: !!((mem as any).is_static), source_count: (mem as any).source_count ?? 1, is_latest: true, is_forgotten: false } as any);
              } catch {}
            }
            invalidateCache();
          } catch (e: any) {
            log.error({ msg: "import_backfill_error", error: e.message });
          }
        })();
      }

      return json({ imported, failed, total: items.length });
    } catch (e: any) {
      return safeError("Import", e);
    }
  });

  // ==========================================================================
  // RESET -- wipe user-scoped data (OPEN_ACCESS mode only)
  // ==========================================================================

  router.post("/reset", async (req) => {
    const { auth, body } = getContext(req);
    if (!OPEN_ACCESS) return errorResponse("Reset only available in OPEN_ACCESS mode", 403);
    const b = body as any;
    if (b?.confirm !== "DESTROY") {
      return errorResponse('Reset requires "confirm": "DESTROY" in the request body. This is a destructive operation.', 400);
    }
    const userId = typeof b?.userId === "number" ? b.userId
      : typeof b?.user_id === "number" ? b.user_id : null;
    if (userId === null) {
      return errorResponse("userId is required. POST {\"userId\": <number>, \"confirm\": \"DESTROY\"} to reset a specific user's data. Global wipe is disabled.", 400);
    }
    const resetSource = typeof b?.source === "string" ? b.source : null;

    // Source-scoped reset
    if (resetSource) {
      const memIds = db.prepare("SELECT id FROM memories WHERE user_id = ? AND source = ?").all(userId, resetSource) as { id: number }[];
      const memIdSet = memIds.map((r) => r.id);
      if (memIdSet.length > 0) {
        for (let i = 0; i < memIdSet.length; i += 500) {
          const chunk = memIdSet.slice(i, i + 500);
          const placeholders = chunk.map(() => "?").join(",");
          const childTables = ["reconsolidations", "causal_links", "memory_entities", "memory_projects", "memory_links"];
          for (const t of childTables) {
            try {
              const col = t === "memory_links" ? "source_id" : "memory_id";
              db.prepare(`DELETE FROM ${t} WHERE ${col} IN (${placeholders})`).run(...chunk);
              if (t === "memory_links") {
                db.prepare(`DELETE FROM memory_links WHERE target_id IN (${placeholders})`).run(...chunk);
              }
            } catch (e: any) {
              opsCounters.reset_delete_warnings++;
              log.warn({ msg: "reset_child_delete_failed", table: t, user_id: userId, error: e?.message });
            }
          }
        }
        for (let i = 0; i < memIdSet.length; i += 500) {
          const chunk = memIdSet.slice(i, i + 500);
          const placeholders = chunk.map(() => "?").join(",");
          db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...chunk);
        }
      }
      try { db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')"); } catch (e: any) {
        opsCounters.fts_rebuild_failures++;
        log.warn({ msg: "fts_rebuild_failed", table: "memories_fts", error: e?.message });
      }
      invalidateEmbeddingCache();
      log.info({ msg: "reset_by_source", user_id: userId, source: resetSource, memories_deleted: memIdSet.length });
      return json({ reset: true, user_id: userId, source: resetSource, memories_deleted: memIdSet.length, scoped: true });
    }

    // Full user reset
    const userScopedTables = [
      "causal_chains", "temporal_patterns", "scratchpad", "reflections",
      "digests", "webhooks", "structured_facts", "current_state",
      "user_preferences", "consolidations", "episodes", "entities",
      "projects", "conversations", "personality_signals", "personality_profiles",
    ];
    let wiped = 0;
    const memIds = db.prepare("SELECT id FROM memories WHERE user_id = ?").all(userId) as { id: number }[];
    const memIdSet = memIds.map((r) => r.id);
    if (memIdSet.length > 0) {
      for (let i = 0; i < memIdSet.length; i += 500) {
        const chunk = memIdSet.slice(i, i + 500);
        const placeholders = chunk.map(() => "?").join(",");
        const childTables = ["reconsolidations", "causal_links", "memory_entities", "memory_projects", "memory_links"];
        for (const t of childTables) {
          try {
            const col = t === "memory_links" ? "source_id" : "memory_id";
            db.prepare(`DELETE FROM ${t} WHERE ${col} IN (${placeholders})`).run(...chunk);
            if (t === "memory_links") {
              db.prepare(`DELETE FROM memory_links WHERE target_id IN (${placeholders})`).run(...chunk);
            }
          } catch (e: any) {
            opsCounters.reset_delete_warnings++;
            log.warn({ msg: "reset_child_delete_failed", table: t, user_id: userId, error: e?.message });
          }
        }
      }
      wiped++;
    }
    try {
      const entIds = db.prepare("SELECT id FROM entities WHERE user_id = ?").all(userId) as { id: number }[];
      const entIdSet = entIds.map((r) => r.id);
      for (let i = 0; i < entIdSet.length; i += 500) {
        const chunk = entIdSet.slice(i, i + 500);
        const placeholders = chunk.map(() => "?").join(",");
        db.prepare(`DELETE FROM entity_relationships WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`).run(...chunk, ...chunk);
      }
    } catch (e: any) {
      opsCounters.reset_delete_warnings++;
      log.warn({ msg: "reset_entity_relationships_failed", user_id: userId, error: e?.message });
    }
    try {
      db.prepare("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)").run(userId);
    } catch (e: any) {
      opsCounters.reset_delete_warnings++;
      log.warn({ msg: "reset_messages_delete_failed", user_id: userId, error: e?.message });
    }
    for (const t of userScopedTables) {
      try { db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId); wiped++; } catch (e: any) {
        opsCounters.reset_delete_warnings++;
        log.warn({ msg: "reset_table_delete_failed", table: t, user_id: userId, error: e?.message });
      }
    }
    try { db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId); wiped++; } catch (e: any) {
      opsCounters.reset_delete_warnings++;
      log.warn({ msg: "reset_memories_delete_failed", user_id: userId, error: e?.message });
    }
    try { db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')"); } catch (e: any) {
      opsCounters.fts_rebuild_failures++;
      log.warn({ msg: "fts_rebuild_failed", table: "memories_fts", error: e?.message });
    }
    try { db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"); } catch (e: any) {
      opsCounters.fts_rebuild_failures++;
      log.warn({ msg: "fts_rebuild_failed", table: "messages_fts", error: e?.message });
    }
    try { db.exec("INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild')"); } catch (e: any) {
      opsCounters.fts_rebuild_failures++;
      log.warn({ msg: "fts_rebuild_failed", table: "episodes_fts", error: e?.message });
    }
    invalidateEmbeddingCache();
    log.info({ msg: "reset_complete", user_id: userId, memories_deleted: memIdSet.length, tables_wiped: wiped });
    return json({ reset: true, user_id: userId, memories_deleted: memIdSet.length, tables_wiped: wiped });
  });

  // ==========================================================================
  // STATE -- query and delete tracked key-value state
  // ==========================================================================

  router.get("/state", async (req) => {
    const { auth } = getContext(req);
    try {
      const url = new URL(req.url);
      const key = url.searchParams.get("key");
      const rows = key
        ? stateByKey.all(auth.user_id, `%${key}%`)
        : stateAll.all(auth.user_id);
      return json({ state: rows, count: (rows as any[]).length });
    } catch (e: any) {
      return safeError("State query", e);
    }
  });

  router.delete("/state", async (req) => {
    const { auth, body } = getContext(req);
    try {
      const b = body as any;
      const key = b?.key as string | undefined;
      const purge_all = b?.purge_all === true;
      let result;
      if (purge_all) {
        result = deleteStateAll.run(auth.user_id);
      } else if (key) {
        result = deleteStateByKey.run(auth.user_id, `%${key}%`);
      } else {
        return errorResponse("key (string) or purge_all (true) required");
      }
      return json({ ok: true, deleted: (result as any).changes });
    } catch (e: any) {
      return safeError("State delete", e);
    }
  });

  // ==========================================================================
  // AUDIT LOG
  // ==========================================================================

  router.get("/audit", async (req) => {
    const { auth, requestId } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
    const offset = Number(url.searchParams.get("offset")) || 0;
    const action = url.searchParams.get("action");
    const { sql, params } = buildAuditQuery(action, limit, offset);
    const entries = db.prepare(sql).all(...(params as any[]));
    const total = (countAuditLog.get() as any).count;
    return json({ entries, total, limit, offset }, 200, { "X-Request-Id": requestId });
  });
}
