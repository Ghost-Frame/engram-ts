// ============================================================================
// CONFIG — All env vars, constants, feature flags
// ============================================================================

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.ENGRAM_DATA_DIR
  ? resolve(process.env.ENGRAM_DATA_DIR)
  : resolve(__dirname, "../../data");
export const DB_PATH = resolve(DATA_DIR, "memory.db");
export const PORT = Number(process.env.ENGRAM_PORT || process.env.ZANMEMORY_PORT || 4200);
export const HOST = process.env.ENGRAM_HOST || process.env.ZANMEMORY_HOST || "0.0.0.0";

// Embedding config -- pluggable provider
// Provider: "local" = ONNX BGE-large (default), "google" = Google AI Studio, "vertex" = Vertex AI
export const EMBEDDING_PROVIDER = (process.env.ENGRAM_EMBEDDING_PROVIDER || "local") as "local" | "google" | "vertex";
export const EMBEDDING_MODEL = process.env.ENGRAM_EMBEDDING_MODEL || (EMBEDDING_PROVIDER === "local" ? "BAAI/bge-large-en-v1.5" : "text-embedding-005");
export const EMBEDDING_DIM = Number(process.env.ENGRAM_EMBEDDING_DIM || (EMBEDDING_PROVIDER === "local" ? 1024 : 768));
export const EMBEDDING_MAX_SEQ = 512;
export const MODEL_DIR = resolve(DATA_DIR, "models", "bge-large-en-v1.5");
export const ONNX_MODEL_FILE = process.env.ENGRAM_EMBEDDING_FP32 === "1" ? "model.onnx" : "model_quantized.onnx";
export const MODEL_URLS: Record<string, string> = {
  "tokenizer.json": "https://huggingface.co/Xenova/bge-large-en-v1.5/resolve/main/tokenizer.json",
  "model_quantized.onnx": "https://huggingface.co/Xenova/bge-large-en-v1.5/resolve/main/onnx/model_quantized.onnx",
  "model.onnx": "https://huggingface.co/Xenova/bge-large-en-v1.5/resolve/main/onnx/model.onnx",
};

// Google Cloud / Vertex AI config
export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.LLM_API_KEY || ""; // AI Studio API key
export const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "";
export const GOOGLE_CLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
export const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || ""; // path to service account JSON

export const AUTO_LINK_THRESHOLD = 0.55;
export const SEARCH_MIN_SCORE = Number(process.env.ENGRAM_SEARCH_MIN_SCORE || 0.58);
export const AUTO_LINK_MAX = Number(process.env.AUTO_LINK_MAX ?? 6);
export const DEFAULT_IMPORTANCE = 5;

// LLM config (for fact extraction) — provider chain with fallbacks or round-robin
export const LLM_URL = process.env.LLM_URL || "http://127.0.0.1:4100/v1/chat/completions";
export const LLM_API_KEY = process.env.LLM_API_KEY || "";
export const LLM_MODEL = process.env.LLM_MODEL || "gemini-2.5-flash";
export const LLM_STRATEGY = (process.env.LLM_STRATEGY || "fallback") as "fallback" | "round-robin";

export interface LLMProvider { url: string; key: string; model: string; name: string }

// Build provider list: primary + up to 9 additional providers (LLM_PROVIDER_2..10 or legacy LLM_FALLBACK1..2)
function buildProviders(): LLMProvider[] {
  const list: LLMProvider[] = [{ url: LLM_URL, key: LLM_API_KEY, model: LLM_MODEL, name: process.env.LLM_PROVIDER_1_NAME || "primary" }];

  // New format: LLM_PROVIDER_2_URL, LLM_PROVIDER_3_URL, etc.
  for (let i = 2; i <= 10; i++) {
    const url = process.env[`LLM_PROVIDER_${i}_URL`];
    if (!url) continue;
    list.push({
      url,
      key: process.env[`LLM_PROVIDER_${i}_KEY`] || "",
      model: process.env[`LLM_PROVIDER_${i}_MODEL`] || "gpt-4o-mini",
      name: process.env[`LLM_PROVIDER_${i}_NAME`] || `provider${i}`,
    });
  }

  // Legacy format: LLM_FALLBACK1_URL, LLM_FALLBACK2_URL (only if no new-format providers found)
  if (list.length === 1) {
    if (process.env.LLM_FALLBACK1_URL) list.push({
      url: process.env.LLM_FALLBACK1_URL,
      key: process.env.LLM_FALLBACK1_KEY || "",
      model: process.env.LLM_FALLBACK1_MODEL || "llama-3.1-70b-versatile",
      name: "fallback1",
    });
    if (process.env.LLM_FALLBACK2_URL) list.push({
      url: process.env.LLM_FALLBACK2_URL,
      key: process.env.LLM_FALLBACK2_KEY || "",
      model: process.env.LLM_FALLBACK2_MODEL || "deepseek-chat",
      name: "fallback2",
    });
  }

  return list;
}
export const LLM_PROVIDERS: LLMProvider[] = buildProviders();

// Auto-forget sweep interval (every 5 minutes)
export const FORGET_SWEEP_INTERVAL = 5 * 60 * 1000;

// FSRS-6 configuration
export const FSRS_DEFAULT_RETENTION = 0.9;
export const CONSOLIDATION_THRESHOLD = 8;
export const CONSOLIDATION_INTERVAL = 30 * 60 * 1000;

// Reranker config (LLM-based reranker; separate from ONNX cross-encoder)
export const RERANKER_ENABLED = (process.env.ENGRAM_RERANKER ?? process.env.RERANKER) !== "0";
export const RERANKER_TOP_K = Number(process.env.ENGRAM_RERANKER_TOP_K || process.env.RERANKER_TOP_K || 12);
export const SEARCH_FACT_VECTOR_FLOOR = Number(process.env.ENGRAM_SEARCH_FACT_VECTOR_FLOOR || 0.22);
export const SEARCH_PREFERENCE_VECTOR_FLOOR = Number(process.env.ENGRAM_SEARCH_PREFERENCE_VECTOR_FLOOR || 0.12);
export const SEARCH_REASONING_VECTOR_FLOOR = Number(process.env.ENGRAM_SEARCH_REASONING_VECTOR_FLOOR || 0.10);
export const SEARCH_GENERALIZATION_VECTOR_FLOOR = Number(process.env.ENGRAM_SEARCH_GENERALIZATION_VECTOR_FLOOR || 0.12);
export const SEARCH_PERSONALITY_MIN_SCORE = Number(process.env.ENGRAM_SEARCH_PERSONALITY_MIN_SCORE || 0.30);

// API key config
export const API_KEY_PREFIX = "eg_";
export const DEFAULT_RATE_LIMIT = 120;
export const RATE_WINDOW_MS = 60_000;

// Security config
export const OPEN_ACCESS = process.env.ENGRAM_OPEN_ACCESS === "1";
export const CORS_ORIGIN = process.env.ENGRAM_CORS_ORIGIN?.trim() || "";
export const MAX_BODY_SIZE = Number(process.env.ENGRAM_MAX_BODY_SIZE || 1_048_576);
export const MAX_CONTENT_SIZE = Number(process.env.ENGRAM_MAX_CONTENT_SIZE || 102_400);
export const ALLOWED_IPS = (process.env.ENGRAM_ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
export const GUI_AUTH_MAX_ATTEMPTS = 5;
export const GUI_AUTH_WINDOW_MS = 60_000;
export const GUI_AUTH_LOCKOUT_MS = 600_000;
export const OPEN_ACCESS_RATE_LIMIT = Number(process.env.ENGRAM_OPEN_RATE_LIMIT || 120);

// Agent identity & signing config
export const SIGNING_SECRET_FILE = resolve(DATA_DIR, ".signing_secret");

// Logging config
export const LOG_LEVEL_MAP: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, none: 4 };
export const LOG_LEVEL = LOG_LEVEL_MAP[process.env.ENGRAM_LOG_LEVEL || "info"] ?? 1;

// Tier 4: Novel feature flags
export const ENABLE_CAUSAL_CHAINS = process.env.ENGRAM_CAUSAL_CHAINS !== "0";
export const ENABLE_PREDICTIVE_RECALL = process.env.ENGRAM_PREDICTIVE_RECALL !== "0";
export const ENABLE_EMOTIONAL_VALENCE = process.env.ENGRAM_EMOTIONAL_VALENCE !== "0";
export const ENABLE_RECONSOLIDATION = process.env.ENGRAM_RECONSOLIDATION !== "0";
export const ENABLE_ADAPTIVE_IMPORTANCE = process.env.ENGRAM_ADAPTIVE_IMPORTANCE !== "0";
export const RECONSOLIDATION_INTERVAL = Number(process.env.ENGRAM_RECONSOLIDATION_INTERVAL || 60 * 60 * 1000); // 1 hour

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });
