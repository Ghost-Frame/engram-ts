// ============================================================================
// RERANKER WORKER -- Runs cross-encoder ONNX inference off the main event loop
// This file runs in a Worker thread. It receives rerank requests via
// parentPort and returns scored results.
// ============================================================================

import { parentPort, workerData } from "worker_threads";
import * as ort from "onnxruntime-node";
import { resolve } from "path";
import { readFileSync } from "fs";

const { modelDir, onnxModelFile, maxSeq, intraOpNumThreads } = workerData as {
  modelDir: string;
  onnxModelFile: string;
  maxSeq: number;
  intraOpNumThreads: number;
};

// ============================================================================
// TOKENIZER (SentencePiece/XLM-R, copied from reranker/index.ts)
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

  encodePair(query: string, document: string): {
    input_ids: BigInt64Array; attention_mask: BigInt64Array; token_type_ids: BigInt64Array;
  } {
    const qIds = this.tokenize(query);
    const dIds = this.tokenize(document);
    // XLM-R pair: <s> query </s></s> document </s> (4 special tokens)
    const maxContent = maxSeq - 4;
    const qBudget = Math.min(qIds.length, Math.ceil(maxContent * 0.3));
    const dBudget = Math.min(dIds.length, maxContent - qBudget);
    const tQ = qIds.slice(0, qBudget);
    const tD = dIds.slice(0, dBudget);

    const input_ids = new BigInt64Array(maxSeq);
    const attention_mask = new BigInt64Array(maxSeq);
    const token_type_ids = new BigInt64Array(maxSeq);
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
// ONNX SESSION
// ============================================================================

let session: ort.InferenceSession | null = null;
let tok: SentencePieceTokenizer | null = null;
let hasTokenTypeIds = false;

async function init(): Promise<void> {
  tok = new SentencePieceTokenizer(resolve(modelDir, "tokenizer.json"));
  session = await ort.InferenceSession.create(resolve(modelDir, onnxModelFile), {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all" as any,
    intraOpNumThreads,
  });
  hasTokenTypeIds = session.inputNames.includes("token_type_ids");
  // Warmup JIT
  await scoreBatch("warmup query", ["warmup document"]);
}

async function scoreBatch(query: string, documents: string[]): Promise<number[]> {
  if (!session || !tok) throw new Error("Reranker worker not initialized");
  const n = documents.length;
  if (n === 0) return [];

  const batchInputIds = new BigInt64Array(n * maxSeq);
  const batchAttentionMask = new BigInt64Array(n * maxSeq);
  const batchTokenTypeIds = new BigInt64Array(n * maxSeq);

  for (let i = 0; i < n; i++) {
    const { input_ids, attention_mask, token_type_ids } = tok.encodePair(query, documents[i]);
    const offset = i * maxSeq;
    batchInputIds.set(input_ids, offset);
    batchAttentionMask.set(attention_mask, offset);
    batchTokenTypeIds.set(token_type_ids, offset);
  }

  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", batchInputIds, [n, maxSeq]),
    attention_mask: new ort.Tensor("int64", batchAttentionMask, [n, maxSeq]),
  };
  if (hasTokenTypeIds) {
    feeds.token_type_ids = new ort.Tensor("int64", batchTokenTypeIds, [n, maxSeq]);
  }

  const out = await session.run(feeds);
  const logits = out[session.outputNames[0]].data as Float32Array;

  const scores: number[] = [];
  for (let i = 0; i < n; i++) {
    scores.push(1 / (1 + Math.exp(-logits[i])));
  }
  return scores;
}

// Initialize then listen for requests
init().then(() => {
  parentPort!.postMessage({ type: "ready" });

  parentPort!.on("message", async (msg: { id: number; query: string; documents: string[] }) => {
    try {
      const scores = await scoreBatch(msg.query, msg.documents);
      parentPort!.postMessage({ id: msg.id, scores });
    } catch (e: any) {
      parentPort!.postMessage({ id: msg.id, error: e.message });
    }
  });
}).catch((e) => {
  parentPort!.postMessage({ type: "error", error: e.message });
  process.exit(1);
});
