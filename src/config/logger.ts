// ============================================================================
// LOGGER - Structured JSON logging + operational counters
// ============================================================================

import { LOG_LEVEL } from "../config/index.ts";

function logPayload(args: any[]): Record<string, any> {
  if (args.length === 1 && typeof args[0] === "object") return args[0];
  return { msg: args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") };
}

export const log = {
  debug: (...args: any[]) => { if (LOG_LEVEL <= 0) console.log(JSON.stringify({ level: "debug", ts: new Date().toISOString(), ...logPayload(args) })); },
  info: (...args: any[]) => { if (LOG_LEVEL <= 1) console.log(JSON.stringify({ level: "info", ts: new Date().toISOString(), ...logPayload(args) })); },
  warn: (...args: any[]) => { if (LOG_LEVEL <= 2) console.warn(JSON.stringify({ level: "warn", ts: new Date().toISOString(), ...logPayload(args) })); },
  error: (...args: any[]) => { if (LOG_LEVEL <= 3) console.error(JSON.stringify({ level: "error", ts: new Date().toISOString(), ...logPayload(args) })); },
};

// ── Operational counters for silent-failure tracking ─────────────────
// Exposed via /health and /metrics for operator visibility.
export const opsCounters = {
  vec_write_failures: 0,
  embed_failures: 0,
  extraction_failures: 0,
  reset_delete_warnings: 0,
  fts_rebuild_failures: 0,
  structured_fact_failures: 0,
  reranker_fallbacks: 0,
  db_lock_waits: 0,
  db_lock_timeouts: 0,
  db_write_queue_depth: 0,
  request_count: 0,
  request_errors: 0,
  request_latency_sum_ms: 0,
  embedding_latency_sum_ms: 0,
  embedding_count: 0,
  search_count: 0,
  search_latency_sum_ms: 0,
  store_count: 0,
  store_latency_sum_ms: 0,
  sla_search_under_200ms: 0,
  sla_search_total: 0,
  sla_store_under_500ms: 0,
  sla_store_total: 0,
  sla_errors_5xx: 0,
  sla_period_start: Date.now(),
};
