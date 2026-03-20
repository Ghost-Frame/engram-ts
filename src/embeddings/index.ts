// ============================================================================
// EMBEDDINGS -- Pluggable providers: local ONNX, Google AI Studio, Vertex AI
// Provider selected via ENGRAM_EMBEDDING_PROVIDER env var
// ============================================================================

import {
  EMBEDDING_PROVIDER, EMBEDDING_MODEL, EMBEDDING_DIM, EMBEDDING_MAX_SEQ,
  MODEL_DIR, ONNX_MODEL_FILE, MODEL_URLS,
  GOOGLE_API_KEY, GOOGLE_CLOUD_LOCATION,
} from "../config/index.ts";
import { log, opsCounters } from "../config/logger.ts";
import { db, writeVec, updateEpisodeVec } from "../db/index.ts";
import { getVertexAccessToken, getProjectId } from "../auth/google-auth.ts";

// ============================================================================
// GOOGLE AI STUDIO EMBEDDINGS (API key auth)
// ============================================================================

async function googleEmbed(text: string): Promise<Float32Array> {
  const apiKey = GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY required for google embedding provider");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIM,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Google embedding failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as { embedding: { values: number[] } };
  const vec = new Float32Array(data.embedding.values);

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;

  return vec;
}

// ============================================================================
// VERTEX AI EMBEDDINGS (OAuth2 service account auth)
// ============================================================================

async function vertexEmbed(text: string): Promise<Float32Array> {
  const token = await getVertexAccessToken();
  const project = getProjectId();
  if (!project) throw new Error("GOOGLE_CLOUD_PROJECT required for vertex embedding provider");

  const url = `https://${GOOGLE_CLOUD_LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${GOOGLE_CLOUD_LOCATION}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      instances: [{ content: text }],
      parameters: { outputDimensionality: EMBEDDING_DIM },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Vertex AI embedding failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as { predictions: Array<{ embeddings: { values: number[] } }> };
  const values = data.predictions[0].embeddings.values;
  const vec = new Float32Array(values);

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;

  return vec;
}

// ============================================================================
// LOCAL ONNX EMBEDDINGS -- Worker thread implementation
// ONNX inference runs in a dedicated Worker thread to avoid blocking the
// main event loop. The main thread sends text, the worker returns Float32Array.
// ============================================================================

import { Worker } from "worker_threads";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, statSync, mkdirSync, createWriteStream, renameSync } from "fs";

// Worker thread state
let embeddingWorker: Worker | null = null;
let workerReady = false;
let workerRequestId = 0;
const workerPending = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>();

// Prepared statements for cache refresh
const getAllEmbeddings = db.prepare(
  `SELECT id, user_id, content, category, importance, embedding, is_static, source_count, is_latest, is_forgotten
   FROM memories WHERE embedding IS NOT NULL AND is_archived = 0`
);
const getAllEpisodeEmbeddings = db.prepare(
  `SELECT id, user_id, summary, embedding FROM episodes WHERE embedding IS NOT NULL`
);

async function ensureModelFiles(): Promise<void> {
  mkdirSync(MODEL_DIR, { recursive: true });
  const needed = ["tokenizer.json", ONNX_MODEL_FILE];
  for (const file of needed) {
    const dest = resolve(MODEL_DIR, file);
    if (existsSync(dest)) continue;
    const url = MODEL_URLS[file];
    log.info({ msg: "downloading_model_file", file, url });
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Failed to download ${file}: ${res.status}`);
    const tmp = dest + ".tmp";
    const ws = createWriteStream(tmp);
    // @ts-ignore -- Node 22 ReadableStream
    for await (const chunk of res.body) ws.write(Buffer.from(chunk));
    await new Promise<void>((ok, fail) => { ws.end(() => ok()); ws.on("error", fail); });
    renameSync(tmp, dest);
    log.info({ msg: "downloaded_model_file", file, size_mb: Math.round(statSync(dest).size / 1048576) });
  }
}

function spawnEmbeddingWorker(): Promise<void> {
  return new Promise((resolveInit, rejectInit) => {
    // Worker file lives next to this module
    const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "embedding-worker.ts");
    embeddingWorker = new Worker(workerPath, {
      workerData: {
        modelDir: MODEL_DIR,
        onnxModelFile: ONNX_MODEL_FILE,
        embeddingDim: EMBEDDING_DIM,
        embeddingMaxSeq: EMBEDDING_MAX_SEQ,
        intraOpNumThreads: 4,
      },
      // Inherit --experimental-strip-types so worker can load .ts files
      execArgv: process.execArgv,
    });

    embeddingWorker.on("message", (msg: any) => {
      if (msg.type === "ready") {
        workerReady = true;
        log.info({ msg: "embedding_worker_ready" });
        resolveInit();
        return;
      }
      if (msg.type === "error") {
        rejectInit(new Error(`Embedding worker init failed: ${msg.error}`));
        return;
      }
      // Response to an embed request
      const pending = workerPending.get(msg.id);
      if (!pending) return;
      workerPending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(new Float32Array(msg.result));
      }
    });

    embeddingWorker.on("error", (err) => {
      log.error({ msg: "embedding_worker_error", error: err.message });
      // Reject all pending requests
      for (const [id, p] of workerPending) {
        p.reject(new Error(`Worker error: ${err.message}`));
        workerPending.delete(id);
      }
    });

    embeddingWorker.on("exit", (code) => {
      log.warn({ msg: "embedding_worker_exited", code });
      workerReady = false;
      embeddingWorker = null;
      // Reject all pending requests
      for (const [id, p] of workerPending) {
        p.reject(new Error(`Worker exited with code ${code}`));
        workerPending.delete(id);
      }
    });
  });
}

async function localEmbed(text: string): Promise<Float32Array> {
  if (!embeddingWorker || !workerReady) throw new Error("Embedding worker not initialized");
  const id = ++workerRequestId;
  return new Promise<Float32Array>((resolve, reject) => {
    // 30s timeout per embedding request
    const timer = setTimeout(() => {
      workerPending.delete(id);
      reject(new Error("Embedding worker timeout (30s)"));
    }, 30_000);
    workerPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    embeddingWorker!.postMessage({ id, text });
  });
}

// ============================================================================
// PUBLIC API -- Provider dispatcher
// ============================================================================

export async function initEmbedder(): Promise<void> {
  if (EMBEDDING_PROVIDER === "local") {
    const start = Date.now();
    log.info({ msg: "loading_embedding_model", provider: "local", model: EMBEDDING_MODEL, file: ONNX_MODEL_FILE, mode: "worker_thread" });
    await ensureModelFiles();
    await spawnEmbeddingWorker();
    log.info({ msg: "embedding_model_loaded", provider: "local", model: EMBEDDING_MODEL, dim: EMBEDDING_DIM, mode: "worker_thread", ms: Date.now() - start });
  } else if (EMBEDDING_PROVIDER === "google") {
    if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY required for 'google' embedding provider");
    // Warmup call
    const t0 = Date.now();
    await googleEmbed("warmup");
    log.info({ msg: "embedding_provider_ready", provider: "google", model: EMBEDDING_MODEL, dim: EMBEDDING_DIM, warmup_ms: Date.now() - t0 });
  } else if (EMBEDDING_PROVIDER === "vertex") {
    if (!getProjectId()) {
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CLOUD_PROJECT required for 'vertex' embedding provider");
    }
    // Warmup: get token + embed
    const t0 = Date.now();
    await vertexEmbed("warmup");
    log.info({ msg: "embedding_provider_ready", provider: "vertex", model: EMBEDDING_MODEL, dim: EMBEDDING_DIM, project: getProjectId(), warmup_ms: Date.now() - t0 });
  } else {
    throw new Error(`Unknown embedding provider: ${EMBEDDING_PROVIDER}`);
  }
}

export async function embed(text: string): Promise<Float32Array> {
  switch (EMBEDDING_PROVIDER) {
    case "local": return localEmbed(text);
    case "google": return googleEmbed(text);
    case "vertex": return vertexEmbed(text);
    default: throw new Error(`Unknown embedding provider: ${EMBEDDING_PROVIDER}`);
  }
}

export function getEmbeddingProviderInfo(): { provider: string; model: string; dim: number } {
  return { provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL, dim: EMBEDDING_DIM };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ============================================================================
// IN-MEMORY EMBEDDING CACHE
// ============================================================================

interface CachedMem {
  id: number; user_id: number; content: string; category: string; importance: number;
  embedding: Float32Array; is_static: boolean; source_count: number;
  is_latest?: boolean; is_forgotten?: boolean; source?: string;
}
let embeddingCache: CachedMem[] = [];
export let embeddingCacheLatest: CachedMem[] = [];
let embeddingCacheVersion = 0;
export let graphCache: { key: string; data: any; ts: number } | null = null;
export function setGraphCache(val: typeof graphCache): void { graphCache = val; }

// Episode embedding cache
interface CachedEpisode {
  id: number; user_id: number; summary: string; embedding: Float32Array;
}
export let episodeCache: CachedEpisode[] = [];

export function refreshEmbeddingCache(): void {
  const t0 = Date.now();
  const allRows = getAllEmbeddings.all() as Array<any>;
  embeddingCache = [];
  embeddingCacheLatest = [];
  for (const row of allRows) {
    if (!row.embedding) continue;
    const mem: CachedMem = {
      id: row.id, user_id: row.user_id, content: row.content, category: row.category,
      importance: row.importance, embedding: bufferToEmbedding(row.embedding),
      is_static: !!row.is_static, source_count: row.source_count || 1,
      is_latest: !!row.is_latest, is_forgotten: !!row.is_forgotten,
      source: row.source || undefined,
    };
    embeddingCache.push(mem);
    if (row.is_latest && !row.is_forgotten) embeddingCacheLatest.push(mem);
  }
  // Load episode embeddings
  episodeCache = [];
  try {
    const epRows = getAllEpisodeEmbeddings.all() as Array<any>;
    for (const row of epRows) {
      if (!row.embedding) continue;
      episodeCache.push({
        id: row.id, user_id: row.user_id, summary: row.summary || "",
        embedding: bufferToEmbedding(row.embedding),
      });
    }
  } catch {}

  embeddingCacheVersion++;
  log.info({ msg: "embedding_cache_refreshed", total: embeddingCache.length, latest: embeddingCacheLatest.length, episodes: episodeCache.length, ms: Date.now() - t0 });
}

export function getCachedEmbeddings(latestOnly: boolean, userId?: number): CachedMem[] {
  const rows = latestOnly ? embeddingCacheLatest : embeddingCache;
  return userId == null ? rows : rows.filter(mem => mem.user_id === userId);
}

export function addToEmbeddingCache(mem: CachedMem): void {
  embeddingCache.push(mem);
  if (mem.is_latest && !mem.is_forgotten) embeddingCacheLatest.push(mem);
}

export function invalidateEmbeddingCache(): void {
  refreshEmbeddingCache();
}

export function embeddingToBuffer(emb: Float32Array): Buffer {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
}

export function bufferToEmbedding(buf: Buffer | Uint8Array | ArrayBuffer): Float32Array {
  if (buf instanceof ArrayBuffer) return new Float32Array(buf);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function embeddingToVectorJSON(emb: Float32Array): string {
  return "[" + Array.from(emb).join(",") + "]";
}

// ============================================================================
// RE-EMBED ALL MEMORIES (for provider/model migration)
// ============================================================================

export async function reembedAll(
  onProgress?: (done: number, total: number) => void
): Promise<{ reembedded: number; failed: number; elapsed_ms: number }> {
  const t0 = Date.now();
  const allMems = db.prepare(
    "SELECT id, content FROM memories WHERE content IS NOT NULL AND content != '' ORDER BY id"
  ).all() as Array<{ id: number; content: string }>;

  const allEpisodes = db.prepare(
    "SELECT id, summary FROM episodes WHERE summary IS NOT NULL AND summary != '' ORDER BY id"
  ).all() as Array<{ id: number; summary: string }>;

  const total = allMems.length + allEpisodes.length;
  let done = 0;
  let failed = 0;

  const updateMemEmb = db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");
  const updateEpEmb = db.prepare("UPDATE episodes SET embedding = ? WHERE id = ?");

  // Re-embed memories in batches
  for (const mem of allMems) {
    try {
      const emb = await embed(mem.content.substring(0, 8192));
      updateMemEmb.run(embeddingToBuffer(emb), mem.id);
      writeVec(mem.id, emb);
    } catch (e: any) {
      log.warn({ msg: "reembed_failed", type: "memory", id: mem.id, error: e.message });
      failed++;
    }
    done++;
    if (onProgress && done % 50 === 0) onProgress(done, total);
  }

  // Re-embed episodes
  for (const ep of allEpisodes) {
    try {
      const emb = await embed(ep.summary.substring(0, 8192));
      updateEpEmb.run(embeddingToBuffer(emb), ep.id);
      try { updateEpisodeVec.run(embeddingToVectorJSON(emb), ep.id); } catch (e: any) {
        opsCounters.vec_write_failures++;
        log.warn({ msg: "episode_vec_write_failed", id: ep.id, error: e?.message });
      }
    } catch (e: any) {
      log.warn({ msg: "reembed_failed", type: "episode", id: ep.id, error: e.message });
      failed++;
    }
    done++;
    if (onProgress && done % 50 === 0) onProgress(done, total);
  }

  // Refresh cache
  refreshEmbeddingCache();

  const elapsed = Date.now() - t0;
  log.info({ msg: "reembed_complete", reembedded: done - failed, failed, total, elapsed_ms: elapsed });
  return { reembedded: done - failed, failed, elapsed_ms: elapsed };
}
