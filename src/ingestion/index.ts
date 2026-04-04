// ============================================================================
// Ingestion orchestrator - bulk document ingestion pipeline
// ============================================================================

import { randomUUID } from "node:crypto";
import type { IngestOptions, IngestResult } from "./types.ts";
import { IngestMode } from "./types.ts";
import { detectFormat } from "./detect.ts";
import { chunkDocument } from "./chunker.ts";
import { getParser } from "./parsers/index.ts";
import { rawProcessor } from "./processors/raw.ts";
import { extractProcessor } from "./processors/extract.ts";

export { detectFormat, chunkDocument };

// - Internal helpers --

async function tryCreateChiasmTask(jobId: string): Promise<number> {
  try {
    const { createTask } = await import("../services/chiasm/engine.ts");
    const task = createTask({
      agent: "ingestion",
      project: "engram",
      title: `Bulk ingest job ${jobId}`,
    });
    return task.id;
  } catch {
    return -1;
  }
}

async function tryUpdateChiasmTask(taskId: number, status: string, summary: string): Promise<void> {
  if (taskId < 0) return;
  try {
    const { updateTask } = await import("../services/chiasm/engine.ts");
    updateTask(taskId, { status, summary });
  } catch {}
}

function tryPublishAxon(channel: string, source: string, type: string, payload: Record<string, unknown>): void {
  try {
    // Dynamic import to avoid failing if DB is not initialized
    import("../services/axon/bus.ts").then(({ publish }) => {
      try {
        publish(channel, source, type, payload);
      } catch {}
    }).catch(() => {});
  } catch {}
}

// - Core pipeline --

async function runPipeline(
  input: Buffer | string,
  options: IngestOptions,
  meta: { extension?: string; mime?: string } | undefined,
  jobId: string,
  chiasmTaskId: number,
): Promise<IngestResult> {
  const startMs = Date.now();

  const errors: string[] = [];
  let total_documents = 0;
  let total_chunks = 0;
  let total_memories = 0;

  // Detect format
  const format = options.format ?? detectFormat(input, meta);

  // Get parser
  const parser = getParser(format);
  if (!parser) {
    const msg = `Unsupported format: ${format}`;
    tryPublishAxon("ingestion", "ingestion", "ingest.error", { job_id: jobId, error: msg });
    await tryUpdateChiasmTask(chiasmTaskId, "completed", `Failed: ${msg}`);
    return {
      job_id: jobId,
      chiasm_task_id: chiasmTaskId,
      status: "failed",
      total_documents: 0,
      total_chunks: 0,
      total_memories: 0,
      errors: [msg],
      duration_ms: Date.now() - startMs,
    };
  }

  // Select processor
  const processor = options.mode === IngestMode.Extract ? extractProcessor : rawProcessor;

  // Parse documents
  let docs: Awaited<ReturnType<typeof Array.from<any>>> = [];
  try {
    for await (const doc of parser.parse(input)) {
      docs.push(doc);
    }
  } catch (err: any) {
    const msg = `Parser error: ${err.message}`;
    tryPublishAxon("ingestion", "ingestion", "ingest.error", { job_id: jobId, error: msg });
    await tryUpdateChiasmTask(chiasmTaskId, "completed", `Failed: ${msg}`);
    return {
      job_id: jobId,
      chiasm_task_id: chiasmTaskId,
      status: "failed",
      total_documents: 0,
      total_chunks: 0,
      total_memories: 0,
      errors: [msg],
      duration_ms: Date.now() - startMs,
    };
  }

  total_documents = docs.length;

  // Process each document
  let chunksProcessedSoFar = 0;

  for (const doc of docs) {
    let docChunks: ReturnType<typeof chunkDocument> = [];

    try {
      docChunks = chunkDocument(doc, options.chunkerOptions);
    } catch (err: any) {
      errors.push(`Document "${doc.title}": chunking error: ${err.message}`);
      continue;
    }

    tryPublishAxon("ingestion", "ingestion", "ingest.parsed", {
      job_id: jobId,
      document_title: doc.title,
      chunk_count: docChunks.length,
    });

    total_chunks += docChunks.length;

    // Process in batches, publish progress every 10 chunks
    const processOptions = {
      source: options.source,
      category: options.category,
      userId: options.userId,
      spaceId: options.spaceId,
      projectId: options.projectId,
      episodeId: options.episodeId,
      entityIds: options.entityIds,
    };

    for (let i = 0; i < docChunks.length; i++) {
      const chunk = docChunks[i];

      try {
        const result = await processor.process([chunk], processOptions);
        total_memories += result.memories_created;
        errors.push(...result.errors);
      } catch (err: any) {
        errors.push(`Document "${doc.title}", chunk ${chunk.index}: ${err.message}`);
      }

      chunksProcessedSoFar++;

      if (chunksProcessedSoFar % 10 === 0) {
        tryPublishAxon("ingestion", "ingestion", "ingest.progress", {
          job_id: jobId,
          chunks_done: chunksProcessedSoFar,
          chunks_total: total_chunks,
          memories_created: total_memories,
        });
      }
    }
  }

  const duration_ms = Date.now() - startMs;
  const summary = `Ingested ${total_documents} docs, ${total_chunks} chunks, ${total_memories} memories in ${duration_ms}ms`;

  tryPublishAxon("ingestion", "ingestion", "ingest.completed", {
    job_id: jobId,
    total_documents,
    total_chunks,
    total_memories,
    errors: errors.length,
    duration_ms,
  });

  await tryUpdateChiasmTask(chiasmTaskId, "completed", summary);

  return {
    job_id: jobId,
    chiasm_task_id: chiasmTaskId,
    status: "completed",
    total_documents,
    total_chunks,
    total_memories,
    errors,
    duration_ms,
  };
}

// - Public API --

export function ingestAsync(
  input: Buffer | string,
  options: IngestOptions,
  meta?: { extension?: string; mime?: string },
): {
  job_id: string;
  chiasm_task_id: number;
  promise: Promise<IngestResult>;
} {
  const job_id = "ingest_" + randomUUID().slice(0, 8);

  // Chiasm task creation is non-fatal; start it synchronously via a resolved promise chain
  // but we need to return the shape synchronously - use -1 as placeholder until task is created.
  // We kick off task creation in the background and thread the real ID into the pipeline.

  let chiasm_task_id = -1;

  const promise = (async () => {
    // Try to create Chiasm task (non-fatal)
    chiasm_task_id = await tryCreateChiasmTask(job_id);

    tryPublishAxon("ingestion", "ingestion", "ingest.started", {
      job_id,
      chiasm_task_id,
      source: options.source,
      format: options.format ?? "auto",
      mode: options.mode,
    });

    return runPipeline(input, options, meta, job_id, chiasm_task_id);
  })();

  // Return the synchronous shape. chiasm_task_id will be -1 here (async task creation
  // hasn't resolved yet), which is the documented fallback behavior when DB is unavailable.
  return {
    job_id,
    chiasm_task_id,
    promise,
  };
}

export async function ingest(
  input: Buffer | string,
  options: IngestOptions,
  meta?: { extension?: string; mime?: string },
): Promise<IngestResult> {
  return ingestAsync(input, options, meta).promise;
}
