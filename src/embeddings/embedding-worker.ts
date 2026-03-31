// ============================================================================
// EMBEDDING WORKER -- Runs ONNX inference off the main event loop
// This file runs in a Worker thread. It receives embedding requests via
// parentPort and returns Float32Array results.
// ============================================================================

import { parentPort, workerData } from "worker_threads";
import * as ort from "onnxruntime-node";
import { resolve } from "path";
import { readFileSync } from "fs";

// Config passed from main thread
const { modelDir, onnxModelFile, embeddingDim, embeddingMaxSeq, intraOpNumThreads } = workerData as {
  modelDir: string;
  onnxModelFile: string;
  embeddingDim: number;
  embeddingMaxSeq: number;
  intraOpNumThreads: number;
};

// ============================================================================
// TOKENIZER (SentencePiece Unigram for bge-m3, XLM-R format)
// ============================================================================

class SentencePieceUnigramTokenizer {
  private vocab: Map<string, number>;
  private unigramScores: Map<string, number>;
  private unigramByFirstChar: Map<string, string[]>;
  private bosId: number;
  private eosId: number;
  private unkId: number;

  constructor(tokenizerJsonPath: string) {
    const raw = JSON.parse(readFileSync(tokenizerJsonPath, "utf-8"));
    const model = raw.model;
    this.vocab = new Map();
    this.unigramScores = new Map();
    this.unigramByFirstChar = new Map();

    const vocabEntries = model.vocab as Array<[string, number]>;
    for (let i = 0; i < vocabEntries.length; i++) {
      const [token, score] = vocabEntries[i];
      this.vocab.set(token, i);
      this.unigramScores.set(token, Number(score) || 0);
      if (!token || token.startsWith("<") || token.startsWith("\u2581<")) continue;
      const first = token[0];
      const bucket = this.unigramByFirstChar.get(first) || [];
      bucket.push(token);
      this.unigramByFirstChar.set(first, bucket);
    }
    for (const bucket of this.unigramByFirstChar.values()) {
      bucket.sort((a, b) => b.length - a.length);
    }

    // Added tokens override vocab positions
    for (const t of (raw.added_tokens || [])) {
      this.vocab.set(t.content, t.id);
    }

    this.bosId = this.vocab.get("<s>") ?? 0;
    this.eosId = this.vocab.get("</s>") ?? 2;
    this.unkId = model.unk_id ?? 3;
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
      ids.push(nextId[index] || this.unkId);
      index += nextLen[index] || 1;
    }
    return ids;
  }

  encode(text: string, maxLen: number = embeddingMaxSeq): {
    input_ids: BigInt64Array; attention_mask: BigInt64Array;
  } {
    // Metaspace: prepend ▁, replace whitespace runs with ▁
    const normalized = "\u2581" + text.normalize("NFKC").replace(/\s+/g, "\u2581").trimStart();
    const tokenIds = this.tokenizeUnigram(normalized);

    // XLM-R single: <s> tokens </s>
    const maxContent = maxLen - 2;
    const toks = tokenIds.slice(0, maxContent);

    const input_ids = new BigInt64Array(maxLen);
    const attention_mask = new BigInt64Array(maxLen);
    let p = 0;
    input_ids[p] = BigInt(this.bosId); attention_mask[p++] = 1n;
    for (const id of toks) { input_ids[p] = BigInt(id); attention_mask[p++] = 1n; }
    input_ids[p] = BigInt(this.eosId); attention_mask[p++] = 1n;
    return { input_ids, attention_mask };
  }
}

// ============================================================================
// ONNX SESSION + MESSAGE HANDLER
// ============================================================================

let session: ort.InferenceSession | null = null;
let tokenizer: SentencePieceUnigramTokenizer | null = null;
let hasTokenTypeIds = false;

async function init(): Promise<void> {
  tokenizer = new SentencePieceUnigramTokenizer(resolve(modelDir, "tokenizer.json"));
  session = await ort.InferenceSession.create(resolve(modelDir, onnxModelFile), {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all" as any,
    intraOpNumThreads,
  });
  hasTokenTypeIds = session.inputNames.includes("token_type_ids");
}

async function embed(text: string): Promise<Float32Array> {
  if (!session || !tokenizer) throw new Error("Worker not initialized");
  const { input_ids, attention_mask } = tokenizer.encode(text);
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", input_ids, [1, embeddingMaxSeq]),
    attention_mask: new ort.Tensor("int64", attention_mask, [1, embeddingMaxSeq]),
  };
  if (hasTokenTypeIds) {
    feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(embeddingMaxSeq), [1, embeddingMaxSeq]);
  }
  const results = await session.run(feeds);
  const outputName = session.outputNames[0];
  const output = results[outputName];
  const hidden = output.data as Float32Array;

  // If output is already pooled (2D: [1, dim]), use directly
  const pooled = new Float32Array(embeddingDim);
  if (output.dims.length === 2) {
    if (output.dims[1] !== embeddingDim) {
      throw new Error(`Model output dim ${output.dims[1]} does not match configured EMBEDDING_DIM ${embeddingDim}`);
    }
    pooled.set(hidden.subarray(0, embeddingDim));
  } else {
    // Mean pool over non-padding tokens from last_hidden_state [1, seq, dim]
    let maskSum = 0;
    for (let i = 0; i < embeddingMaxSeq; i++) {
      if (attention_mask[i] === 0n) continue;
      maskSum++;
      const offset = i * embeddingDim;
      for (let d = 0; d < embeddingDim; d++) pooled[d] += hidden[offset + d];
    }
    for (let d = 0; d < embeddingDim; d++) pooled[d] /= maskSum;
  }

  // L2 normalize
  let norm = 0;
  for (let d = 0; d < embeddingDim; d++) norm += pooled[d] * pooled[d];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let d = 0; d < embeddingDim; d++) pooled[d] /= norm;
  return pooled;
}

// Initialize, then listen for requests
init().then(() => {
  parentPort!.postMessage({ type: "ready" });

  parentPort!.on("message", async (msg: { id: number; text: string }) => {
    try {
      const result = await embed(msg.text);
      // Transfer the underlying ArrayBuffer for zero-copy
      const buf = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
      parentPort!.postMessage({ id: msg.id, result: buf }, [buf as ArrayBuffer]);
    } catch (e: any) {
      parentPort!.postMessage({ id: msg.id, error: e.message });
    }
  });
}).catch((e) => {
  parentPort!.postMessage({ type: "error", error: e.message });
  process.exit(1);
});
