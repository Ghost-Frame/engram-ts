// ============================================================================
// INGESTION DOMAIN - Route handlers
// POST /add, /ingest, /derive, /import/mem0, /import/supermemory,
//      /import/bulk, /import/json
// ============================================================================

import { randomUUID } from "node:crypto";
import { htmlToText } from "html-to-text";
import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { log, opsCounters } from "../config/logger.ts";
import { DEFAULT_IMPORTANCE } from "../config/index.ts";
import { extractFacts, processExtractionResult } from "../llm/index.ts";
import { callLocalModel, isLocalModelAvailable } from "../llm/local.ts";
import { embedWithChunking, embeddingToBuffer, cosineSimilarity, getCachedEmbeddings } from "../embeddings/index.ts";
import { autoLink } from "../memory/search.ts";
import { db, insertMemory, writeVec, linkMemoryEntity, linkMemoryProject } from "../db/index.ts";
import { getOwnedEntityIds, getOwnedProjectIds } from "../routes/types.ts";
import { enqueueJob } from "../jobs/index.ts";
import { emitWebhookEvent } from "../platform/webhooks.ts";
import { ingestAsync } from "./index.ts";
import { safeFetch } from "../helpers/safe-fetch.ts";
import { chunkDocument } from "./chunker.ts";
import { bulkInsertConvo } from "../conversations/db.ts";

export function registerIngestionRoutes(router: Router): void {

  // --------------------------------------------------------------------------
  // POST /add - add from conversation (LLM fact extraction)
  // --------------------------------------------------------------------------

  router.post("/add", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    if (!isLocalModelAvailable()) return errorResponse("LLM not configured - /add requires fact extraction", 400);
    try {
      const body = rawBody as any;
      const messages = body.messages as Array<{ role: string; content: string }>;
      if (!Array.isArray(messages) || messages.length === 0) {
        return errorResponse("messages array required: [{role: 'user'|'assistant'|'system', content: '...'}]");
      }

      const category = body.category || "general";
      const source = body.source || "conversation";
      const projectIds = body.project_ids as number[] | undefined;
      const entityIds = body.entity_ids as number[] | undefined;
      const episodeId = body.episode_id as number | undefined;

      // Format conversation for extraction
      const convoText = messages.map((m: any) => `${m.role}: ${m.content}`).join("\n\n");

      const extractionPrompt = `You are a fact extraction engine. Analyze this conversation and extract distinct, atomic facts worth remembering long-term.

Rules:
- Extract facts primarily from USER messages. Only extract from ASSISTANT messages if they contain genuinely novel information (not just rephrasing the user).
- Each fact should be ONE self-contained statement. If you can't summarize it in under 50 words, split it.
- Skip greetings, filler, questions without assertions, and transient information.
- For each fact, classify:
  - category: task|discovery|decision|state|issue|general
  - importance: 1-10 (9-10=critical decisions, 7-8=useful knowledge, 5-6=context, <5=minor)
  - is_static: true if this is a permanent/rarely-changing fact, false if temporal
  - is_correction: true if this fact corrects, overrides, or clarifies a previously stated fact
  - tags: 2-5 lowercase keyword tags
- Detect temporal facts and set forget_after if appropriate (ISO datetime or null)

CRITICAL - Correction detection:
- If a USER message corrects the assistant (e.g. "no, X is Y", "that's wrong", "actually...", "I told you", "you forgot"), the corrected fact should:
  - Have is_correction: true
  - Have is_static: true (corrections are permanent by default)
  - Have importance: 9 or higher
  - Have the tag "correction"
  - State the CORRECT information clearly, not the wrong information
- Corrections about infrastructure, preferences, identities, or operational facts are the MOST important facts in any conversation. Never skip them.

Return JSON:
{
  "facts": [
    {
      "content": "extracted fact as a clear statement",
      "category": "task",
      "importance": 7,
      "is_static": false,
      "is_correction": false,
      "tags": ["keyword1", "keyword2"],
      "forget_after": null
    }
  ]
}

If no meaningful facts, return {"facts": []}`;

      const llmResp = await callLocalModel(extractionPrompt, convoText, { priority: "background" });
      if (!llmResp) return json({ added: 0, facts: [] });

      let extracted: { facts: Array<any> };
      try {
        const cleaned = llmResp.replace(/```json\n?|\n?```/g, "").trim();
        try {
          extracted = JSON.parse(cleaned);
        } catch {
          const jsonMatch = cleaned.match(/\{[\s\S]*"facts"[\s\S]*\}/);
          if (jsonMatch) {
            extracted = JSON.parse(jsonMatch[0]);
          } else {
            log.error({ msg: "conversation_extraction_parse_error", response: cleaned.substring(0, 500) });
            return errorResponse("LLM returned unparseable response", 500);
          }
        }
      } catch (parseErr: any) {
        log.error({ msg: "conversation_extraction_error", error: parseErr.message });
        return errorResponse("LLM returned unparseable response", 500);
      }

      if (!extracted.facts?.length) return json({ added: 0, facts: [] });

      const stored: Array<{ id: number; content: string; category: string; is_correction?: boolean }> = [];
      for (const fact of extracted.facts) {
        if (!fact.content?.trim()) continue;

        const isCorrection = !!fact.is_correction;
        const effectiveImportance = isCorrection ? Math.max(fact.importance || 9, 9) : (fact.importance || DEFAULT_IMPORTANCE);
        const effectiveStatic = isCorrection ? 1 : (fact.is_static ? 1 : 0);
        const effectiveTags = fact.tags || [];
        if (isCorrection && !effectiveTags.includes("correction")) effectiveTags.push("correction");

        let embBuffer: Buffer | null = null;
        let embArray: Float32Array | null = null;
        try {
          embArray = await embedWithChunking(fact.content.trim());
          embBuffer = embeddingToBuffer(embArray);
        } catch {}

        const result = insertMemory.get(
          fact.content.trim(), fact.category || category, source, null,
          effectiveImportance, embBuffer,
          1, 1, null, null, 1, effectiveStatic, 0,
          fact.forget_after || null, null, 0, null, auth.user_id, auth.space_id || null
        ) as { id: number; created_at: string };

        const syncId = randomUUID();
        const tagsJson = effectiveTags.length ? JSON.stringify(effectiveTags) : null;
        db.prepare(
          "UPDATE memories SET tags = ?, episode_id = ?, sync_id = ?, confidence = 1.0 WHERE id = ?"
        ).run(tagsJson, episodeId || null, syncId, result.id);

        for (const eid of getOwnedEntityIds(entityIds, auth)) linkMemoryEntity.run(result.id, eid);
        for (const pid of getOwnedProjectIds(projectIds, auth)) linkMemoryProject.run(result.id, pid);

        if (embArray) {
          writeVec(result.id, embArray);
          await autoLink(result.id, embArray, auth.user_id);
        }

        // TODO: async fact extraction for relationship detection
        if (isLocalModelAvailable()) {
          (async () => {
            try {
              const allMems = getCachedEmbeddings(true, auth.user_id);
              const sims: Array<{ id: number; content: string; category: string; score: number }> = [];
              if (embArray) {
                for (const mem of allMems) {
                  if (mem.id === result.id) continue;
                  const sim = cosineSimilarity(embArray, mem.embedding);
                  if (sim > 0.4) sims.push({ id: mem.id, content: mem.content, category: mem.category, score: sim });
                }
                sims.sort((a, b) => b.score - a.score);
              }
              const extraction = await extractFacts(fact.content.trim(), fact.category || category, sims.slice(0, 3));
              if (extraction) {
                if (isCorrection && extraction.relation_to_existing.existing_memory_id && extraction.relation_to_existing.type !== "corrects") {
                  extraction.relation_to_existing.type = "corrects";
                }
                processExtractionResult(result.id, extraction, embArray, auth.user_id);
              }
            } catch (e: any) {
              opsCounters.extraction_failures++;
              log.warn({ msg: "async_extraction_failed", memory_id: result.id, error: e?.message });
            }
          })();
        }

        emitWebhookEvent("memory.created", {
          id: result.id, content: fact.content.trim(), category: fact.category || category,
          importance: effectiveImportance, source: "conversation", is_correction: isCorrection,
        }, auth.user_id);

        stored.push({
          id: result.id,
          content: fact.content.trim(),
          category: fact.category || category,
          is_correction: isCorrection || undefined,
        });
        if (isCorrection) {
          log.info({ msg: "correction_from_conversation", id: result.id, content: fact.content.trim().substring(0, 100) });
        }
      }

      return json({
        added: stored.length,
        facts: stored,
        source: "conversation",
        messages_processed: messages.length,
      });
    } catch (e: any) {
      return safeError("Conversation extraction", e);
    }
  });

  // --------------------------------------------------------------------------
  // POST /ingest - ingest URL content or raw text (LLM fact extraction)
  // --------------------------------------------------------------------------

  router.post("/ingest", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    if (!isLocalModelAvailable()) return errorResponse("LLM not configured - /ingest requires fact extraction", 400);
    try {
      const body = rawBody as any;
      const { url: ingestUrl, text: ingestText, entity_ids, project_ids, episode_id, source } = body;

      if (!ingestUrl && !ingestText) {
        return errorResponse("Provide 'url' (string) or 'text' (string)");
      }

      let rawText = "";
      let ingestSource = source || "ingest";
      let title = "";

      if (ingestUrl) {
        if (typeof ingestUrl !== "string" || !ingestUrl.match(/^https?:\/\//)) {
          return errorResponse("url must be a valid http/https URL");
        }
        try {
          const resp = await safeFetch(ingestUrl, {
            headers: { "User-Agent": "Engram/4.4 (memory ingest)" },
          });
          if (!resp.ok) return errorResponse(`Fetch failed: ${resp.status} ${resp.statusText}`, 502);

          const contentType = resp.headers.get("content-type") || "";
          const raw = await resp.text();

          if (contentType.includes("html")) {
            const titleMatch = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
            title = titleMatch ? titleMatch[1].trim() : new URL(ingestUrl).hostname;

            const extractedText = htmlToText(raw, {
              wordwrap: false,
              selectors: [
                { selector: "script", format: "skip" },
                { selector: "style", format: "skip" },
                { selector: "nav", format: "skip" },
                { selector: "footer", format: "skip" },
                { selector: "header", format: "skip" },
                { selector: "aside", format: "skip" },
              ],
            });
            rawText = extractedText
              .replace(/\n{3,}/g, "\n\n")
              .replace(/ {2,}/g, " ")
              .trim();
          } else {
            rawText = raw.trim();
            title = new URL(ingestUrl).pathname.split("/").pop() || ingestUrl;
          }
          ingestSource = `url:${ingestUrl}`;
        } catch (fetchErr: any) {
          return errorResponse(`Fetch error: ${fetchErr.message}`, 502);
        }
      }

      if (ingestText) {
        if (typeof ingestText !== "string" || ingestText.trim().length === 0) {
          return errorResponse("text must be a non-empty string");
        }
        rawText = ingestText.trim();
        title = body.title || rawText.substring(0, 60).replace(/\n/g, " ");
        ingestSource = source || "text";
      }

      // Chunk document
      const truncated = false;
      const doc = { title, text: rawText, metadata: {}, source: ingestSource };
      const chunked = chunkDocument(doc, { max_chunk_size: 3000, overlap: 200 });
      const chunks = chunked.map((c: any) => c.text);

      const allFacts: Array<{ id: number; content: string; category: string }> = [];
      let chunkNum = 0;

      for (const chunk of chunks) {
        chunkNum++;
        const extractionPrompt = `You are a fact extraction engine. Analyze this text and extract distinct, atomic facts worth remembering long-term.

Source: ${title}${ingestUrl ? ` (${ingestUrl})` : ""}
Chunk ${chunkNum}/${chunks.length}${truncated ? " (document was truncated)" : ""}

Rules:
- Each fact should be ONE self-contained statement. Under 50 words each.
- Skip boilerplate, navigation text, ads, cookie notices, and filler.
- Preserve specific numbers, names, dates, and technical details.
- For each fact, classify:
  - category: task|discovery|decision|state|issue|general
  - importance: 1-10
  - is_static: true if permanent/rarely-changing, false if temporal
  - tags: 2-5 lowercase keyword tags
- If the text has no meaningful facts, return {"facts": []}

Return JSON:
{
  "facts": [
    {
      "content": "extracted fact as a clear statement",
      "category": "discovery",
      "importance": 7,
      "is_static": true,
      "tags": ["keyword1", "keyword2"]
    }
  ]
}`;

        const llmResp = await callLocalModel(extractionPrompt, chunk, { priority: "background" });
        if (!llmResp) continue;

        let extracted: { facts: Array<any> };
        try {
          const cleaned = llmResp.replace(/```json\n?|\n?```/g, "").trim();
          try {
            extracted = JSON.parse(cleaned);
          } catch {
            const jsonMatch = cleaned.match(/\{[\s\S]*"facts"[\s\S]*\}/);
            if (jsonMatch) extracted = JSON.parse(jsonMatch[0]);
            else continue;
          }
        } catch { continue; }

        if (!extracted.facts?.length) continue;

        for (const fact of extracted.facts) {
          if (!fact.content?.trim()) continue;

          let embBuffer: Buffer | null = null;
          let embArray: Float32Array | null = null;
          try {
            embArray = await embedWithChunking(fact.content.trim());
            embBuffer = embeddingToBuffer(embArray);
          } catch {}

          const result = insertMemory.get(
            fact.content.trim(), fact.category || "general", ingestSource, null,
            fact.importance || DEFAULT_IMPORTANCE, embBuffer,
            1, 1, null, null, 1, fact.is_static ? 1 : 0, 0,
            null, null, 0, null, auth.user_id, auth.space_id || null
          ) as { id: number; created_at: string };

          const syncId = randomUUID();
          const tags = fact.tags?.length ? JSON.stringify(fact.tags) : null;
          db.prepare(
            "UPDATE memories SET tags = ?, episode_id = ?, sync_id = ?, confidence = 1.0 WHERE id = ?"
          ).run(tags, episode_id || null, syncId, result.id);

          for (const eid of getOwnedEntityIds(entity_ids, auth)) linkMemoryEntity.run(result.id, eid);
          for (const pid of getOwnedProjectIds(project_ids, auth)) linkMemoryProject.run(result.id, pid);

          if (embArray) {
            writeVec(result.id, embArray);
            await autoLink(result.id, embArray, auth.user_id);
          }

          // TODO: async fact extraction for relationship detection
          if (isLocalModelAvailable()) {
            (async () => {
              try {
                const allMems = getCachedEmbeddings(true, auth.user_id);
                const sims: Array<{ id: number; content: string; category: string; score: number }> = [];
                if (embArray) {
                  for (const mem of allMems) {
                    if (mem.id === result.id) continue;
                    const sim = cosineSimilarity(embArray, mem.embedding);
                    if (sim > 0.4) sims.push({ id: mem.id, content: mem.content, category: mem.category, score: sim });
                  }
                  sims.sort((a, b) => b.score - a.score);
                }
                const extraction = await extractFacts(fact.content.trim(), fact.category || "general", sims.slice(0, 3));
                if (extraction) processExtractionResult(result.id, extraction, embArray, auth.user_id);
              } catch (e: any) {
                opsCounters.extraction_failures++;
                log.warn({ msg: "async_extraction_failed", memory_id: result.id, error: e?.message });
              }
            })();
          }

          emitWebhookEvent("memory.created", {
            id: result.id, content: fact.content.trim(), category: fact.category || "general",
            importance: fact.importance || DEFAULT_IMPORTANCE, source: ingestSource,
          }, auth.user_id);

          allFacts.push({ id: result.id, content: fact.content.trim(), category: fact.category || "general" });
        }
      }

      return json({
        ingested: allFacts.length,
        facts: allFacts,
        source: ingestSource,
        title,
        chunks_processed: chunks.length,
        truncated,
      });
    } catch (e: any) {
      return safeError("Ingest", e);
    }
  });

  // --------------------------------------------------------------------------
  // POST /derive - derive entities/insights from memories (LLM inference)
  // --------------------------------------------------------------------------

  router.post("/derive", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    if (!isLocalModelAvailable()) return errorResponse("LLM not configured - /derive requires inference", 400);
    try {
      const body = rawBody as any;
      const context = body.context || "";
      const limit = Math.min(Number(body.limit || 30), 100);
      const minCluster = Number(body.min_cluster || 3);

      let candidates: any[];
      if (context.trim()) {
        // TODO: hybridSearch integration (import from memory/search.ts at call site)
        const { hybridSearch } = await import("../memory/search.ts");
        candidates = await hybridSearch(context, limit, false, true, true, auth.user_id);
      } else {
        candidates = db.prepare(
          `SELECT id, content, category, importance, tags, created_at
           FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
           ORDER BY COALESCE(decay_score, importance) DESC LIMIT ?`
        ).all(auth.user_id, limit) as any[];
      }

      if (candidates.length < minCluster) {
        return json({ derived: 0, message: `Need at least ${minCluster} memories, found ${candidates.length}` });
      }

      const memoryList = candidates.map((c: any) =>
        `[${c.id}] (${c.category}) ${c.content}`
      ).join("\n");

      const derivePrompt = `You are an inference engine for a memory system. Given a collection of memories, identify patterns, connections, and inferences that are NOT explicitly stated but can be logically derived.

Rules:
- Only derive facts that are NOT already stored - don't repeat existing memories
- Each derived fact must cite which memory IDs it was inferred from (source_ids)
- Confidence should reflect how certain the inference is (0.3-0.9, never 1.0)
- Prefer actionable insights over trivial observations
- Maximum 5 derived facts per batch

Return JSON:
{
  "derived": [
    {
      "content": "inferred fact",
      "category": "discovery",
      "importance": 6,
      "confidence": 0.7,
      "source_ids": [123, 456],
      "reasoning": "brief explanation of the inference"
    }
  ]
}

If no meaningful inferences, return {"derived": []}`;

      const resp = await callLocalModel(derivePrompt, `Here are the memories:\n\n${memoryList}`, { priority: "background" });
      if (!resp) return json({ derived: 0, facts: [] });

      let parsed: { derived: Array<any> };
      try {
        const cleaned = resp.replace(/```json\n?|\n?```/g, "").trim();
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          const jsonMatch = cleaned.match(/\{[\s\S]*"derived"[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          } else {
            log.error({ msg: "derive_parse_error", response: cleaned.substring(0, 500) });
            return json({ derived: 0, facts: [], error: "LLM returned unparseable response" });
          }
        }
      } catch {
        return json({ derived: 0, facts: [], error: "LLM returned unparseable response" });
      }

      if (!parsed.derived?.length) return json({ derived: 0, facts: [] });

      const stored: Array<{ id: number; content: string; confidence: number; source_ids: number[] }> = [];
      for (const d of parsed.derived) {
        if (!d.content?.trim()) continue;

        let embBuffer: Buffer | null = null;
        let embArray: Float32Array | null = null;
        try {
          embArray = await embedWithChunking(d.content.trim());
          embBuffer = embeddingToBuffer(embArray);
        } catch {}

        const { insertLink } = await import("../db/index.ts");
        const result = insertMemory.get(
          d.content.trim(), d.category || "discovery", "derived", null,
          d.importance || 5, embBuffer, 1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
        ) as { id: number; created_at: string };

        const syncId = randomUUID();
        db.prepare(
          "UPDATE memories SET sync_id = ?, confidence = ?, tags = ? WHERE id = ?"
        ).run(syncId, d.confidence || 0.7, JSON.stringify(["derived", ...(d.tags || [])]), result.id);

        if (d.source_ids && Array.isArray(d.source_ids)) {
          for (const srcId of d.source_ids) {
            try { insertLink.run(result.id, srcId, d.confidence || 0.7, "derived_from"); } catch {}
          }
        }

        if (embArray) {
          writeVec(result.id, embArray);
          await autoLink(result.id, embArray, auth.user_id);
        }

        emitWebhookEvent("memory.derived", {
          id: result.id, content: d.content.trim(), confidence: d.confidence,
          source_ids: d.source_ids, reasoning: d.reasoning,
        }, auth.user_id);

        stored.push({
          id: result.id,
          content: d.content.trim(),
          confidence: d.confidence || 0.7,
          source_ids: d.source_ids || [],
        });
      }

      return json({ derived: stored.length, facts: stored });
    } catch (e: any) {
      return safeError("Derive", e);
    }
  });

  // --------------------------------------------------------------------------
  // POST /import/mem0 - import from Mem0 format
  // --------------------------------------------------------------------------

  router.post("/import/mem0", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = rawBody as any;
      const memories = body.memories || body.results || body;
      if (!Array.isArray(memories)) return errorResponse("Expected array of mem0 memories");

      let imported = 0;
      for (const mem of memories) {
        const content = mem.memory || mem.text || mem.content;
        if (!content) continue;

        const category = mem.metadata?.category || mem.category || "general";
        const source = mem.metadata?.source || mem.source || "mem0-import";
        const importance = mem.metadata?.importance || 5;
        const tags = mem.metadata?.tags || ["mem0-import"];

        let embBuffer: Buffer | null = null;
        let embArray: Float32Array | null = null;
        try {
          embArray = await embedWithChunking(content.trim());
          embBuffer = embeddingToBuffer(embArray);
        } catch {}

        const result = insertMemory.get(
          content.trim(), category, source, null, importance, embBuffer,
          1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
        ) as { id: number; created_at: string };

        db.prepare(
          "UPDATE memories SET tags = ?, sync_id = ?, confidence = 1.0 WHERE id = ?"
        ).run(JSON.stringify(tags), randomUUID(), result.id);

        if (embArray) {
          writeVec(result.id, embArray);
          await autoLink(result.id, embArray, auth.user_id);
        }
        imported++;
      }

      return json({ imported, source: "mem0" });
    } catch (e: any) {
      return safeError("Mem0 import", e);
    }
  });

  // --------------------------------------------------------------------------
  // POST /import/supermemory - import from SuperMemory format
  // --------------------------------------------------------------------------

  router.post("/import/supermemory", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = rawBody as any;
      const items = body.documents || body.memories || body.data || (Array.isArray(body) ? body : null);
      if (!items || !Array.isArray(items)) {
        return errorResponse("Expected documents/memories array. Accepted shapes: { documents: [...] }, { memories: [...] }, or raw array");
      }

      let imported = 0, skipped = 0;
      for (const item of items) {
        const content = item.content || item.text || item.description || item.raw;
        if (!content?.trim()) { skipped++; continue; }

        const typeMap: Record<string, string> = {
          note: "general", tweet: "discovery", page: "discovery",
          document: "task", bookmark: "discovery", conversation: "state",
        };
        const category = item.category
          || typeMap[item.type?.toLowerCase()]
          || (item.space?.toLowerCase() === "work" ? "task" : null)
          || "general";

        const tags: string[] = ["supermemory-import"];
        if (item.spaces && Array.isArray(item.spaces)) {
          for (const s of item.spaces) tags.push(String(s).toLowerCase());
        } else if (item.space) {
          tags.push(String(item.space).toLowerCase());
        }
        if (item.tags && Array.isArray(item.tags)) {
          for (const t of item.tags) tags.push(String(t).toLowerCase());
        }
        if (item.type) tags.push(item.type.toLowerCase());

        const importance = item.importance || item.metadata?.importance || 5;
        const source = item.source || item.metadata?.source || "supermemory-import";

        let embBuffer: Buffer | null = null;
        let embArray: Float32Array | null = null;
        try {
          embArray = await embedWithChunking(content.trim());
          embBuffer = embeddingToBuffer(embArray);
        } catch {}

        const result = insertMemory.get(
          content.trim(), category, source, null, importance, embBuffer,
          1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
        ) as { id: number; created_at: string };

        db.prepare(
          "UPDATE memories SET tags = ?, sync_id = ?, confidence = 1.0 WHERE id = ?"
        ).run(JSON.stringify([...new Set(tags)]), randomUUID(), result.id);

        if (embArray) {
          writeVec(result.id, embArray);
          await autoLink(result.id, embArray, auth.user_id);
        }
        imported++;
      }

      return json({ imported, skipped, source: "supermemory" });
    } catch (e: any) {
      return safeError("Supermemory import", e);
    }
  });

  // --------------------------------------------------------------------------
  // POST /import/bulk - async bulk document ingestion pipeline
  // --------------------------------------------------------------------------

  router.post("/import/bulk", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = rawBody as any;
      const { text, url: ingestUrl, format, mode, source, category, project_id, episode_id } = body;

      if (!text && !ingestUrl) {
        return errorResponse("Provide 'text' (string) or 'url' (string)");
      }

      let input: Buffer | string = "";
      let meta: { extension?: string; mime?: string } = {};

      // URL fetching with SSRF protection
      if (ingestUrl) {
        if (typeof ingestUrl !== "string" || !ingestUrl.match(/^https?:\/\//)) {
          return errorResponse("url must be a valid http/https URL");
        }
        try {
          const resp = await safeFetch(ingestUrl, {
            headers: { "User-Agent": "Engram/4.4 (memory ingest)" },
          });
          if (!resp.ok) return errorResponse(`Fetch failed: ${resp.status} ${resp.statusText}`, 502);
          const contentType = resp.headers.get("content-type") || "";
          input = await resp.text();
          meta = { mime: contentType.split(";")[0].trim() };
        } catch (fetchErr: any) {
          return errorResponse(`Fetch error: ${fetchErr.message}`, 502);
        }
      }

      if (text) {
        if (typeof text !== "string" || text.trim().length === 0) {
          return errorResponse("text must be a non-empty string");
        }
        input = text;
      }

      const result = ingestAsync(input, {
        mode: mode || "extract",
        format: format || undefined,
        source: source || "import",
        category: category || "general",
        userId: auth.user_id,
        spaceId: auth.space_id || null,
        projectId: project_id,
        episodeId: episode_id,
      }, meta);

      result.promise.catch((err: any) => {
        log.error({ msg: "bulk_ingest_failed", job_id: result.job_id, error: err.message });
      });

      return json({
        job_id: result.job_id,
        chiasm_task_id: result.chiasm_task_id,
        status: "processing",
        axon_channel: "ingestion",
        subscribe: "/axon/events?channel=ingestion",
      }, 202);
    } catch (e: any) {
      return safeError("import/bulk", e);
    }
  });

  // --------------------------------------------------------------------------
  // POST /import/json - import Engram JSON export format
  // --------------------------------------------------------------------------

  router.post("/import/json", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const body = rawBody as any;
    if (!body || !body.version) return errorResponse("Invalid export format: missing version field", 400);
    if (!body.memories || !Array.isArray(body.memories)) return errorResponse("Invalid export format: missing memories array", 400);

    let imported = { memories: 0, conversations: 0, entities: 0, skipped: 0 };
    const insertImported = db.prepare(`
      INSERT INTO memories (content, category, source, session_id, importance, tags, confidence, is_static, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    for (const m of body.memories) {
      if (!m.content || typeof m.content !== "string") { imported.skipped++; continue; }
      try {
        const tags = Array.isArray(m.tags) ? JSON.stringify(m.tags) : m.tags || null;
        const result = insertImported.get(
          m.content, m.category || "general", m.source || "import", m.session_id || null,
          m.importance || DEFAULT_IMPORTANCE, tags, m.confidence || 1.0, m.is_static ? 1 : 0,
          auth.user_id, m.created_at || new Date().toISOString(), m.updated_at || new Date().toISOString()
        ) as any;
        enqueueJob("post_store", { memory_id: result.id, user_id: auth.user_id }, 3);
        imported.memories++;
      } catch (e: any) {
        log.warn({ msg: "import_memory_failed", error: e.message });
        imported.skipped++;
      }
    }

    if (body.conversations && Array.isArray(body.conversations)) {
      for (const c of body.conversations) {
        try {
          const msgs = Array.isArray(c.messages) ? c.messages : [];
          bulkInsertConvo(
            c.agent || "import", c.session_id || null, c.title || null,
            c.metadata ? JSON.stringify(c.metadata) : null,
            auth.user_id, msgs
          );
          imported.conversations++;
        } catch (e: any) {
          log.warn({ msg: "import_conversation_failed", error: e.message });
        }
      }
    }

    return json({ imported });
  });

}
