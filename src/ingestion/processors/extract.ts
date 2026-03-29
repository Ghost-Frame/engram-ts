// Extract processor: sends each chunk through LLM extraction before storing.
// Integration tests require a running Engram instance (LLM + embedding provider + DB initialized).

import type { Chunk, Processor, ProcessOptions, ProcessResult } from "../types.ts";
import { callLLM } from "../../llm/index.ts";
import { embedWithChunking, embeddingToBuffer } from "../../embeddings/index.ts";
import { db } from "../../db/index.ts";
import { checkSimHashDuplicate, storeSimHash } from "../../memory/simhash.ts";
import { enqueueJob } from "../../jobs/index.ts";

export const extractProcessor: Processor = {
  name: "extract",
  async process(chunks: Chunk[], options: ProcessOptions): Promise<ProcessResult> {
    let memories_created = 0;
    const errors: string[] = [];

    for (const chunk of chunks) {
      try {
        // Build extraction prompt
        const extractionPrompt = `You are a fact extraction engine. Analyze this text and extract distinct, atomic facts worth remembering long-term.

Source: ${chunk.document_title} (${chunk.source})
Chunk ${chunk.index + 1}/${chunk.total}

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

        const llmResp = await callLLM(extractionPrompt, chunk.text);
        if (!llmResp) { errors.push(`Chunk ${chunk.index}: LLM returned empty`); continue; }

        // Parse LLM response
        let extracted: { facts: Array<any> };
        try {
          const cleaned = llmResp.replace(/```json\n?|\n?```/g, "").trim();
          try {
            extracted = JSON.parse(cleaned);
          } catch {
            const jsonMatch = cleaned.match(/\{[\s\S]*"facts"[\s\S]*\}/);
            if (jsonMatch) extracted = JSON.parse(jsonMatch[0]);
            else { errors.push(`Chunk ${chunk.index}: failed to parse LLM JSON`); continue; }
          }
        } catch { errors.push(`Chunk ${chunk.index}: JSON parse error`); continue; }

        if (!extracted.facts?.length) continue;

        // Store each extracted fact as a memory
        for (const fact of extracted.facts) {
          if (!fact.content?.trim()) continue;
          try {
            const content = fact.content.trim();
            const embArray = await embedWithChunking(content);
            if (!embArray) continue;
            const embBuffer = embeddingToBuffer(embArray);

            const dupResult = checkSimHashDuplicate(content, options.userId);
            if (dupResult.isDuplicate) continue;

            const category = fact.category || options.category;
            const importance = Math.min(10, Math.max(1, fact.importance || 5));

            const result = db.prepare(
              `INSERT INTO memories (content, category, source, importance, embedding, is_static, user_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')) RETURNING id, created_at`
            ).get(content, category, options.source, importance, embBuffer, fact.is_static ? 1 : 0, options.userId) as any;

            if (!result?.id) continue;

            // Store SimHash (second arg is the simhash string)
            storeSimHash(result.id, dupResult.simhash);

            const embBase64 = Buffer.from(embArray.buffer, embArray.byteOffset, embArray.byteLength).toString("base64");
            enqueueJob("post_store", {
              memoryId: result.id,
              content,
              category,
              userId: options.userId,
              importance,
              embeddingBase64: embBase64,
            });

            memories_created++;
          } catch (factErr: any) {
            errors.push(`Chunk ${chunk.index}, fact: ${factErr.message}`);
          }
        }
      } catch (err: any) {
        errors.push(`Chunk ${chunk.index}: ${err.message}`);
      }
    }

    return { memories_created, errors };
  },
};
