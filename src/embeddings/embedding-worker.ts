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
// TOKENIZER (same as main thread implementation)
// ============================================================================

class BertWordPieceTokenizer {
  private vocab: Map<string, number>;
  private unkId: number;
  private clsId: number;
  private sepId: number;
  private maxCharsPerWord: number;
  private prefix: string;

  constructor(tokenizerJsonPath: string) {
    const raw = JSON.parse(readFileSync(tokenizerJsonPath, "utf-8"));
    const model = raw.model;
    this.vocab = new Map(Object.entries(model.vocab) as [string, number][]);
    this.unkId = this.vocab.get("[UNK]") ?? 100;
    this.clsId = this.vocab.get("[CLS]") ?? 101;
    this.sepId = this.vocab.get("[SEP]") ?? 102;
    this.maxCharsPerWord = model.max_input_chars_per_word ?? 100;
    this.prefix = model.continuing_subword_prefix ?? "##";
  }

  private normalize(text: string): string {
    let out = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0 || cp === 0xFFFD || isControl(cp)) continue;
      if (cp === 0x09 || cp === 0x0A || cp === 0x0D) { out += " "; continue; }
      if (isCJK(cp)) { out += ` ${ch} `; continue; }
      out += ch;
    }
    return out.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  private preTokenize(text: string): string[] {
    const tokens: string[] = [];
    let current = "";
    for (const ch of text) {
      if (/\s/.test(ch)) {
        if (current) { tokens.push(current); current = ""; }
      } else if (isPunct(ch)) {
        if (current) { tokens.push(current); current = ""; }
        tokens.push(ch);
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }

  private wordPiece(word: string): number[] {
    if (word.length > this.maxCharsPerWord) return [this.unkId];
    const ids: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let matched = false;
      while (start < end) {
        const sub = (start > 0 ? this.prefix : "") + word.slice(start, end);
        const id = this.vocab.get(sub);
        if (id !== undefined) {
          ids.push(id);
          start = end;
          matched = true;
          break;
        }
        end--;
      }
      if (!matched) return [this.unkId];
    }
    return ids;
  }

  encode(text: string, maxLen: number = embeddingMaxSeq): {
    input_ids: BigInt64Array; attention_mask: BigInt64Array; token_type_ids: BigInt64Array;
  } {
    const normalized = this.normalize(text);
    const words = this.preTokenize(normalized);
    const tokenIds: number[] = [];
    for (const w of words) {
      if (tokenIds.length >= maxLen - 2) break;
      const wp = this.wordPiece(w);
      for (const id of wp) {
        if (tokenIds.length >= maxLen - 2) break;
        tokenIds.push(id);
      }
    }
    const seqLen = tokenIds.length + 2;
    const input_ids = new BigInt64Array(maxLen);
    const attention_mask = new BigInt64Array(maxLen);
    const token_type_ids = new BigInt64Array(maxLen);
    input_ids[0] = BigInt(this.clsId);
    attention_mask[0] = 1n;
    for (let i = 0; i < tokenIds.length; i++) {
      input_ids[i + 1] = BigInt(tokenIds[i]);
      attention_mask[i + 1] = 1n;
    }
    input_ids[seqLen - 1] = BigInt(this.sepId);
    attention_mask[seqLen - 1] = 1n;
    return { input_ids, attention_mask, token_type_ids };
  }
}

function isControl(cp: number): boolean {
  return (cp >= 0x00 && cp <= 0x1F && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D) || (cp >= 0x7F && cp <= 0x9F);
}

function isCJK(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0x2A700 && cp <= 0x2B73F) ||
    (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF) ||
    (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F);
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return PUNCT_RE.test(ch);
}

// ============================================================================
// ONNX SESSION + MESSAGE HANDLER
// ============================================================================

let session: ort.InferenceSession | null = null;
let tokenizer: BertWordPieceTokenizer | null = null;

async function init(): Promise<void> {
  tokenizer = new BertWordPieceTokenizer(resolve(modelDir, "tokenizer.json"));
  session = await ort.InferenceSession.create(resolve(modelDir, onnxModelFile), {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all" as any,
    intraOpNumThreads,
  });
}

async function embed(text: string): Promise<Float32Array> {
  if (!session || !tokenizer) throw new Error("Worker not initialized");
  const { input_ids, attention_mask, token_type_ids } = tokenizer.encode(text);
  const feeds = {
    input_ids: new ort.Tensor("int64", input_ids, [1, embeddingMaxSeq]),
    attention_mask: new ort.Tensor("int64", attention_mask, [1, embeddingMaxSeq]),
    token_type_ids: new ort.Tensor("int64", token_type_ids, [1, embeddingMaxSeq]),
  };
  const results = await session.run(feeds);
  const outputName = session.outputNames[0];
  const hidden = results[outputName].data as Float32Array;
  // Mean pool over non-padding tokens
  const pooled = new Float32Array(embeddingDim);
  let maskSum = 0;
  for (let i = 0; i < embeddingMaxSeq; i++) {
    if (attention_mask[i] === 0n) continue;
    maskSum++;
    const offset = i * embeddingDim;
    for (let d = 0; d < embeddingDim; d++) pooled[d] += hidden[offset + d];
  }
  for (let d = 0; d < embeddingDim; d++) pooled[d] /= maskSum;
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
