// ============================================================================
// MEMORY DOMAIN - Route handlers
// ============================================================================

import { randomUUID } from "node:crypto";
import type { Router } from "../router/types.ts";
import { getContext, hasScope, canAccessOwnedRow } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { auditLog } from "../middleware/audit.ts";
import { log, opsCounters } from "../config/logger.ts";
import {
  getMemoryById, listRecentMemories, listByCategoryMemories, listBySourceMemories,
  deleteMemoryById, markMemoryForgotten, markMemoryArchived, markMemoryUnarchived,
  updateMemoryForgetReason, updateMemoryTags, getAllTagsForUser, getByTagForUser,
  getVersionChainForUser, getLinksForMemory, countNoEmbeddingForUser,
  ensureFeedbackTable, insertFeedbackBatch, adjustImportance,
  getFeedbackSignalCounts, getTopIrrelevant, getTopHelpful,
  getStaleMemories, getUnlinkedHighValue, getContradictionHints,
  recordUsageEvent,
} from "./db.ts";
import {
  normalizeTags, clampImportance, validateContent, validateContentSize,
  checkQuota, checkContentQuota, isValidFeedbackSignal, buildCorrectionContent,
  ContentValidationError,
} from "./store.ts";
import { checkSimHashDuplicate, storeSimHash, boostDuplicate } from "./simhash.ts";
import { hybridSearch } from "./search.ts";
import type { FeedbackItem } from "./types.ts";
import { MAX_CONTENT_SIZE, DEFAULT_IMPORTANCE } from "./types.ts";
import { embed, embeddingToBuffer, addToEmbeddingCache, invalidateEmbeddingCache, getCachedEmbeddings, cosineSimilarity, embedWithChunking, demoteFromLatestCache } from "../embeddings/index.ts";
import { db, insertMemory, linkMemoryEntity, linkMemoryProject, recordUsage, markSuperseded, insertLink, getLinksForUser, writeVec } from "../db/index.ts";
import { DB_PATH, MAX_ARTIFACT_SIZE, MAX_ARTIFACTS_PER_MEMORY, INBOX_MODE } from "../config/index.ts";
import { statSync } from "node:fs";
import { processArtifact } from "../artifacts/storage.ts";
import type { ArtifactInput } from "../artifacts/storage.ts";
import { indexArtifact } from "../artifacts/fts.ts";
import { insertArtifact, markArtifactEncrypted } from "../db/index.ts";
import { autoLink } from "./search.ts";
import { insertEpisode, getEpisodeBySession, updateEpisodeForUser } from "../episodes/db.ts";
import { fastExtractFacts } from "../intelligence/extraction.ts";
import { emitWebhookEvent } from "../platform/webhooks.ts";
import { enqueueJob } from "../jobs/index.ts";
import { FSRSRating, fsrsProcessReview, calculateDecayScore } from "../fsrs/index.ts";
import { getOwnedEntityIds, getOwnedProjectIds } from "../routes/types.ts";
import { updateCooccurrences } from "../graph/cooccurrence.ts";
import { isLocalModelAvailable } from "../llm/local.ts";

export function registerMemoryRoutes(router: Router): void {

  // POST /store, /memory, /memories - store a new memory
  const storeHandler = async (req: Request) => {
    const requestStart = performance.now();
    const { auth, body, clientIp, requestId } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const b = body as any;
      const { category, source, session_id, episode, model, skip_processing } = b || {};
      const content = validateContent(b?.content);
      validateContentSize(content, MAX_CONTENT_SIZE);
      const quotaCheck = checkQuota(auth.user_id);
      if (quotaCheck && !quotaCheck.allowed) {
        return errorResponse("Memory quota exceeded (" + quotaCheck.current + "/" + quotaCheck.max + "). Contact admin to increase limit.", 429, requestId);
      }
      const sizeCheck = checkContentQuota(content.length, auth.user_id);
      if (sizeCheck && !sizeCheck.allowed) {
        return errorResponse("Content too large for your quota (" + sizeCheck.current + "/" + sizeCheck.max + " bytes)", 413, requestId);
      }
      const imp = clampImportance(b?.importance, DEFAULT_IMPORTANCE);
      const tagsJson = normalizeTags(b?.tags);

      // Episode management
      let episodeId: number | null = null;
      if (episode !== false && session_id && source) {
        const existing = getEpisodeBySession.get(session_id, source, auth.user_id) as any;
        if (existing) {
          episodeId = existing.id;
        } else if (episode !== "none") {
          const ep = insertEpisode.get(null, session_id, source, auth.user_id) as { id: number };
          episodeId = ep.id;
        }
      }

      // SimHash near-duplicate check
      const simhashResult = checkSimHashDuplicate(content, auth.user_id);
      if (simhashResult.isDuplicate && simhashResult.existingId) {
        boostDuplicate(simhashResult.existingId);
        log.info({ msg: "simhash_duplicate_detected", existing_id: simhashResult.existingId, distance: simhashResult.distance });
        return json({ stored: false, duplicate: true, existing_id: simhashResult.existingId, distance: simhashResult.distance, boosted: true });
      }

      // Pre-validate artifacts before any DB writes
      if (Array.isArray(b?.artifacts) && b.artifacts.length > 0) {
        if (b.artifacts.length > MAX_ARTIFACTS_PER_MEMORY) {
          return errorResponse(`Too many artifacts (max ${MAX_ARTIFACTS_PER_MEMORY})`, 400, requestId);
        }
        for (const rawArtifact of b.artifacts) {
          if (!rawArtifact.filename || !rawArtifact.data_base64) {
            return errorResponse("Each artifact requires filename and data_base64", 400, requestId);
          }
          const decoded = Buffer.from(rawArtifact.data_base64, "base64");
          if (decoded.length > MAX_ARTIFACT_SIZE) {
            return errorResponse(`Artifact "${rawArtifact.filename}" exceeds max size (${MAX_ARTIFACT_SIZE} bytes)`, 413, requestId);
          }
        }
      }

      // Embed
      let embBuffer: Buffer | null = null;
      let embArray: Float32Array | null = null;
      try {
        embArray = await embed(content);
        embBuffer = embeddingToBuffer(embArray);
      } catch (e: any) {
        log.warn({ msg: "embedding_failed_storing_without", error: e.message });
      }

      const isStatic = b?.is_static ? 1 : 0;
      const forgetAfter = b?.forget_after || null;
      const forgetReason = b?.forget_reason || null;
      const isInference = b?.is_inference ? 1 : 0;

      const result = insertMemory.get(
        content,
        (category || "general").trim(),
        (source || "unknown").trim(),
        session_id || null,
        imp,
        embBuffer,
        1, 1, null, null, 1, isStatic, 0, forgetAfter, forgetReason, isInference,
        (model && typeof model === "string") ? model.trim() : null, auth.user_id, auth.space_id || null
      ) as { id: number; created_at: string };

      const syncId = randomUUID();
      const memStatus = b?.status === "pending" ? "pending"
        : b?.status === "approved" ? "approved"
        : INBOX_MODE === "review" ? "pending" : "approved";
      db.prepare("UPDATE memories SET tags = ?, episode_id = ?, sync_id = ?, confidence = 1.0, status = ? WHERE id = ?")
        .run(tagsJson, episodeId, syncId, memStatus, result.id);

      // Entity / project linking
      const ownedEntityIds = getOwnedEntityIds(b?.entity_ids, auth);
      for (const eid of ownedEntityIds) linkMemoryEntity.run(result.id, eid);
      for (const pid of getOwnedProjectIds(b?.project_ids, auth)) linkMemoryProject.run(result.id, pid);
      if (ownedEntityIds.length >= 2) updateCooccurrences(result.id, auth.user_id);

      if (episodeId) updateEpisodeForUser.run(null, null, null, episodeId, auth.user_id);

      // FSRS init
      const initFSRS = fsrsProcessReview(null, FSRSRating.Good, 0);
      const decayScore = calculateDecayScore(imp, result.created_at, 0, null, !!isStatic, 1, initFSRS.stability);
      db.prepare("UPDATE memories SET decay_score = ?, fsrs_stability = ?, fsrs_difficulty = ?, fsrs_storage_strength = ?, fsrs_retrieval_strength = ?, fsrs_learning_state = ?, fsrs_reps = ?, fsrs_lapses = ?, fsrs_last_review_at = ? WHERE id = ?")
        .run(Math.round(decayScore * 1000) / 1000, initFSRS.stability, initFSRS.difficulty, initFSRS.storage_strength, initFSRS.retrieval_strength, initFSRS.learning_state, initFSRS.reps, initFSRS.lapses, initFSRS.last_review_at, result.id);

      storeSimHash(result.id, simhashResult.simhash);

      // Artifact storage (already validated before memory insert)
      const artifactResults: Array<{ id: number; filename: string; size_bytes: number; storage_mode: string }> = [];
      if (Array.isArray(b?.artifacts) && b.artifacts.length > 0) {
        for (const rawArtifact of b.artifacts) {
          const stored = processArtifact(rawArtifact as ArtifactInput, auth.user_id);
          const artResult = insertArtifact.get(
            result.id,
            stored.filename,
            stored.mime_type,
            stored.size_bytes,
            stored.sha256,
            stored.storage_mode,
            stored.data,
            stored.disk_path
          ) as { id: number; created_at: string };

          artifactResults.push({
            id: artResult.id,
            filename: stored.filename,
            size_bytes: stored.size_bytes,
            storage_mode: stored.storage_mode,
          });

          if (stored.encrypted) {
            markArtifactEncrypted.run(artResult.id);
          }

          // FTS index text-based artifacts on plaintext (before encryption)
          if (stored.plaintextData) {
            indexArtifact(artResult.id, stored.mime_type, stored.plaintextData);
          }
        }
      }

      emitWebhookEvent("memory.created", {
        id: result.id, content, category: category || "general",
        importance: imp, tags: tagsJson ? JSON.parse(tagsJson) : [], episode_id: episodeId,
      }, auth.user_id);

      // Fast synchronous extraction (regex, no LLM)
      const extractionCategory = (category || "general").toLowerCase();
      const skipExtraction = skip_processing === true
        || ["task", "issue", "plan"].includes(extractionCategory)
        || content.startsWith("Session compaction summary")
        || content.startsWith("[Consolidated:")
        || content.startsWith("[auto-captured]");
      if (!skipExtraction) fastExtractFacts(content, result.id, auth.user_id, episodeId);

      if (embArray) {
        addToEmbeddingCache({
          id: result.id, user_id: auth.user_id, content,
          category: category || "general", importance: imp, embedding: embArray,
          is_static: !!isStatic, source_count: 1, is_latest: true, is_forgotten: false,
        });
      }

      const elapsed = performance.now() - requestStart;
      opsCounters.sla_store_total++;
      if (elapsed < 500) opsCounters.sla_store_under_500ms++;
      try { recordUsage.run(auth.user_id, "memory.store", 1, null); } catch {}

      const response = json({
        stored: true,
        id: result.id,
        created_at: result.created_at,
        importance: imp,
        linked: 0,
        embedded: !!embBuffer,
        tags: tagsJson ? JSON.parse(tagsJson) : [],
        episode_id: episodeId,
        decay_score: decayScore,
        fact_extraction: isLocalModelAvailable() ? "queued" : "disabled",
        status: memStatus,
        model: (model && typeof model === "string") ? model.trim() : null,
        ...(artifactResults.length > 0 ? { artifacts: artifactResults } : {}),
      }, 201);

      auditLog(auth.user_id, "memory.store", "memory", result.id, (category || "general"), clientIp);

      if (embArray) {
        const embBase64 = Buffer.from(embArray.buffer, embArray.byteOffset, embArray.byteLength).toString("base64");
        enqueueJob("post_store", {
          memoryId: result.id, content, category: category || "general",
          userId: auth.user_id, importance: imp, embeddingBase64: embBase64,
          lightweight: !!skip_processing,
        });
      }

      return response;
    } catch (e: any) {
      opsCounters.sla_errors_5xx++;
      if (e instanceof ContentValidationError) return errorResponse(e.message, 400);
      return safeError("store", e);
    }
  };
  router.post("/store", storeHandler);
  router.post("/memory", storeHandler);
  router.post("/memories", storeHandler);

  // GET /list
  router.get("/list", async (req) => {
    const { auth, url } = getContext(req);
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
    const category = url.searchParams.get("category");
    const source = url.searchParams.get("source");
    if (source) return json({ results: listBySourceMemories(source, auth.user_id, category, limit) });
    const results = category ? listByCategoryMemories(category, auth.user_id, limit) : listRecentMemories(auth.user_id, limit);
    return json({ results });
  });

  // GET /memory/:id
  router.get("/memory/:id", async (req, params) => {
    const { auth } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const memory = getMemoryById(id);
    if (!memory) return errorResponse("Not found", 404);
    if (memory.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Not found", 404);
    const links = getLinksForMemory(id, auth.user_id);
    const rootId = memory.root_memory_id || memory.id;
    const chain = getVersionChainForUser(rootId, auth.user_id);
    let tags: string[] = [];
    try { tags = memory.tags ? JSON.parse(memory.tags) : []; } catch {}
    return json({ ...memory, tags, links: links.map((l: any) => ({ ...l })), version_chain: chain.length > 1 ? chain : undefined });
  });

  // DELETE /memory/:id
  router.delete("/memory/:id", async (req, params) => {
    const { auth, clientIp } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const mem = getMemoryById(id);
    if (!mem) return errorResponse("Not found", 404);
    if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
    deleteMemoryById(id);
    auditLog(auth.user_id, "memory.delete", "memory", id, null, clientIp);
    return json({ deleted: true, id });
  });

  // POST /memory/:id/forget
  router.post("/memory/:id/forget", async (req, params) => {
    const { auth, body, clientIp } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const mem = getMemoryById(id);
    if (!mem) return errorResponse("Not found", 404);
    if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
    markMemoryForgotten.run(id);
    const b = body as any;
    if (b?.reason) updateMemoryForgetReason(id, b.reason);
    auditLog(auth.user_id, "memory.forget", "memory", id, (b?.reason || "manual"), clientIp);
    return json({ forgotten: true, id });
  });

  // POST /memory/:id/archive
  router.post("/memory/:id/archive", async (req, params) => {
    const { auth, clientIp } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const mem = getMemoryById(id);
    if (!mem) return errorResponse("Not found", 404);
    if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
    markMemoryArchived.run(id);
    auditLog(auth.user_id, "memory.archive", "memory", id, null, clientIp);
    return json({ archived: true, id });
  });

  // POST /memory/:id/unarchive
  router.post("/memory/:id/unarchive", async (req, params) => {
    const { auth, clientIp } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const mem = getMemoryById(id);
    if (!mem) return errorResponse("Not found", 404);
    if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
    markMemoryUnarchived.run(id);
    auditLog(auth.user_id, "memory.unarchive", "memory", id, null, clientIp);
    return json({ unarchived: true, id });
  });

  // PUT /memory/:id/tags
  router.put('/memory/:id/tags', async (req, params) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, 'write')) return errorResponse('Write scope required', 403);
    try {
      const id = Number(params.id);
      if (isNaN(id)) return errorResponse('Invalid id');
      const mem = getMemoryById(id);
      if (!mem) return errorResponse('Not found', 404);
      if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse('Forbidden', 403);
      const b = body as any;
      let tags: string[] = [];
      if (Array.isArray(b?.tags)) {
        tags = b.tags.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean);
      }
      updateMemoryTags(id, JSON.stringify(tags));
      return json({ updated: true, id, tags });
    } catch (e: any) {
      return safeError('update tags', e);
    }
  });

  // GET /tags
  router.get('/tags', async (req) => {
    const { auth } = getContext(req);
    const rows = getAllTagsForUser(auth.user_id);
    const tagSet = new Set<string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.tags) as string[];
        for (const t of parsed) tagSet.add(t);
      } catch {}
    }
    return json({ tags: Array.from(tagSet).sort() });
  });

  // POST /tags/search
  router.post('/tags/search', async (req) => {
    const { auth, body } = getContext(req);
    try {
      const b = body as any;
      const tag = b?.tag?.trim().toLowerCase();
      if (!tag) return errorResponse('tag is required');
      const limit = Math.min(Number(b?.limit) || 20, 100);
      const safeTag = tag
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      const results = getByTagForUser('%"' + safeTag + '"%', auth.user_id, limit);
      for (const r of results) {
        try { r.tags = JSON.parse(r.tags); } catch { r.tags = []; }
      }
      return json({ results, tag });
    } catch (e: any) {
      return safeError('Tag search', e);
    }
  });
  // POST /correct
  router.post('/correct', async (req) => {
    const { auth, body, clientIp, requestId } = getContext(req);
    if (!hasScope(auth, 'write')) return errorResponse('Write scope required', 403);
    try {
      const b = body as any;
      const correction = b?.correction?.trim();
      if (!correction) return errorResponse('correction (string) is required');
      const originalClaim = b?.original_claim?.trim() || null;
      let memoryId = b?.memory_id ? Number(b.memory_id) : null;
      const category = b?.category || 'state';

      // Find the memory to correct
      let correctedMemory: any = null;
      if (memoryId) {
        correctedMemory = db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as any;
        if (!correctedMemory) return errorResponse(`Memory #${memoryId} not found`, 404);
        if (correctedMemory.user_id !== auth.user_id) return errorResponse("Not your memory", 403);
      } else if (originalClaim) {
        const candidates = await hybridSearch(originalClaim, 5, false, true, false, auth.user_id);
        for (const c of candidates) {
          const full = db.prepare("SELECT * FROM memories WHERE id = ?").get(c.id) as any;
          if (full && !full.is_forgotten && full.user_id === auth.user_id) {
            correctedMemory = full; memoryId = full.id; break;
          }
        }
      }

      let embBuffer: Buffer | null = null;
      let embArray: Float32Array | null = null;
      try {
        embArray = await embed(correction);
        embBuffer = embeddingToBuffer(embArray);
      } catch (e: any) {
        log.warn({ msg: "correction_embed_failed", error: e.message });
      }

      if (!correctedMemory && embArray) {
        const allMems = getCachedEmbeddings(true, auth.user_id);
        let bestSim = 0; let bestMem: any = null;
        for (const mem of allMems) {
          const sim = cosineSimilarity(embArray, mem.embedding);
          if (sim > 0.5 && sim > bestSim) { bestSim = sim; bestMem = mem; }
        }
        if (bestMem) {
          const cand = db.prepare("SELECT * FROM memories WHERE id = ?").get(bestMem.id) as any;
          if (cand?.user_id === auth.user_id) { correctedMemory = cand; memoryId = bestMem.id; }
        }
      }

      const storedContent = buildCorrectionContent(correction, originalClaim, memoryId);
      const imp = Math.max(b?.importance || 9, 8);

      const result = insertMemory.get(
        storedContent, category, (b?.source || "correction").trim(),
        null, imp, embBuffer,
        1, 1, null, null, 1, 1, 0, null, null, 0,
        null, auth.user_id, auth.space_id || null
      ) as { id: number; created_at: string };

      const correctionTags = JSON.stringify(["correction", ...(b?.tags || [])]);
      db.prepare("UPDATE memories SET tags = ?, status = 'approved' WHERE id = ?").run(correctionTags, result.id);

      const initFSRS = fsrsProcessReview(null, FSRSRating.Good, 0);
      const decayScore = calculateDecayScore(imp, result.created_at, 0, null, true, 1, initFSRS.stability);
      db.prepare("UPDATE memories SET decay_score = ?, fsrs_stability = ?, fsrs_difficulty = ?, fsrs_storage_strength = ?, fsrs_retrieval_strength = ?, fsrs_learning_state = ?, fsrs_reps = ?, fsrs_lapses = ?, fsrs_last_review_at = ? WHERE id = ?")
        .run(Math.round(decayScore * 1000) / 1000, initFSRS.stability, initFSRS.difficulty, initFSRS.storage_strength, initFSRS.retrieval_strength, initFSRS.learning_state, initFSRS.reps, initFSRS.lapses, initFSRS.last_review_at, result.id);

      let corrected_memory_id: number | null = null;
      let corrected_content: string | null = null;
      if (correctedMemory && memoryId) {
        db.prepare("UPDATE memories SET is_latest = 0 WHERE id = ?").run(memoryId);
        const rootId = correctedMemory.root_memory_id || correctedMemory.id;
        const newVersion = (correctedMemory.version || 1) + 1;
        db.prepare("UPDATE memories SET version = ?, root_memory_id = ?, parent_memory_id = ? WHERE id = ?").run(newVersion, rootId, memoryId, result.id);
        insertLink.run(result.id, memoryId, 1.0, "corrects");
        corrected_memory_id = memoryId;
        corrected_content = correctedMemory.content?.substring(0, 200);
      }

      if (embArray) {
        const embBase64 = Buffer.from(embArray.buffer, embArray.byteOffset, embArray.byteLength).toString("base64");
        enqueueJob("post_store", { memoryId: result.id, content: storedContent, category, userId: auth.user_id, importance: imp, embeddingBase64: embBase64 });
      }
      invalidateEmbeddingCache();

      auditLog(auth.user_id, "memory.correct", "memory", result.id, category, clientIp);
      emitWebhookEvent("memory.corrected", { id: result.id, correction, corrected_memory_id, corrected_content }, auth.user_id);

      return json({ corrected: true, id: result.id, corrected_memory_id, corrected_content, importance: imp, decay_score: decayScore });
    } catch (e: any) {
      return safeError('correct', e);
    }
  });
  // POST /feedback
  router.post('/feedback', async (req) => {
    const { auth, body } = getContext(req);
    try {
      ensureFeedbackTable();
      const b = body as any;
      const feedbackItems: FeedbackItem[] = [];
      if (b?.items && Array.isArray(b.items)) {
        for (const item of b.items) {
          if (!item.query || !item.memory_id || !item.signal) continue;
          if (!isValidFeedbackSignal(item.signal)) continue;
          feedbackItems.push(item as FeedbackItem);
        }
      } else if (b?.query && b?.memory_id && b?.signal) {
        if (!isValidFeedbackSignal(b.signal)) {
          return errorResponse('Invalid signal. Must be one of: used, ignored, corrected, irrelevant, helpful', 400);
        }
        feedbackItems.push({ query: b.query, memory_id: b.memory_id, signal: b.signal, context: b.context, agent: b.agent });
      }
      if (feedbackItems.length === 0) {
        return errorResponse('Required: query, memory_id, signal (used|ignored|corrected|irrelevant|helpful). Or items[] for batch.', 400);
      }
      insertFeedbackBatch(auth.user_id, feedbackItems);
      for (const fb of feedbackItems) {
        try {
          if (fb.signal === 'helpful') adjustImportance(fb.memory_id, auth.user_id, 0.5);
          else if (fb.signal === 'irrelevant') adjustImportance(fb.memory_id, auth.user_id, -0.3);
        } catch {}
      }
      return json({ ok: true, recorded: feedbackItems.length });
    } catch (e: any) {
      return safeError('Feedback', e);
    }
  });
  // GET /feedback/stats
  router.get('/feedback/stats', async (req) => {
    const { auth, url } = getContext(req);
    try {
      ensureFeedbackTable();
      const days = Number(url.searchParams.get('days') || 30);
      const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const signalCounts = getFeedbackSignalCounts(auth.user_id, sinceDate) as any[];
      const topIrrelevant = getTopIrrelevant(auth.user_id, sinceDate);
      const topHelpful = getTopHelpful(auth.user_id, sinceDate);
      const totalFeedback = signalCounts.reduce((sum: number, r: any) => sum + r.count, 0);
      const helpfulCount = signalCounts.find((r: any) => r.signal === 'helpful')?.count || 0;
      const usedCount = signalCounts.find((r: any) => r.signal === 'used')?.count || 0;
      const precision = totalFeedback > 0 ? Math.round(((helpfulCount + usedCount) / totalFeedback) * 1000) / 1000 : null;
      return json({
        period_days: days,
        total_feedback: totalFeedback,
        signal_breakdown: signalCounts,
        estimated_precision: precision,
        top_irrelevant_memories: topIrrelevant,
        top_helpful_memories: topHelpful,
      });
    } catch (e: any) {
      return safeError('Feedback stats', e);
    }
  });
  // GET /memory-health
  router.get('/memory-health', async (req) => {
    const { auth, url } = getContext(req);
    try {
      const staleDays = Number(url.searchParams.get('stale_days') || 60);
      const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
      const staleRows = getStaleMemories(auth.user_id, staleDays, limit) as any[];
      const unlinkedRows = getUnlinkedHighValue(auth.user_id, limit) as any[];
      const contradictionRows = getContradictionHints(auth.user_id, limit) as any[];
      return json({
        stale: staleRows.map((r: any) => ({
          id: r.id,
          content: r.content?.substring(0, 150),
          category: r.category,
          importance: r.importance,
          created_at: r.created_at,
          access_count: r.access_count || 0,
          decay_score: r.decay_score,
        })),
        high_value_unlinked: unlinkedRows.map((r: any) => ({
          id: r.id,
          content: r.content?.substring(0, 150),
          category: r.category,
          importance: r.importance,
          created_at: r.created_at,
        })),
        contradiction_hints: contradictionRows.map((r: any) => ({
          id: r.id,
          content: r.content?.substring(0, 200),
          category: r.category,
          created_at: r.created_at,
        })),
        summary: {
          stale_count: staleRows.length,
          unlinked_high_value: unlinkedRows.length,
          contradiction_hints: contradictionRows.length,
        },
      });
    } catch (e: any) {
      return safeError('Memory health', e);
    }
  });
  // POST /backfill
  router.post('/backfill', async (req) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, 'write')) return errorResponse('Write scope required', 403);
    try {
      const b = body as any;
      const batch = Math.min(Number(b?.batch) || 50, 200);
      const { backfillEmbeddings } = await import("../routes/types.ts");
      const count = await backfillEmbeddings(batch, auth.user_id);
      const remaining = countNoEmbeddingForUser(auth.user_id);
      return json({ backfilled: count, remaining });
    } catch (e: any) {
      return safeError('Backfill', e);
    }
  });

  // POST /memory/:id/update - create a new version of an existing memory
  router.post("/memory/:id/update", async (req, params) => {
    const { auth, body, clientIp } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const id = Number(params.id);
      if (isNaN(id)) return errorResponse("Invalid id");
      const existing = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
      if (!existing) return errorResponse("Not found", 404);
      if (existing.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
      if (existing.is_forgotten) return errorResponse("Cannot update a forgotten memory", 400);
      const b = body as any;
      const newContent = b?.content?.trim();
      if (!newContent) return errorResponse("content is required and must be a non-empty string");
      const category = b?.category || existing.category;
      const imp = b?.importance ? Math.max(1, Math.min(10, Number(b.importance))) : existing.importance;

      let embBuffer: Buffer | null = null;
      let embArray: Float32Array | null = null;
      try { embArray = await embed(newContent); embBuffer = embeddingToBuffer(embArray); }
      catch (e: any) { log.warn({ msg: "embedding_failed_update", error: (e as any).message }); }

      const rootId = existing.root_memory_id || existing.id;
      const newVersion = (existing.version || 1) + 1;
      markSuperseded.run(id);

      const result = insertMemory.get(
        newContent, category, existing.source, existing.session_id, imp, embBuffer,
        newVersion, 1, id, rootId, existing.source_count || 1,
        existing.is_static ? 1 : 0, 0, null, null, existing.is_inference ? 1 : 0,
        existing.model || null, existing.user_id, existing.space_id || null
      ) as { id: number; created_at: string };

      db.prepare("UPDATE memories SET tags = ?, episode_id = ?, confidence = ? WHERE id = ?")
        .run(existing.tags || null, existing.episode_id || null, existing.confidence ?? 1.0, result.id);
      insertLink.run(result.id, id, 1.0, "updates");

      let linked = 0;
      if (embArray) { writeVec(result.id, embArray); linked = await autoLink(result.id, embArray, auth.user_id); }

      demoteFromLatestCache(id);
      return json({ updated: true, old_id: id, new_id: result.id, version: newVersion, root_id: rootId, linked, embedded: !!embBuffer });
    } catch (e: any) { return safeError("Update", e); }
  });

  // GET /links/:id - get links for a memory
  router.get("/links/:id", async (req, params) => {
    const { auth } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const mem = db.prepare("SELECT user_id FROM memories WHERE id = ?").get(id) as any;
    if (!mem || (mem.user_id !== auth.user_id && !auth.is_admin)) return errorResponse("Not found", 404);
    const links = getLinksForUser.all(id, auth.user_id, id, auth.user_id);
    return json({ memory_id: id, links });
  });

  // GET /versions/:id - get version chain for a memory
  router.get("/versions/:id", async (req, params) => {
    const { auth } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const mem = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
    if (!mem) return errorResponse("Not found", 404);
    if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Not found", 404);
    const rootId = mem.root_memory_id || mem.id;
    const chain = db.prepare(
      `SELECT id, content, category, version, created_at, is_latest, parent_memory_id FROM memories
       WHERE (root_memory_id = ? OR id = ?) AND user_id = ? ORDER BY version ASC`
    ).all(rootId, rootId, auth.user_id);
    return json({ root_id: rootId, chain });
  });

  // GET /stats - user-scoped memory statistics
  router.get("/stats", async (req) => {
    const { auth } = getContext(req);
    const uid = auth.user_id;
    const memCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ?").get(uid) as { count: number };
    const embCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND embedding IS NOT NULL").get(uid) as { count: number };
    const linkCount = db.prepare(`SELECT COUNT(*) as count FROM memory_links ml JOIN memories ms ON ms.id = ml.source_id JOIN memories mt ON mt.id = ml.target_id WHERE ms.user_id = ? AND mt.user_id = ?`).get(uid, uid) as { count: number };
    const forgottenCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_forgotten = 1").get(uid) as { count: number };
    const staticCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_static = 1 AND is_forgotten = 0").get(uid) as { count: number };
    const dynamicCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_static = 0 AND is_forgotten = 0").get(uid) as { count: number };
    const versionedCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND version > 1").get(uid) as { count: number };
    const archivedCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_archived = 1 AND is_forgotten = 0").get(uid) as { count: number };
    const categories = db.prepare("SELECT category, COUNT(*) as count FROM memories WHERE user_id = ? AND is_forgotten = 0 GROUP BY category ORDER BY count DESC").all(uid);
    const dbSize = statSync(DB_PATH).size;
    return json({
      memories: { total: memCount.count, embedded: embCount.count, forgotten: forgottenCount.count, archived: archivedCount.count, static: staticCount.count, dynamic: dynamicCount.count, versioned: versionedCount.count, categories },
      links: { total: linkCount.count },
      db_size_mb: Math.round(dbSize / 1048576 * 100) / 100,
    });
  });

  // GET /duplicates - find near-duplicate memory clusters
  router.get("/duplicates", async (req) => {
    const { auth, url } = getContext(req);
    try {
      const threshold = Number(url.searchParams.get("threshold") || 0.85);
      const limitParam = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      const allMems = getCachedEmbeddings(true, auth.user_id);
      const clusters: Array<{ anchor: { id: number; content: string; category: string }; duplicates: Array<{ id: number; content: string; category: string; similarity: number }> }> = [];
      const seen = new Set<number>();
      for (let i = 0; i < allMems.length && clusters.length < limitParam; i++) {
        if (seen.has(allMems[i].id)) continue;
        const dupes: Array<{ id: number; content: string; category: string; similarity: number }> = [];
        for (let j = i + 1; j < allMems.length; j++) {
          if (seen.has(allMems[j].id)) continue;
          const sim = cosineSimilarity(allMems[i].embedding, allMems[j].embedding);
          if (sim >= threshold) {
            dupes.push({ id: allMems[j].id, content: allMems[j].content.substring(0, 200), category: allMems[j].category, similarity: Math.round(sim * 1000) / 1000 });
            seen.add(allMems[j].id);
          }
        }
        if (dupes.length > 0) {
          seen.add(allMems[i].id);
          clusters.push({ anchor: { id: allMems[i].id, content: allMems[i].content.substring(0, 200), category: allMems[i].category }, duplicates: dupes });
        }
      }
      return json({ clusters, total: clusters.length, threshold });
    } catch (e: any) { return safeError("Duplicates", e); }
  });

} // end registerMemoryRoutes