// ============================================================================
// ROUTES -- Shared types and cross-cutting helpers
// ============================================================================

import type { AuthContext } from "../auth/index.ts";
import { log, opsCounters } from "../config/logger.ts";
import {
  OPEN_ACCESS, RATE_WINDOW_MS, OPEN_ACCESS_RATE_LIMIT,
  EMBEDDING_DIM, DEFAULT_IMPORTANCE,
} from "../config/index.ts";
import {
  db, updateMemoryVec, getEntityForUser, getProjectForUser,
} from "../db/index.ts";
import { embeddingToVectorJSON } from "../embeddings/index.ts";
import { isPrivateHostname, json, errorResponse, safeError, securityHeaders, sanitizeFTS } from "../helpers/index.ts";

// ── Route context passed to every sub-router ───────────────────────────────

export interface RouteContext {
  req: Request;
  url: URL;
  method: string;
  auth: AuthContext;
  clientIp: string;
  requestId: string;
  requestStart: number;
}

/** Pre-auth context for routes that run before authentication (GUI, bootstrap) */
export interface PreAuthContext {
  req: Request;
  url: URL;
  method: string;
  clientIp: string;
  requestId: string;
  requestStart: number;
}

/** A sub-router handler. Returns a Response if it matched, or null to pass through. */
export type RouteHandler = (ctx: RouteContext) => Promise<Response | null>;
export type PreAuthRouteHandler = (ctx: PreAuthContext) => Promise<Response | null>;

// ── Re-exports for sub-routers ─────────────────────────────────────────────

export { json, errorResponse, safeError, securityHeaders, sanitizeFTS };
export { log, opsCounters };
export { db };
export type { AuthContext };

// ── Cross-cutting helper functions ─────────────────────────────────────────

/** Per-IP rate limiting for OPEN_ACCESS mode */
const ipRateLimits = new Map<string, { count: number; reset: number }>();
export function checkIpRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  if (!OPEN_ACCESS) return { allowed: true };
  const now = Date.now();
  let rl = ipRateLimits.get(ip);
  if (!rl || now > rl.reset) {
    rl = { count: 0, reset: now + RATE_WINDOW_MS };
    ipRateLimits.set(ip, rl);
  }
  rl.count++;
  if (rl.count > OPEN_ACCESS_RATE_LIMIT) {
    return { allowed: false, retryAfter: Math.ceil((rl.reset - now) / 1000) };
  }
  return { allowed: true };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rl] of ipRateLimits) {
    if (now > rl.reset) ipRateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

/** Rough token estimator (~4 chars/token) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Validate that a webhook URL is public (not SSRF) */
export function validatePublicWebhookUrl(rawUrl: string, label: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return `${label} must be http or https`;
    if (isPrivateHostname(parsed.hostname.toLowerCase())) return `${label} cannot point to private/internal addresses`;
    return null;
  } catch {
    return `Invalid ${label.toLowerCase()}`;
  }
}

/** Check if auth context can access an owned row */
export function canAccessOwnedRow(row: { user_id?: number } | null | undefined, auth: AuthContext): boolean {
  return !!row && (row.user_id === auth.user_id || auth.is_admin);
}

/** Filter entity IDs to those owned by the auth context */
export function getOwnedEntityIds(ids: unknown, auth: AuthContext): number[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && !!getEntityForUser.get(id, auth.user_id));
}

/** Filter project IDs to those owned by the auth context */
export function getOwnedProjectIds(ids: unknown, auth: AuthContext): number[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && !!getProjectForUser.get(id, auth.user_id));
}

/** Write vector column, logging failures */
export function writeVec(id: number, emb: Float32Array): void {
  try { updateMemoryVec.run(embeddingToVectorJSON(emb), id); } catch (e: any) {
    opsCounters.vec_write_failures++;
    log.warn({ msg: "vec_write_failed", id, error: e?.message });
  }
}

/** Sweep expired memories (tenant-scoped when userId provided) */
export function sweepExpiredMemories(userId?: number): number {
  const query = userId != null
    ? "SELECT id, content, forget_reason FROM memories WHERE forget_after IS NOT NULL AND forget_after <= datetime('now') AND is_forgotten = 0 AND user_id = ?"
    : "SELECT id, content, forget_reason FROM memories WHERE forget_after IS NOT NULL AND forget_after <= datetime('now') AND is_forgotten = 0";
  const expired = (userId != null
    ? db.prepare(query).all(userId)
    : db.prepare(query).all()) as Array<{ id: number; content: string; forget_reason: string }>;
  for (const mem of expired) {
    (db.prepare("UPDATE memories SET is_forgotten = 1 WHERE id = ?") as any).run(mem.id);
    log.debug({ msg: "auto_forgot", id: mem.id, reason: mem.forget_reason || "expired" });
  }
  return expired.length;
}

/** Backfill embeddings for memories missing them */
import { embed, addToEmbeddingCache, embeddingToBuffer, bufferToEmbedding } from "../embeddings/index.ts";
import { updateMemoryEmbedding, getNoEmbeddingForUser, getMemory, countNoEmbeddingForUser } from "../db/index.ts";
import { autoLink } from "../memory/search.ts";

export async function backfillEmbeddings(batchSize: number = 50, userId?: number): Promise<number> {
  const missing = (userId == null
    ? db.prepare("SELECT id, content FROM memories WHERE embedding IS NULL LIMIT ?").all(batchSize)
    : getNoEmbeddingForUser.all(userId, batchSize)) as Array<{ id: number; content: string }>;
  let count = 0;
  for (const mem of missing) {
    try {
      const emb = await embed(mem.content);
      updateMemoryEmbedding.run(embeddingToBuffer(emb), mem.id);
      try { updateMemoryVec.run(embeddingToVectorJSON(emb), mem.id); } catch {}
      count++;
    } catch (e: any) {
      log.error({ msg: "embed_failed", id: mem.id, error: e.message });
    }
  }
  if (count > 0) {
    for (const mem of missing.slice(0, count)) {
      const row = getMemory.get(mem.id) as any;
      if (row?.embedding) {
        const emb = bufferToEmbedding(row.embedding);
        await autoLink(mem.id, emb, row.user_id ?? userId);
      }
    }
  }
  return count;
}

// ── Scratchpad types (shared between scratchpad + memory/recall context) ───

export type ScratchEntryRow = {
  session: string;
  agent: string;
  model: string;
  entry_key: string;
  value: string | null;
  created_at?: string;
  updated_at: string;
  expires_at?: string;
};

const WORKING_MEMORY_MAX_CHARS = 4000;
const WORKING_MEMORY_VALUE_MAX = 300;

function formatScratchTimestamp(updatedAt: string): string {
  const updatedMs = new Date(updatedAt + (updatedAt.includes("Z") ? "" : "Z")).getTime();
  if (!Number.isFinite(updatedMs)) return "just now";
  const diffMin = Math.max(0, Math.round((Date.now() - updatedMs) / 60000));
  if (diffMin <= 1) return "just now";
  return `${diffMin}m ago`;
}

export function buildWorkingMemoryBlock(rows: ScratchEntryRow[]): string {
  if (rows.length === 0) return "";
  const lines: string[] = [];
  let totalLen = 0;
  for (const row of rows) {
    const model = row.model ? `/${row.model}` : "";
    let value = row.value?.trim() || "";
    if (value.length > WORKING_MEMORY_VALUE_MAX) {
      value = value.slice(0, WORKING_MEMORY_VALUE_MAX) + "...";
    }
    const line = `- [${row.agent}${model} #${row.session.slice(0, 8)}] ${row.entry_key}${value ? ` ${value}` : ""} (${formatScratchTimestamp(row.updated_at)})`;
    if (totalLen + line.length > WORKING_MEMORY_MAX_CHARS && lines.length > 0) {
      lines.push(`- ... ${rows.length - lines.length} more entries truncated`);
      break;
    }
    lines.push(line);
    totalLen += line.length + 1;
  }
  return `<working-memory>\n${lines.join("\n")}\n</working-memory>`;
}
