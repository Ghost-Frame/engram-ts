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
// TOKENIZER (ByteLevel BPE, BERT-style pair encoding for IBM Granite reranker)
// ============================================================================

function buildBytesToUnicode(): Map<number, string> {
  const bs: number[] = [];
  const cs: number[] = [];
  for (let i = 33; i <= 126; i++) { bs.push(i); cs.push(i); }
  for (let i = 161; i <= 172; i++) { bs.push(i); cs.push(i); }
  for (let i = 174; i <= 255; i++) { bs.push(i); cs.push(i); }
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  }
  const map = new Map<number, string>();
  for (let i = 0; i < bs.length; i++) map.set(bs[i], String.fromCharCode(cs[i]));
  return map;
}

const GPT2_SPLIT_RE = /(?:'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+)/gu;

class ByteLevelBPETokenizer {
  private vocab: Map<string, number>;
  private mergeRanks: Map<string, number>;
  private bytesToUnicode: Map<number, string>;
  private clsId: number;
  private sepId: number;
  private unkId: number;

  constructor(path: string) {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const model = raw.model;

    this.vocab = new Map(Object.entries(model.vocab) as [string, number][]);
    for (const t of (raw.added_tokens || [])) {
      this.vocab.set(t.content, t.id);
    }

    this.clsId = this.vocab.get("[CLS]") ?? 50281;
    this.sepId = this.vocab.get("[SEP]") ?? 50282;
    this.unkId = this.vocab.get("<unk>") ?? 0;

    this.mergeRanks = new Map();
    for (let i = 0; i < model.merges.length; i++) {
      const [a, b] = model.merges[i] as [string, string];
      this.mergeRanks.set(a + "\x00" + b, i);
    }

    this.bytesToUnicode = buildBytesToUnicode();
  }

  private bpe(symbols: string[]): string[] {
    if (symbols.length <= 1) return symbols;
    while (true) {
      let bestRank = Infinity;
      let bestIdx = -1;
      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.mergeRanks.get(symbols[i] + "\x00" + symbols[i + 1]);
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

  private tokenize(text: string): number[] {
    const preTokens = text.normalize("NFC").match(GPT2_SPLIT_RE) || [];
    const ids: number[] = [];
    for (const word of preTokens) {
      const bytes = Buffer.from(word, "utf8");
      const encoded = [...bytes].map(b => this.bytesToUnicode.get(b) ?? "?").join("");
      const pieces = this.bpe([...encoded]);
      for (const piece of pieces) {
        ids.push(this.vocab.get(piece) ?? this.unkId);
      }
    }
    return ids;
  }

  encodePair(query: string, document: string): {
    input_ids: BigInt64Array; attention_mask: BigInt64Array; token_type_ids: BigInt64Array;
  } {
    const qIds = this.tokenize(query);
    const dIds = this.tokenize(document);
    // Granite pair: [CLS] query [SEP] document [SEP] (3 special tokens)
    const maxContent = maxSeq - 3;
    const qBudget = Math.min(qIds.length, Math.ceil(maxContent * 0.3));
    const dBudget = Math.min(dIds.length, maxContent - qBudget);
    const tQ = qIds.slice(0, qBudget);
    const tD = dIds.slice(0, dBudget);

    const input_ids = new BigInt64Array(maxSeq);
    const attention_mask = new BigInt64Array(maxSeq);
    const token_type_ids = new BigInt64Array(maxSeq);
    let p = 0;
    // [CLS] query tokens [SEP] = segment 0, document tokens [SEP] = segment 1
    input_ids[p] = BigInt(this.clsId); attention_mask[p++] = 1n;
    for (const id of tQ) { input_ids[p] = BigInt(id); attention_mask[p++] = 1n; }
    input_ids[p] = BigInt(this.sepId); attention_mask[p++] = 1n;
    // Document segment: token_type_ids = 1
    for (const id of tD) { input_ids[p] = BigInt(id); attention_mask[p] = 1n; token_type_ids[p++] = 1n; }
    input_ids[p] = BigInt(this.sepId); attention_mask[p] = 1n; token_type_ids[p++] = 1n;
    return { input_ids, attention_mask, token_type_ids };
  }
}

// ============================================================================
// ONNX SESSION
// ============================================================================

let session: ort.InferenceSession | null = null;
let tok: ByteLevelBPETokenizer | null = null;
let hasTokenTypeIds = false;

async function init(): Promise<void> {
  tok = new ByteLevelBPETokenizer(resolve(modelDir, "tokenizer.json"));
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
