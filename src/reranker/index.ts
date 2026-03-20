// ============================================================================
// CROSS-ENCODER RERANKER - ONNX-based for search result re-ranking
// Model: bge-reranker-base (XLM-RoBERTa, SentencePiece tokenizer)
// ONNX inference runs in a dedicated Worker thread to avoid blocking the
// main event loop.
// ============================================================================

import { Worker } from "worker_threads";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, createWriteStream, renameSync, statSync } from "fs";
import { RERANKER_TOP_K } from "../config/index.ts";
import { log } from "../config/logger.ts";

// Config - co-located here to avoid circular deps and keep the module self-contained
const DATA_DIR = process.env.ENGRAM_DATA_DIR
  ? resolve(process.env.ENGRAM_DATA_DIR)
  : resolve(import.meta.dirname || ".", "../../data");
export const CROSS_ENCODER_ENABLED = process.env.ENGRAM_CROSS_ENCODER !== "0";
const CROSS_ENCODER_DIR = resolve(DATA_DIR, "models", "bge-reranker-base");
const CROSS_ENCODER_MAX_SEQ = Number(process.env.ENGRAM_RERANKER_MAX_SEQ || 512);
const CROSS_ENCODER_FP32 = process.env.ENGRAM_RERANKER_FP32 === "1";
const CROSS_ENCODER_ONNX = CROSS_ENCODER_FP32 ? "model.onnx" : "model_quantized.onnx";
const CROSS_ENCODER_URLS: Record<string, string> = {
  "tokenizer.json": "https://huggingface.co/Xenova/bge-reranker-base/resolve/main/tokenizer.json",
  "model_quantized.onnx": "https://huggingface.co/Xenova/bge-reranker-base/resolve/main/onnx/model_quantized.onnx",
  "model.onnx": "https://huggingface.co/Xenova/bge-reranker-base/resolve/main/onnx/model.onnx",
};

// ============================================================================
// WORKER THREAD STATE
// ============================================================================

let rerankerWorker: Worker | null = null;
let workerReady = false;
let workerRequestId = 0;
const workerPending = new Map<number, { resolve: (scores: number[]) => void; reject: (e: Error) => void }>();

// ============================================================================
// MODEL DOWNLOAD
// ============================================================================

async function ensureRerankerFiles(): Promise<void> {
  mkdirSync(CROSS_ENCODER_DIR, { recursive: true });
  for (const file of ["tokenizer.json", CROSS_ENCODER_ONNX]) {
    const dest = resolve(CROSS_ENCODER_DIR, file);
    if (existsSync(dest)) continue;
    const url = CROSS_ENCODER_URLS[file];
    if (!url) throw new Error(`No URL for reranker file: ${file}`);
    log.info({ msg: "downloading_reranker_file", file, url });
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Failed to download ${file}: ${res.status}`);
    const tmp = dest + ".tmp";
    const ws = createWriteStream(tmp);
    // @ts-ignore - Node 22 ReadableStream
    for await (const chunk of res.body) ws.write(Buffer.from(chunk));
    await new Promise<void>((ok, fail) => { ws.end(() => ok()); ws.on("error", fail); });
    renameSync(tmp, dest);
    log.info({ msg: "downloaded_reranker_file", file, size_mb: Math.round(statSync(dest).size / 1048576) });
  }
}

function spawnRerankerWorker(): Promise<void> {
  return new Promise((resolveInit, rejectInit) => {
    const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "reranker-worker.ts");
    rerankerWorker = new Worker(workerPath, {
      workerData: {
        modelDir: CROSS_ENCODER_DIR,
        onnxModelFile: CROSS_ENCODER_ONNX,
        maxSeq: CROSS_ENCODER_MAX_SEQ,
        intraOpNumThreads: 4,
      },
      execArgv: process.execArgv,
    });

    rerankerWorker.on("message", (msg: any) => {
      if (msg.type === "ready") {
        workerReady = true;
        log.info({ msg: "reranker_worker_ready" });
        resolveInit();
        return;
      }
      if (msg.type === "error") {
        rejectInit(new Error(`Reranker worker init failed: ${msg.error}`));
        return;
      }
      // Response to a rerank request
      const pending = workerPending.get(msg.id);
      if (!pending) return;
      workerPending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.scores as number[]);
      }
    });

    rerankerWorker.on("error", (err) => {
      log.error({ msg: "reranker_worker_error", error: err.message });
      for (const [id, p] of workerPending) {
        p.reject(new Error(`Reranker worker error: ${err.message}`));
        workerPending.delete(id);
      }
    });

    rerankerWorker.on("exit", (code) => {
      log.warn({ msg: "reranker_worker_exited", code });
      workerReady = false;
      rerankerWorker = null;
      for (const [id, p] of workerPending) {
        p.reject(new Error(`Reranker worker exited with code ${code}`));
        workerPending.delete(id);
      }
    });
  });
}

async function scoreDocuments(query: string, documents: string[]): Promise<number[]> {
  if (!rerankerWorker || !workerReady) throw new Error("Reranker worker not initialized");
  if (documents.length === 0) return [];
  const id = ++workerRequestId;
  return new Promise<number[]>((resolve, reject) => {
    // 15s timeout - if scoring can't finish in 15s, fallback ordering is better than blocking
    const timer = setTimeout(() => {
      workerPending.delete(id);
      reject(new Error("Reranker worker timeout (15s)"));
    }, 15_000);
    workerPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    rerankerWorker!.postMessage({ id, query, documents });
  });
}

// ============================================================================
// INIT / STATUS
// ============================================================================

export async function initReranker(): Promise<void> {
  if (!CROSS_ENCODER_ENABLED) {
    log.info({ msg: "cross_encoder_disabled" });
    return;
  }
  try {
    const t0 = Date.now();
    log.info({ msg: "loading_cross_encoder", model: "bge-reranker-base" });
    await ensureRerankerFiles();
    await spawnRerankerWorker();
    log.info({ msg: "cross_encoder_loaded", mode: "worker_thread", ms: Date.now() - t0 });
  } catch (e: any) {
    log.error({ msg: "cross_encoder_init_failed", error: e.message });
    rerankerWorker = null;
    workerReady = false;
  }
}

export function isRerankerReady(): boolean {
  return rerankerWorker !== null && workerReady;
}

// ============================================================================
// BATCH RERANKING
// ============================================================================

export async function crossEncoderRerank<T extends { id: number; content: string; score: number; [k: string]: any }>(
  query: string,
  candidates: T[],
  topK?: number,
): Promise<T[]> {
  if (!isRerankerReady() || candidates.length <= 1) return candidates;

  const k = topK ?? RERANKER_TOP_K;
  const toRerank = candidates.slice(0, Math.min(k, candidates.length));
  const rest = candidates.slice(k);

  const t0 = Date.now();
  let batchScores: number[] = [];

  try {
    const documents = toRerank.map(c => c.content);
    batchScores = await scoreDocuments(query, documents);
  } catch (e: any) {
    log.warn({ msg: "reranker_worker_fallback", error: e.message });
    // Fallback: return candidates unchanged if worker fails
    return candidates;
  }

  const scored = batchScores.map((ceScore, index) => ({ index, ceScore }));
  scored.sort((a, b) => b.ceScore - a.ceScore);
  const rerankerMs = Date.now() - t0;
  const candidateCount = Math.max(
    candidates[0]?.candidate_count ?? 0,
    candidates.length,
  );

  const reranked: T[] = [];
  for (let rank = 0; rank < scored.length; rank++) {
    const { index, ceScore } = scored[rank];
    const item = { ...toRerank[index] };
    item.score = item.score * (1 + (scored.length - rank) / scored.length * 0.5);
    (item as any).ce_score = ceScore;
    (item as any).reranked = true;
    (item as any).reranker_ms = rerankerMs;
    (item as any).candidate_count = candidateCount;
    reranked.push(item);
  }
  reranked.push(...rest.map(item => ({
    ...item,
    reranked: true,
    reranker_ms: rerankerMs,
    candidate_count: candidateCount,
  })));

  log.debug({ msg: "cross_encoder_rerank", candidates: toRerank.length, ms: rerankerMs });
  return reranked;
}

export function getRerankerDiagnostics<T extends { candidate_count?: number; reranker_ms?: number; reranked?: boolean }>(
  results: T[],
): { reranked: boolean; reranker_ms: number; candidate_count: number } {
  if (results.length === 0) {
    return { reranked: false, reranker_ms: 0, candidate_count: 0 };
  }
  return {
    reranked: results.some(r => r.reranked === true),
    reranker_ms: Math.max(...results.map(r => r.reranker_ms || 0)),
    candidate_count: Math.max(...results.map(r => r.candidate_count || 0), results.length),
  };
}
