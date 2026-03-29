// Raw processor: stores each chunk directly as a memory.
// Integration tests require a running Engram instance (embedding provider + DB initialized).

import type { Chunk, Processor, ProcessOptions, ProcessResult } from "../types.ts";
import { embedWithChunking, embeddingToBuffer } from "../../embeddings/index.ts";
import { db } from "../../db/index.ts";
import { checkSimHashDuplicate, storeSimHash } from "../../memory/simhash.ts";
import { enqueueJob } from "../../jobs/index.ts";

export const rawProcessor: Processor = {
  name: "raw",
  async process(chunks: Chunk[], options: ProcessOptions): Promise<ProcessResult> {
    let memories_created = 0;
    const errors: string[] = [];

    for (const chunk of chunks) {
      try {
        const content = chunk.text.trim();
        if (!content) { errors.push(`Chunk ${chunk.index}: empty after trim`); continue; }

        // Embed
        const embArray = await embedWithChunking(content);
        if (!embArray) { errors.push(`Chunk ${chunk.index}: embedding failed`); continue; }
        const embBuffer = embeddingToBuffer(embArray);

        // SimHash dedup check
        const dupResult = checkSimHashDuplicate(content, options.userId);
        if (dupResult.isDuplicate) { errors.push(`Chunk ${chunk.index}: duplicate detected`); continue; }

        // Insert memory
        const result = db.prepare(
          `INSERT INTO memories (content, category, source, importance, embedding, user_id, created_at, updated_at)
           VALUES (?, ?, ?, 5, ?, ?, datetime('now'), datetime('now')) RETURNING id, created_at`
        ).get(content, options.category, options.source, embBuffer, options.userId) as any;

        if (!result?.id) { errors.push(`Chunk ${chunk.index}: insert failed`); continue; }

        // Store SimHash (second arg is the simhash string, not content)
        storeSimHash(result.id, dupResult.simhash);

        // Enqueue post-store pipeline
        const embBase64 = Buffer.from(embArray.buffer, embArray.byteOffset, embArray.byteLength).toString("base64");
        enqueueJob("post_store", {
          memoryId: result.id,
          content,
          category: options.category,
          userId: options.userId,
          importance: 5,
          embeddingBase64: embBase64,
        });

        memories_created++;
      } catch (err: any) {
        errors.push(`Chunk ${chunk.index}: ${err.message}`);
      }
    }

    return { memories_created, errors };
  },
};
