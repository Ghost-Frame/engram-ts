// ============================================================================
// CROSS-ENCODER RERANKER - ONNX-based for search result re-ranking
// Model: bge-reranker-base (XLM-RoBERTa, SentencePiece tokenizer)
// ============================================================================

import * as ort from "onnxruntime-node";
import { resolve } from "path";
import { readFileSync, existsSync, mkdirSync, createWriteStream, renameSync, statSync } from "fs";
import { RERANKER_TOP_K } from "../config/index.ts";
import { log } from "../config/logger.ts";

// Config - co-located here to avoid circular deps and keep the module self-contained
const DATA_DIR = process.env.ENGRAM_DATA_DIR
  ? resolve(process.env.ENGRAM_DATA_DIR)
  : resolve(import.meta.dirname || ".", "../../data");
export const CROSS_ENCODER_ENABLED = process.env.ENGRAM_CROSS_ENCODER !== "0";
const CROSS_ENCODER_DIR = resolve(DATA_DIR, "models", "bge-reranker-base");
const CROSS_ENCODER_MAX_SEQ = 512;
const CROSS_ENCODER_FP32 = process.env.ENGRAM_RERANKER_FP32 === "1";
const CROSS_ENCODER_ONNX = CROSS_ENCODER_FP32 ? "model.onnx" : "model_quantized.onnx";
const CROSS_ENCODER_URLS: Record<string, string> = {
  "tokenizer.json": "https://huggingface.co/Xenova/bge-reranker-base/resolve/main/tokenizer.json",
  "model_quantized.onnx": "https://huggingface.co/Xenova/bge-reranker-base/resolve/main/onnx/model_quantized.onnx",
  "model.onnx": "https://huggingface.co/Xenova/bge-reranker-base/resolve/main/onnx/model.onnx",
};

let session: ort.InferenceSession | null = null;
let tok: SentencePieceTokenizer | null = null;
let hasTokenTypeIds = false;

// ============================================================================
// TOKENIZER (SentencePiece-style, zero deps)
// ============================================================================

class SentencePieceTokenizer {
  private vocab: Map<string, number>;
  private unigramScores: Map<string, number>;
  private unigramByFirstChar: Map<string, string[]>;
  private mergeRanks: Map<string, number>;
  private bosId: number;
  private eosId: number;
  private unkId: number;
  private modelType: "bpe" | "unigram";

  constructor(path: string) {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const model = raw.model;
    this.vocab = new Map();
    this.unigramScores = new Map();
    this.unigramByFirstChar = new Map();
    this.mergeRanks = new Map();

    if (model.type === "Unigram") {
      this.modelType = "unigram";
      const vocabEntries = model.vocab as Array<[string, number]>;
      for (let i = 0; i < vocabEntries.length; i++) {
        const [token, score] = vocabEntries[i];
        this.vocab.set(token, i);
        this.unigramScores.set(token, Number(score) || 0);
        if (!token || token.startsWith("<")) continue;
        const first = token[0];
        const bucket = this.unigramByFirstChar.get(first) || [];
        bucket.push(token);
        this.unigramByFirstChar.set(first, bucket);
      }
      for (const bucket of this.unigramByFirstChar.values()) {
        bucket.sort((a, b) => b.length - a.length);
      }
      this.unkId = model.unk_id ?? 3;
    } else {
      this.modelType = "bpe";
      this.vocab = new Map(Object.entries(model.vocab) as [string, number][]);
      if (model.merges) {
        for (let i = 0; i < model.merges.length; i++) {
          this.mergeRanks.set(model.merges[i], i);
        }
      }
      this.unkId = this.vocab.get("<unk>") ?? 3;
    }

    this.bosId = this.vocab.get("<s>") ?? 0;
    this.eosId = this.vocab.get("</s>") ?? 2;
  }

  private bpe(symbols: string[]): string[] {
    if (symbols.length <= 1) return symbols;
    while (true) {
      let bestRank = Infinity;
      let bestIdx = -1;
      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.mergeRanks.get(symbols[i] + " " + symbols[i + 1]);
        if (rank !== undefined && rank < bestRank) { bestRank = rank; bestIdx = i; }
      }
      if (bestIdx === -1) break;
      const merged = symbols[bestIdx] + symbols[bestIdx + 1];
      const next: string[] = [];
      let i = 0;
      while (i < symbols.length) {
        if (i === bestIdx) { next.push(merged); i += 2; }
        else { next.push(symbols[i]); i++; }
      }
      symbols = next;
    }
    return symbols;
  }

  private tokenizeUnigram(text: string): number[] {
    const best = new Float64Array(text.length + 1);
    best.fill(Number.NEGATIVE_INFINITY);
    best[text.length] = 0;

    const nextId = new Int32Array(text.length + 1);
    const nextLen = new Int32Array(text.length + 1);

    for (let i = text.length - 1; i >= 0; i--) {
      const first = text[i];
      const bucket = this.unigramByFirstChar.get(first) || [];
      let bestScore = Number.NEGATIVE_INFINITY;
      let bestTokenId = this.unkId;
      let bestTokenLen = 1;

      for (const token of bucket) {
        if (!text.startsWith(token, i)) continue;
        const tokenId = this.vocab.get(token);
        if (tokenId == null) continue;
        const nextIndex = i + token.length;
        if (best[nextIndex] === Number.NEGATIVE_INFINITY) continue;
        const score = (this.unigramScores.get(token) ?? -20) + best[nextIndex];
        if (score > bestScore) {
          bestScore = score;
          bestTokenId = tokenId;
          bestTokenLen = token.length;
        }
      }

      if (bestScore === Number.NEGATIVE_INFINITY) {
        best[i] = (this.unigramScores.get("<unk>") ?? -20) + best[i + 1];
        nextId[i] = this.unkId;
        nextLen[i] = 1;
      } else {
        best[i] = bestScore;
        nextId[i] = bestTokenId;
        nextLen[i] = bestTokenLen;
      }
    }

    const ids: number[] = [];
    let index = 0;
    while (index < text.length) {
      const tokenId = nextId[index] || this.unkId;
      const tokenLen = nextLen[index] || 1;
      ids.push(tokenId);
      index += tokenLen;
    }
    return ids;
  }

  private tokenize(text: string): number[] {
    text = text.normalize("NFKC");
    text = "\u2581" + text.replace(/\s+/g, "\u2581").trimStart();
    if (this.modelType === "unigram") {
      return this.tokenizeUnigram(text);
    }
    const tokens = this.bpe([...text]);
    return tokens.map(t => this.vocab.get(t) ?? this.unkId);
  }

  encodePair(query: string, document: string, maxLen: number = CROSS_ENCODER_MAX_SEQ): {
    input_ids: BigInt64Array; attention_mask: BigInt64Array; token_type_ids: BigInt64Array;
  } {
    const qIds = this.tokenize(query);
    const dIds = this.tokenize(document);
    // XLM-R pair: <s> query </s></s> document </s> (4 special tokens)
    const maxContent = maxLen - 4;
    const qBudget = Math.min(qIds.length, Math.ceil(maxContent * 0.3));
    const dBudget = Math.min(dIds.length, maxContent - qBudget);
    const tQ = qIds.slice(0, qBudget);
    const tD = dIds.slice(0, dBudget);

    const input_ids = new BigInt64Array(maxLen);
    const attention_mask = new BigInt64Array(maxLen);
    const token_type_ids = new BigInt64Array(maxLen);
    let p = 0;
    input_ids[p] = BigInt(this.bosId); attention_mask[p++] = 1n;
    for (const id of tQ) { input_ids[p] = BigInt(id); attention_mask[p++] = 1n; }
    input_ids[p] = BigInt(this.eosId); attention_mask[p++] = 1n;
    input_ids[p] = BigInt(this.eosId); attention_mask[p++] = 1n;
    for (const id of tD) { input_ids[p] = BigInt(id); attention_mask[p++] = 1n; }
    input_ids[p] = BigInt(this.eosId); attention_mask[p++] = 1n;
    return { input_ids, attention_mask, token_type_ids };
  }
}

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
    tok = new SentencePieceTokenizer(resolve(CROSS_ENCODER_DIR, "tokenizer.json"));
    session = await ort.InferenceSession.create(
      resolve(CROSS_ENCODER_DIR, CROSS_ENCODER_ONNX),
      { executionProviders: ["cpu"], graphOptimizationLevel: "all" as any, intraOpNumThreads: 0 },
    );
    hasTokenTypeIds = session.inputNames.includes("token_type_ids");
    // Warmup JIT
    await scorePair("warmup query", "warmup document");
    log.info({ msg: "cross_encoder_loaded", inputs: session.inputNames, outputs: session.outputNames, ms: Date.now() - t0 });
  } catch (e: any) {
    log.error({ msg: "cross_encoder_init_failed", error: e.message });
    session = null;
    tok = null;
  }
}

export function isRerankerReady(): boolean {
  return session !== null && tok !== null;
}

// ============================================================================
// PAIR SCORING
// ============================================================================

async function scorePair(query: string, document: string): Promise<number> {
  if (!session || !tok) throw new Error("Reranker not loaded");
  const { input_ids, attention_mask, token_type_ids } = tok.encodePair(query, document);
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", input_ids, [1, CROSS_ENCODER_MAX_SEQ]),
    attention_mask: new ort.Tensor("int64", attention_mask, [1, CROSS_ENCODER_MAX_SEQ]),
  };
  if (hasTokenTypeIds) {
    feeds.token_type_ids = new ort.Tensor("int64", token_type_ids, [1, CROSS_ENCODER_MAX_SEQ]);
  }
  const out = await session.run(feeds);
  const logits = out[session.outputNames[0]].data as Float32Array;
  // Sigmoid for 0-1 relevance score
  return 1 / (1 + Math.exp(-logits[0]));
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
  const scored: Array<{ index: number; ceScore: number }> = [];
  for (let i = 0; i < toRerank.length; i++) {
    try {
      const ceScore = await scorePair(query, toRerank[i].content);
      scored.push({ index: i, ceScore });
    } catch {
      scored.push({ index: i, ceScore: 0 });
    }
  }
  scored.sort((a, b) => b.ceScore - a.ceScore);
  const rerankerMs = Date.now() - t0;
  const candidateCount = Math.max(
    candidates[0]?.candidate_count ?? 0,
    candidates.length,
  );

  // Boost scores by reranked position (matches existing LLM reranker pattern)
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
