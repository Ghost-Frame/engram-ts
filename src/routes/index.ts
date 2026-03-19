// ============================================================================
// ROUTES — All HTTP request handling
// Auto-extracted from server.ts.monolith lines 2881-7283
// ============================================================================

import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync } from "fs";
import { readFile } from "fs/promises";
import { randomUUID, timingSafeEqual } from "crypto";
import { resolve } from "path";
import { htmlToText } from "html-to-text";

// Config
import {
  PORT, HOST, OPEN_ACCESS, CORS_ORIGIN, MAX_BODY_SIZE, MAX_CONTENT_SIZE,
  ALLOWED_IPS, LLM_URL, LLM_API_KEY, LLM_MODEL, LLM_PROVIDERS, AUTO_LINK_THRESHOLD, AUTO_LINK_MAX,
  DEFAULT_IMPORTANCE, RERANKER_ENABLED, RERANKER_TOP_K, DATA_DIR, DB_PATH, EMBEDDING_MODEL, EMBEDDING_DIM, EMBEDDING_PROVIDER,
  CONSOLIDATION_THRESHOLD, RATE_WINDOW_MS, OPEN_ACCESS_RATE_LIMIT, DEFAULT_RATE_LIMIT,
  GUI_AUTH_MAX_ATTEMPTS, GUI_AUTH_WINDOW_MS, GUI_AUTH_LOCKOUT_MS,
  ENABLE_CAUSAL_CHAINS, ENABLE_PREDICTIVE_RECALL, ENABLE_EMOTIONAL_VALENCE,
  ENABLE_RECONSOLIDATION, SEARCH_MIN_SCORE,
} from "../config/index.ts";
import { log, opsCounters } from "../config/logger.ts";

// Database + prepared statements
import {
  db, audit,
  insertMemory, getMemory, listRecent, listByCategory,
  insertLink, getLinksFor, getLinksForUser, markForgotten, markArchived, markUnarchived, markSuperseded,
  getVersionChain, getVersionChainForUser, updateMemoryEmbedding, updateMemoryVec,
  getAllTags, getByTag, insertEpisode, getEpisode, getEpisodeForUser, getEpisodeBySession, getEpisodeMemories,
  listEpisodes, assignToEpisode, updateEpisode,
  updateEpisodeEmbedding, updateEpisodeVec, searchEpisodesFTS, listEpisodesByTimeRange,
  insertConversation, getConversation, getConversationForUser, getConversationBySession, listConversations,
  listConversationsByAgent, touchConversation, updateConversation, deleteConversation,
  insertMessage, getMessages, searchMessages, bulkInsertConvo,
  getStaticMemories, getRecentDynamicMemories,
  getAllMemoriesForGraph, getAllLinksForGraph,
  countNoEmbedding, countNoEmbeddingForUser, getNoEmbeddingForUser, getMemoryWithoutEmbedding,
  updateFSRS, getFSRS, getFSRSForUser, trackAccessWithFSRS,
  insertWebhook, listWebhooks, deleteWebhook,
  getChangesSince, getMemoryBySyncId,
  insertEntity, listEntities, listEntitiesByType, getEntity, getEntityForUser, getEntityMemories,
  getEntityRelationships, updateEntity, deleteEntity,
  linkMemoryEntity, unlinkMemoryEntity, searchEntities,
  insertEntityRelationship, deleteEntityRelationship,
  insertProject, listProjects, listProjectsByStatus, getProject, getProjectForUser, getProjectMemories,
  updateProject, deleteProject, linkMemoryProject, unlinkMemoryProject,
  listPending, countPending, approveMemory, rejectMemory, deleteMemory,
  insertAgent, getAgent as getAgentById, getAgentByName, listAgents, updateAgentTrust,
  revokeAgent, getAgentByKeyId, linkKeyToAgent, getAgentExecutions,
  updateEpisodeForUser, assignToEpisodeForUser,
  upsertScratchEntry, upsertScratchEntryWithTTL, listScratchEntries, listScratchEntriesForContext,
  deleteScratchSession, deleteScratchSessionKey, purgeExpiredScratchpad,
  getScratchSessionAll,
  updateDecayScores,
} from "../db/index.ts";

// Embeddings
import {
  embed, cosineSimilarity, getCachedEmbeddings, addToEmbeddingCache,
  invalidateEmbeddingCache, embeddingToBuffer, bufferToEmbedding, embeddingToVectorJSON,
  graphCache, setGraphCache, episodeCache, refreshEmbeddingCache, embeddingCacheLatest,
} from "../embeddings/index.ts";

// Search + linking
import { hybridSearch, autoLink } from "../memory/search.ts";
import { generateProfile } from "../memory/profile.ts";

// SimHash near-duplicate detection
import { checkSimHashDuplicate, storeSimHash, boostDuplicate } from "../memory/simhash.ts";

// Entity cooccurrence graph
import { updateCooccurrences } from "../graph/cooccurrence.ts";

// FSRS
import { fsrsProcessReview, fsrsRetrievability, fsrsNextInterval, FSRSRating, calculateDecayScore as fsrsCalculateDecayScore } from "../fsrs/index.ts";

// LLM + extraction
import { callLLM, extractFacts, processExtractionResult, rerank, isLLMAvailable, isProviderAvailable } from "../llm/index.ts";

// Cross-encoder reranker
import { crossEncoderRerank, isRerankerReady } from "../reranker/index.ts";

// Jobs
import { enqueueJob, getJobStats } from "../jobs/index.ts";
import { fastExtractFacts } from "../intelligence/extraction.ts";
import { runConsolidationSweep, consolidateCluster } from "../intelligence/consolidation.ts";
import { extractPersonalitySignals, synthesizePersonalityProfile, getCachedProfile } from "../intelligence/personality.ts";
import { getPersonalitySignalCount } from "../db/index.ts";

// Platform
import { emitWebhookEvent } from "../platform/webhooks.ts";
import { buildDigestPayload, sendDigestWebhook, calculateNextSend, processScheduledDigests } from "../platform/digest.ts";

// Helpers
import { securityHeaders, json, errorResponse, safeError, sanitizeFTS, isPrivateHostname } from "../helpers/index.ts";

// Agent signing
import { signExecution, verifyExecution, createPassport, verifyPassport, computeTrustScore, generateSigningSecret, signMessage, verifyMessage, NonceTracker, verifyToolManifest } from "../../sign/index.ts";
import { SIGNING_SECRET_FILE } from "../config/index.ts";

// Auth
import {
  type AuthContext, type AuthError,
  authenticate, getAuthOrDefault as _getAuthOrDefault, isAuthError, hasScope, generateApiKey,
} from "../auth/index.ts";

// GUI
import {
  GUI_PASSWORD, GUI_AUTH_CONFIGURED, GUI_COOKIE_ATTRIBUTES, GUI_COOKIE_MAX_AGE,
  guiSignCookie, guiAuthed, getGuiHtml, getLoginHtml, reloadGuiHtml,
} from "../gui/index.ts";

// Bind guiAuthed into getAuthOrDefault so routes can call it with just (req)
function getAuthOrDefault(req: Request): AuthContext | AuthError | null {
  return _getAuthOrDefault(req, guiAuthed);
}

const GUI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "form-action 'self'",
].join("; ");

type ScratchEntryRow = {
  session: string;
  agent: string;
  model: string;
  entry_key: string;
  value: string | null;
  created_at?: string;
  updated_at: string;
  expires_at?: string;
};

function formatScratchTimestamp(updatedAt: string): string {
  const updatedMs = new Date(updatedAt + (updatedAt.includes("Z") ? "" : "Z")).getTime();
  if (!Number.isFinite(updatedMs)) return "just now";
  const diffMin = Math.max(0, Math.round((Date.now() - updatedMs) / 60000));
  if (diffMin <= 1) return "just now";
  return `${diffMin}m ago`;
}

const WORKING_MEMORY_MAX_CHARS = 4000; // ~1K tokens cap to prevent context flooding
const WORKING_MEMORY_VALUE_MAX = 300;  // truncate individual values

function buildWorkingMemoryBlock(rows: ScratchEntryRow[]): string {
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

// Tier 4
import { detectCausalLinks, getCausalHistory } from "../tier4/causal.ts";
import { predictiveRecall, trackTemporalAccess } from "../tier4/predictive.ts";
import { analyzeValence, storeValence, queryByEmotion, getEmotionalProfile } from "../tier4/valence.ts";
import { reconsolidateMemory, runReconsolidationSweep, recordRecallOutcome } from "../tier4/reconsolidation.ts";


// --- Functions used by routes but not in a module yet ---

// Per-IP rate limiting for OPEN_ACCESS mode
const ipRateLimits = new Map<string, { count: number; reset: number }>();
function checkIpRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
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

// GUI auth rate limiting state
const guiAuthAttempts = new Map<string, { count: number; first: number; locked_until: number }>();

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function validatePublicWebhookUrl(rawUrl: string, label: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return `${label} must be http or https`;
    if (isPrivateHostname(parsed.hostname.toLowerCase())) return `${label} cannot point to private/internal addresses`;
    return null;
  } catch {
    return `Invalid ${label.toLowerCase()}`;
  }
}

function canAccessOwnedRow(row: { user_id?: number } | null | undefined, auth: AuthContext): boolean {
  return !!row && (row.user_id === auth.user_id || auth.is_admin);
}

function getOwnedEntityIds(ids: unknown, auth: AuthContext): number[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && !!getEntityForUser.get(id, auth.user_id));
}

function getOwnedProjectIds(ids: unknown, auth: AuthContext): number[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && !!getProjectForUser.get(id, auth.user_id));
}

// Sweep expired memories (tenant-scoped when userId provided)
function sweepExpiredMemories(userId?: number): number {
  const query = userId != null
    ? "SELECT id, content, forget_reason FROM memories WHERE forget_after IS NOT NULL AND forget_after <= datetime('now') AND is_forgotten = 0 AND user_id = ?"
    : "SELECT id, content, forget_reason FROM memories WHERE forget_after IS NOT NULL AND forget_after <= datetime('now') AND is_forgotten = 0";
  const expired = (userId != null
    ? db.prepare(query).all(userId)
    : db.prepare(query).all()) as Array<{ id: number; content: string; forget_reason: string }>;
  for (const mem of expired) {
    markForgotten.run(mem.id);
    log.debug({ msg: "auto_forgot", id: mem.id, reason: mem.forget_reason || "expired" });
  }
  return expired.length;
}

// Backfill embeddings
async function backfillEmbeddings(batchSize: number = 50, userId?: number): Promise<number> {
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

// Write vec helper
function writeVec(id: number, emb: Float32Array): void {
  try { updateMemoryVec.run(embeddingToVectorJSON(emb), id); } catch (e: any) {
    opsCounters.vec_write_failures++;
    log.warn({ msg: "vec_write_failed", id, error: e?.message });
  }
}

export { sweepExpiredMemories, backfillEmbeddings };

// ── Signing secret (auto-generated on first run) ──────────────────
let signingSecret: string;
try {
  signingSecret = readFileSync(SIGNING_SECRET_FILE, "utf8").trim();
} catch {
  signingSecret = generateSigningSecret();
  writeFileSync(SIGNING_SECRET_FILE, signingSecret, "utf8");
  log.info({ msg: "signing_secret_generated" });
}

// Nonce tracker for MCP message replay protection (5-min window)
const nonceTracker = new NonceTracker();

/** Update agent trust score from current stats */
function refreshAgentTrust(agentId: number): void {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) return;
  const score = computeTrustScore({
    total_ops: agent.total_ops,
    successful_ops: agent.successful_ops,
    failed_ops: agent.failed_ops,
    guard_allows: agent.guard_allows,
    guard_warns: agent.guard_warns,
    guard_blocks: agent.guard_blocks,
  });
  updateAgentTrust.run(score, agent.total_ops, agent.successful_ops, agent.failed_ops, agent.guard_allows, agent.guard_warns, agent.guard_blocks, agentId);
}

/** Record an operation for an agent and recalculate trust */
function recordAgentOp(agentId: number | null, success: boolean): void {
  if (!agentId) return;
  if (success) {
    db.prepare("UPDATE agents SET total_ops = total_ops + 1, successful_ops = successful_ops + 1 WHERE id = ?").run(agentId);
  } else {
    db.prepare("UPDATE agents SET total_ops = total_ops + 1, failed_ops = failed_ops + 1 WHERE id = ?").run(agentId);
  }
  refreshAgentTrust(agentId);
}

/** Record a guard result for an agent */
function recordAgentGuard(agentId: number | null, signal: "allow" | "warn" | "block"): void {
  if (!agentId) return;
  const col = signal === "allow" ? "guard_allows" : signal === "warn" ? "guard_warns" : "guard_blocks";
  db.prepare(`UPDATE agents SET ${col} = ${col} + 1 WHERE id = ?`).run(agentId);
  refreshAgentTrust(agentId);
}

async function fetchHandler(req: Request, socketIp?: string): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: securityHeaders() });
    }

    // ========================================================================
    // REQUEST MIDDLEWARE — ID, IP check, body limit
    // ========================================================================
    const requestId = req.headers.get("X-Request-Id") || randomUUID().slice(0, 8);
    const clientIp = socketIp || req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
    const requestStart = performance.now();

    // IP allowlist check
    if (ALLOWED_IPS.length > 0 && !ALLOWED_IPS.includes(clientIp) && clientIp !== "127.0.0.1" && clientIp !== "::1") {
      log.warn({ msg: "blocked_ip", ip: clientIp, path: url.pathname, rid: requestId });
      return new Response("Forbidden", { status: 403 });
    }

    // S5 FIX: Per-IP rate limiting in OPEN_ACCESS mode
    if (OPEN_ACCESS) {
      const rl = checkIpRateLimit(clientIp);
      if (!rl.allowed) {
        log.warn({ msg: "ip_rate_limited", ip: clientIp, path: url.pathname, rid: requestId });
        return json({ error: "Rate limit exceeded" }, 429, { "Retry-After": String(rl.retryAfter || 60) });
      }
    }

    // Body size limit + Content-Type validation
    if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
      const cl = req.headers.get("Content-Length");
      if (cl && Number(cl) > MAX_BODY_SIZE) {
        log.warn({ msg: "body_too_large", size: Number(cl), limit: MAX_BODY_SIZE, ip: clientIp, rid: requestId });
        return json({ error: "Request body too large", limit: MAX_BODY_SIZE }, 413);
      }
      // S7 FIX: Reject non-JSON content types on mutation endpoints (CSRF protection)
      if (method !== "DELETE" && cl && Number(cl) > 0) {
        const ct = req.headers.get("Content-Type") || "";
        if (!ct.includes("application/json")) {
          return json({ error: "Content-Type must be application/json" }, 415);
        }
      }
    }

    // ========================================================================
    // WEB GUI AUTH
    // ========================================================================
    if (url.pathname === "/gui/auth" && method === "POST") {
      if (!GUI_AUTH_CONFIGURED || !GUI_PASSWORD) {
        log.error({ msg: "gui_auth_unconfigured", rid: requestId });
        return json({ error: "GUI password is not configured" }, 503);
      }
      // Rate limit GUI auth attempts
      const now = Date.now();
      const ga = guiAuthAttempts.get(clientIp);
      if (ga && now < ga.locked_until) {
        log.warn({ msg: "gui_auth_locked", ip: clientIp, rid: requestId });
        return json({ error: "Too many attempts. Try again later." }, 429);
      }
      if (ga && now - ga.first > GUI_AUTH_WINDOW_MS) guiAuthAttempts.delete(clientIp);
      try {
        const body = await req.json() as { password?: string };
        const pwMatch = body.password && body.password.length === GUI_PASSWORD.length &&
          timingSafeEqual(Buffer.from(body.password), Buffer.from(GUI_PASSWORD));
        if (pwMatch) {
          const cookie = guiSignCookie(Math.floor(Date.now() / 1000));
          return new Response(JSON.stringify({ ok: true }), {
            headers: securityHeaders({
              "Content-Type": "application/json",
              "Set-Cookie": `engram_auth=${cookie}; ${GUI_COOKIE_ATTRIBUTES}; Max-Age=${GUI_COOKIE_MAX_AGE}`,
            })
          });
        }
        const att = guiAuthAttempts.get(clientIp) || { count: 0, first: Date.now(), locked_until: 0 };
        att.count++;
        if (att.count >= GUI_AUTH_MAX_ATTEMPTS) att.locked_until = Date.now() + GUI_AUTH_LOCKOUT_MS;
        guiAuthAttempts.set(clientIp, att);
        audit(null, "gui_auth_fail", null, null, null, clientIp, requestId);
        log.warn({ msg: "gui_auth_fail", ip: clientIp, attempts: att.count, rid: requestId });
        return json({ error: "Invalid password" }, 401);
      } catch (e: any) { log.error({ msg: "gui_auth_error", error: e.message, stack: e.stack?.split("\n")[1]?.trim() }); return json({ error: "Bad request" }, 400); }
    }

    if (url.pathname === "/gui/logout" && method === "GET") {
      return new Response(await getLoginHtml(), {
        headers: securityHeaders({
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": GUI_CONTENT_SECURITY_POLICY,
          "Set-Cookie": `engram_auth=; ${GUI_COOKIE_ATTRIBUTES}; Max-Age=0`,
        })
      });
    }

    // ========================================================================
    // WEB GUI
    // ========================================================================
    if ((url.pathname === "/" || url.pathname === "/gui") && method === "GET") {
      if (OPEN_ACCESS || guiAuthed(req)) {
        return new Response(await getGuiHtml(), {
          headers: securityHeaders({
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": GUI_CONTENT_SECURITY_POLICY,
          })
        });
      }
      return new Response(await getLoginHtml(), {
        headers: securityHeaders({
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": GUI_CONTENT_SECURITY_POLICY,
        })
      });
    }

    // ========================================================================
    // FIRST-RUN BOOTSTRAP — create first admin API key (only works when no keys exist)
    // Requires bootstrap token (generated on first access, written to DATA_DIR/.bootstrap_token)
    // or localhost-only access
    // ========================================================================
    if (url.pathname === "/bootstrap" && method === "POST") {
      const keyCount = (db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE is_active = 1").get() as any).count;
      if (keyCount > 0) {
        return json({ error: "Bootstrap unavailable. API keys already exist." }, 403, { "X-Request-Id": requestId });
      }

      // Require localhost or valid bootstrap token
      const isLocal = clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "localhost";
      const tokenFile = resolve(DATA_DIR, ".bootstrap_token");
      let bootstrapToken: string | null = null;
      try { bootstrapToken = readFileSync(tokenFile, "utf-8").trim(); } catch {}
      if (!bootstrapToken) {
        // Generate a one-time bootstrap token
        bootstrapToken = randomUUID();
        try {
          writeFileSync(tokenFile, bootstrapToken, { mode: 0o600 });
          log.info({ msg: "bootstrap_token_generated", path: tokenFile });
        } catch (e: any) {
          log.error({ msg: "bootstrap_token_write_failed", error: e.message });
        }
      }

      const body = await req.json().catch(() => ({})) as any;

      if (!isLocal) {
        const providedToken = body.token || req.headers.get("X-Bootstrap-Token") || "";
        if (!bootstrapToken || providedToken !== bootstrapToken) {
          log.warn({ msg: "bootstrap_rejected", ip: clientIp, rid: requestId, reason: "invalid_token" });
          return json({ error: "Bootstrap from remote requires valid token. Check DATA_DIR/.bootstrap_token on the server." }, 403, { "X-Request-Id": requestId });
        }
      }

      try {
        const { key, prefix, hash } = generateApiKey();
        const name = body.name || "bootstrap-admin";
        db.prepare(
          "INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(1, prefix, hash, name, "read,write,admin", DEFAULT_RATE_LIMIT);
        audit(1, "bootstrap", null, null, "first_admin_key_created", clientIp, requestId);
        log.info({ msg: "bootstrap_admin_key_created", ip: clientIp, rid: requestId });
        // Clean up bootstrap token after successful use
        try { unlinkSync(tokenFile); } catch {}
        return json({ key, name, scopes: "read,write,admin", user_id: 1, message: "First admin API key created. Save this key -- it cannot be retrieved again." }, 201, { "X-Request-Id": requestId });
      } catch (e: any) {
        return safeError("Bootstrap", e, 500, requestId);
      }
    }

    // ========================================================================
    // AUTH CONTEXT — extract user from API key or require auth
    // ========================================================================
    const maybeAuth = getAuthOrDefault(req);
    if (isAuthError(maybeAuth)) {
      const elapsed = (performance.now() - requestStart).toFixed(1);
      log.info({ msg: "req", method, path: url.pathname, status: maybeAuth.status, ms: elapsed, ip: clientIp, rid: requestId });
      return json({ error: maybeAuth.error }, maybeAuth.status, { "X-Request-Id": requestId, ...(maybeAuth.headers || {}) });
    }
    if (!maybeAuth && url.pathname !== "/health") {
      const elapsed = (performance.now() - requestStart).toFixed(1);
      log.info({ msg: "req", method, path: url.pathname, status: 401, ms: elapsed, ip: clientIp, rid: requestId });
      return json({ error: "Authentication required. Provide Bearer eg_* token." }, 401, { "X-Request-Id": requestId });
    }
    const auth: AuthContext = maybeAuth || { user_id: 1, space_id: null, key_id: null, agent_id: null, scopes: ["read"], is_admin: false };

    // ========================================================================
    // USER MANAGEMENT (admin only)
    // ========================================================================

    if (url.pathname === "/users" && method === "POST") {
      if (!auth.is_admin) return errorResponse("Admin required", 403);
      try {
        const body = await req.json() as any;
        if (!body.username) return errorResponse("username is required");
        const validRoles = ["admin", "writer", "reader"];
        const role = validRoles.includes(body.role) ? body.role : "writer";
        const isAdmin = role === "admin" ? 1 : 0;
        const result = db.prepare(
          "INSERT INTO users (username, email, role, is_admin) VALUES (?, ?, ?, ?) RETURNING id, created_at"
        ).get(body.username.trim(), body.email || null, role, isAdmin) as any;
        // Create default space for new user
        db.prepare("INSERT INTO spaces (user_id, name, description) VALUES (?, 'default', 'Default memory space')").run(result.id);
        return json({ id: result.id, username: body.username.trim(), created_at: result.created_at });
      } catch (e: any) {
        if (e.message?.includes("UNIQUE")) return errorResponse("Username already exists", 409);
        return safeError("Operation", e);
      }
    }

    if (url.pathname === "/users" && method === "GET") {
      if (!auth.is_admin) return errorResponse("Admin required", 403);
      const users = db.prepare(
        `SELECT u.id, u.username, u.email, u.is_admin, u.created_at,
           (SELECT COUNT(*) FROM memories WHERE user_id = u.id) as memory_count,
           (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id AND is_active = 1) as key_count
         FROM users u ORDER BY u.id`
      ).all();
      return json({ users });
    }

    // ========================================================================
    // API KEY MANAGEMENT
    // ========================================================================

    if (url.pathname === "/keys" && method === "POST") {
      if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
      try {
        const body = await req.json() as any;
        const targetUserId = body.user_id || auth.user_id;
        // Only admin can create keys for other users
        if (targetUserId !== auth.user_id && !auth.is_admin) return errorResponse("Cannot create keys for other users", 403);
        const { key, prefix, hash } = generateApiKey();
        const name = body.name || "default";
        const scopes = body.scopes || "read,write";
        const rateLimit = Math.min(Math.max(Number(body.rate_limit) || DEFAULT_RATE_LIMIT, 10), 10000);
        db.prepare(
          "INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(targetUserId, prefix, hash, name, scopes, rateLimit);
        return json({ key, name, scopes, rate_limit: rateLimit, user_id: targetUserId, message: "Save this key — it cannot be retrieved again." });
      } catch (e: any) {
        return safeError("Operation", e);
      }
    }

    if (url.pathname === "/keys" && method === "GET") {
      const keys = db.prepare(
        `SELECT id, key_prefix, name, scopes, rate_limit, is_active, last_used_at, created_at
         FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
      ).all(auth.user_id);
      return json({ keys });
    }

    if (url.pathname.match(/^\/keys\/\d+$/) && method === "DELETE") {
      const id = Number(url.pathname.split("/")[2]);
      const key = db.prepare("SELECT user_id FROM api_keys WHERE id = ?").get(id) as any;
      if (!key) return errorResponse("Not found", 404);
      if (key.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
      db.prepare("UPDATE api_keys SET is_active = 0 WHERE id = ?").run(id);
      return json({ revoked: true, id });
    }

    // ========================================================================
    // SPACE MANAGEMENT
    // ========================================================================

    if (url.pathname === "/spaces" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        if (!body.name) return errorResponse("name is required");
        const result = db.prepare(
          "INSERT INTO spaces (user_id, name, description) VALUES (?, ?, ?) RETURNING id, created_at"
        ).get(auth.user_id, body.name.trim(), body.description || null) as any;
        return json({ id: result.id, name: body.name.trim(), created_at: result.created_at });
      } catch (e: any) {
        if (e.message?.includes("UNIQUE")) return errorResponse("Space name already exists", 409);
        return safeError("Operation", e);
      }
    }

    if (url.pathname === "/spaces" && method === "GET") {
      const spaces = db.prepare(
        `SELECT s.id, s.name, s.description, s.created_at,
           (SELECT COUNT(*) FROM memories WHERE space_id = s.id) as memory_count
         FROM spaces s WHERE s.user_id = ? ORDER BY s.name`
      ).all(auth.user_id);
      return json({ spaces });
    }

    if (url.pathname.match(/^\/spaces\/\d+$/) && method === "DELETE") {
      const id = Number(url.pathname.split("/")[2]);
      const space = db.prepare("SELECT user_id, name FROM spaces WHERE id = ?").get(id) as any;
      if (!space) return errorResponse("Not found", 404);
      if (space.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
      if (space.name === "default") return errorResponse("Cannot delete default space", 400);
      db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
      return json({ deleted: true, id });
    }

    // ========================================================================
    // EXPORT — full dump of user's memories
    // ========================================================================

    if (url.pathname === "/export" && method === "GET") {
      if (!hasScope(auth, "read")) return errorResponse("Read scope required", 403);
      const format = url.searchParams.get("format") || "json";
      const spaceFilter = auth.space_id ? "AND space_id = ?" : "";
      const params: any[] = [auth.user_id];
      if (auth.space_id) params.push(auth.space_id);

      const mems = db.prepare(
        `SELECT id, content, category, source, importance, version, is_latest,
           parent_memory_id, root_memory_id, source_count, is_static, is_forgotten,
           is_archived, forget_after, forget_reason, is_inference, created_at, updated_at
         FROM memories WHERE user_id = ? ${spaceFilter} ORDER BY id`
      ).all(...params);

      const memLinks = db.prepare(
        `SELECT ml.source_id, ml.target_id, ml.similarity, ml.type
         FROM memory_links ml
         JOIN memories m ON ml.source_id = m.id
         WHERE m.user_id = ?`
      ).all(auth.user_id);

      const exportData = {
        version: "engram-v5.8",
        exported_at: new Date().toISOString(),
        memories: mems,
        links: memLinks,
        stats: { memory_count: mems.length, link_count: memLinks.length },
      };

      if (format === "jsonl") {
        const lines = mems.map(m => JSON.stringify(m)).join("\n");
        return new Response(lines, {
          headers: securityHeaders({
            "Content-Type": "application/x-ndjson",
            "Content-Disposition": "attachment; filename=engram-export.jsonl",
          }),
        });
      }

      return new Response(JSON.stringify(exportData, null, 2), {
        headers: securityHeaders({
          "Content-Type": "application/json",
          "Content-Disposition": "attachment; filename=engram-export.json",
        }),
      });
    }

    // ========================================================================
    // IMPORT — bulk import memories
    // ========================================================================

    if (url.pathname === "/import" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const items = body.memories || body.items || body;
        if (!Array.isArray(items)) return errorResponse("Expected memories array");
        // S7 FIX: Cap import batch size to prevent resource exhaustion
        if (items.length > 1000) return errorResponse("Import batch too large (max 1000 items per request)", 400);

        let imported = 0, failed = 0;
        const importedIds: number[] = [];
        const importTransaction = db.transaction(() => {
          for (const item of items) {
            try {
              if (!item.content || typeof item.content !== "string") { failed++; continue; }
              const row = db.prepare(
                `INSERT INTO memories (content, category, source, importance, user_id, space_id,
                   is_static, version, source_count, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
                 RETURNING id`
              ).get(
                item.content.trim(),
                item.category || "general",
                item.source || "import",
                Math.max(1, Math.min(10, Number(item.importance) || 5)),
                auth.user_id,
                auth.space_id || null,
                item.is_static ? 1 : 0,
                item.version || 1,
                item.source_count || 1,
                item.created_at || null,
                item.updated_at || null,
              ) as { id: number };
              importedIds.push(row.id);
              imported++;
            } catch { failed++; }
          }
        });
        importTransaction();

        // Backfill embeddings for the exact rows just imported (not older gaps)
        if (importedIds.length > 0) {
          (async () => {
            try {
              const placeholders = importedIds.map(() => "?").join(",");
              const rows = db.prepare(
                `SELECT id, content, category, importance, is_static, source_count FROM memories WHERE id IN (${placeholders}) AND embedding IS NULL`
              ).all(...importedIds) as Array<{ id: number; content: string }>;
              for (const mem of rows) {
                try {
                  const emb = await embed(mem.content);
                  updateMemoryEmbedding.run(embeddingToBuffer(emb), mem.id);
                  writeVec(mem.id, emb);
                  addToEmbeddingCache({ id: mem.id, user_id: auth.user_id, content: mem.content, category: (mem as any).category ?? "general", importance: (mem as any).importance ?? 5, embedding: emb, is_static: !!((mem as any).is_static), source_count: (mem as any).source_count ?? 1, is_latest: true, is_forgotten: false } as any);
                } catch {}
              }
              invalidateEmbeddingCache();
            } catch (e: any) {
              log.error({ msg: "import_backfill_error", error: e.message });
            }
          })();
        }

        return json({ imported, failed, total: items.length });
      } catch (e: any) {
        return safeError("Import", e);
      }
    }

    // ========================================================================
    // HEALTH
    // ========================================================================
    // BENCH RESET -- wipe user-scoped data (only in OPEN_ACCESS mode)
    // Requires a userId AND confirm: "DESTROY" in the request body. NEVER wipes all users' data.
    if (url.pathname === "/reset" && method === "POST") {
      if (!OPEN_ACCESS) return errorResponse("Reset only available in OPEN_ACCESS mode", 403);
      const body = await req.json().catch(() => ({})) as any;
      // Safety: require explicit confirm: "DESTROY" to prevent accidental wipes
      if (body.confirm !== "DESTROY") {
        return errorResponse('Reset requires "confirm": "DESTROY" in the request body. This is a destructive operation.', 400);
      }
      const userId = typeof body.userId === "number" ? body.userId
        : typeof body.user_id === "number" ? body.user_id : null;
      if (userId === null) {
        return errorResponse("userId is required. POST {\"userId\": <number>, \"confirm\": \"DESTROY\"} to reset a specific user's data. Global wipe is disabled.", 400);
      }
      const resetSource = typeof body.source === "string" ? body.source : null;

      // Source-scoped reset: only delete memories matching this source (for benchmarks)
      if (resetSource) {
        const memIds = db.prepare("SELECT id FROM memories WHERE user_id = ? AND source = ?").all(userId, resetSource) as { id: number }[];
        const memIdSet = memIds.map((r) => r.id);
        if (memIdSet.length > 0) {
          for (let i = 0; i < memIdSet.length; i += 500) {
            const chunk = memIdSet.slice(i, i + 500);
            const placeholders = chunk.map(() => "?").join(",");
            const childTables = ["reconsolidations", "causal_links", "memory_entities", "memory_projects", "memory_links"];
            for (const t of childTables) {
              try {
                const col = t === "memory_links" ? "source_id" : "memory_id";
                db.prepare(`DELETE FROM ${t} WHERE ${col} IN (${placeholders})`).run(...chunk);
                if (t === "memory_links") {
                  db.prepare(`DELETE FROM memory_links WHERE target_id IN (${placeholders})`).run(...chunk);
                }
              } catch (e: any) {
                opsCounters.reset_delete_warnings++;
                log.warn({ msg: "reset_child_delete_failed", table: t, user_id: userId, error: e?.message });
              }
            }
          }
          for (let i = 0; i < memIdSet.length; i += 500) {
            const chunk = memIdSet.slice(i, i + 500);
            const placeholders = chunk.map(() => "?").join(",");
            db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...chunk);
          }
        }
        try { db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')"); } catch (e: any) {
          opsCounters.fts_rebuild_failures++;
          log.warn({ msg: "fts_rebuild_failed", table: "memories_fts", error: e?.message });
        }
        invalidateEmbeddingCache();
        log.info({ msg: "reset_by_source", user_id: userId, source: resetSource, memories_deleted: memIdSet.length });
        return json({ reset: true, user_id: userId, source: resetSource, memories_deleted: memIdSet.length, scoped: true });
      }

      // Full user reset: wipe ALL data for this user_id
      // Tables with direct user_id column -- delete rows owned by this user
      const userScopedTables = [
        "causal_chains", "temporal_patterns", "scratchpad", "reflections",
        "digests", "webhooks", "structured_facts", "current_state",
        "user_preferences", "consolidations", "episodes", "entities",
        "projects", "conversations", "personality_signals", "personality_profiles",
      ];
      let wiped = 0;
      // First: delete junction/child rows that reference this user's memories
      const memIds = db.prepare("SELECT id FROM memories WHERE user_id = ?").all(userId) as { id: number }[];
      const memIdSet = memIds.map((r) => r.id);
      if (memIdSet.length > 0) {
        // Batch delete in chunks of 500 to avoid SQLite variable limits
        for (let i = 0; i < memIdSet.length; i += 500) {
          const chunk = memIdSet.slice(i, i + 500);
          const placeholders = chunk.map(() => "?").join(",");
          const childTables = [
            "reconsolidations", "causal_links", "memory_entities",
            "memory_projects", "memory_links",
          ];
          for (const t of childTables) {
            try {
              const col = t === "memory_links" ? "source_id" : "memory_id";
              db.prepare(`DELETE FROM ${t} WHERE ${col} IN (${placeholders})`).run(...chunk);
              if (t === "memory_links") {
                db.prepare(`DELETE FROM memory_links WHERE target_id IN (${placeholders})`).run(...chunk);
              }
            } catch (e: any) {
              opsCounters.reset_delete_warnings++;
              log.warn({ msg: "reset_child_delete_failed", table: t, user_id: userId, error: e?.message });
            }
          }
        }
        wiped++;
      }
      // Delete entity_relationships via this user's entities
      try {
        const entIds = db.prepare("SELECT id FROM entities WHERE user_id = ?").all(userId) as { id: number }[];
        const entIdSet = entIds.map((r) => r.id);
        for (let i = 0; i < entIdSet.length; i += 500) {
          const chunk = entIdSet.slice(i, i + 500);
          const placeholders = chunk.map(() => "?").join(",");
          db.prepare(`DELETE FROM entity_relationships WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`).run(...chunk, ...chunk);
        }
      } catch (e: any) {
        opsCounters.reset_delete_warnings++;
        log.warn({ msg: "reset_entity_relationships_failed", user_id: userId, error: e?.message });
      }
      // Delete messages via this user's conversations
      try {
        db.prepare("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)").run(userId);
      } catch (e: any) {
        opsCounters.reset_delete_warnings++;
        log.warn({ msg: "reset_messages_delete_failed", user_id: userId, error: e?.message });
      }
      // Delete user-scoped tables
      for (const t of userScopedTables) {
        try { db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId); wiped++; } catch (e: any) {
          opsCounters.reset_delete_warnings++;
          log.warn({ msg: "reset_table_delete_failed", table: t, user_id: userId, error: e?.message });
        }
      }
      // Delete memories last (after children are cleaned)
      try { db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId); wiped++; } catch (e: any) {
        opsCounters.reset_delete_warnings++;
        log.warn({ msg: "reset_memories_delete_failed", user_id: userId, error: e?.message });
      }
      // Rebuild FTS indexes
      try { db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')"); } catch (e: any) {
        opsCounters.fts_rebuild_failures++;
        log.warn({ msg: "fts_rebuild_failed", table: "memories_fts", error: e?.message });
      }
      try { db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"); } catch (e: any) {
        opsCounters.fts_rebuild_failures++;
        log.warn({ msg: "fts_rebuild_failed", table: "messages_fts", error: e?.message });
      }
      try { db.exec("INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild')"); } catch (e: any) {
        opsCounters.fts_rebuild_failures++;
        log.warn({ msg: "fts_rebuild_failed", table: "episodes_fts", error: e?.message });
      }
      invalidateEmbeddingCache();
      log.info({ msg: "reset_complete", user_id: userId, memories_deleted: memIdSet.length, tables_wiped: wiped });
      return json({ reset: true, user_id: userId, memories_deleted: memIdSet.length, tables_wiped: wiped });
    }

    // /live — minimal liveness probe (process is up, no auth needed)
    if (url.pathname === "/live" && method === "GET") {
      return json({ status: "ok" });
    }

    // /ready — readiness probe: DB writable, embedding model loaded, LLM reachable
    if (url.pathname === "/ready" && method === "GET") {
      const checks: Record<string, boolean> = {};
      try { db.prepare("SELECT 1").get(); checks.db = true; } catch { checks.db = false; }
      try { checks.embeddings = embeddingCacheLatest.length > 0; } catch { checks.embeddings = false; }
      checks.llm = isLLMAvailable();
      const ready = checks.db && checks.embeddings;
      return json({ status: ready ? "ready" : "degraded", checks }, ready ? 200 : 503);
    }

    if (url.pathname === "/health" && method === "GET") {
      log.debug({ msg: "req", method: "GET", path: "/health", status: 200, ip: clientIp, rid: requestId });
      // Unauthenticated users get minimal health; authenticated get full details
      const healthAuth = getAuthOrDefault(req);
      if (isAuthError(healthAuth)) {
        return json({ error: healthAuth.error }, healthAuth.status, { "X-Request-Id": requestId, ...(healthAuth.headers || {}) });
      }
      const isAuthed = !!healthAuth;
      if (!isAuthed) {
        return json({ status: "ok", version: "5.8.2" });
      }
      // Full health for authenticated users — tenant-scoped for non-admins
      const uid = healthAuth.user_id;
      const isAdmin = healthAuth.is_admin;
      const memWhere = isAdmin ? "" : " AND user_id = ?";
      const memParams = isAdmin ? [] : [uid];
      const ownedWhere = isAdmin ? "" : " WHERE user_id = ?";
      const ownedParams = isAdmin ? [] : [uid];
      const convCount = db.prepare(`SELECT COUNT(*) as count FROM conversations${ownedWhere}`).get(...ownedParams) as { count: number };
      const msgCount = isAdmin
        ? db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number }
        : db.prepare("SELECT COUNT(*) as count FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)").get(uid) as { count: number };
      const linkCount = isAdmin
        ? db.prepare("SELECT COUNT(*) as count FROM memory_links").get() as { count: number }
        : db.prepare("SELECT COUNT(*) as count FROM memory_links WHERE source_id IN (SELECT id FROM memories WHERE user_id = ?)").get(uid) as { count: number };
      const embCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL${memWhere}`).get(...memParams) as { count: number };
      const noEmbCount2 = isAdmin
        ? (countNoEmbedding.get() as { count: number }).count
        : (countNoEmbeddingForUser.get(uid) as { count: number }).count;
      const forgottenCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE is_forgotten = 1${memWhere}`).get(...memParams) as { count: number };
      const staticCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE is_static = 1 AND is_forgotten = 0${memWhere}`).get(...memParams) as { count: number };
      const versionedCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE version > 1${memWhere}`).get(...memParams) as { count: number };
      const archivedCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE is_archived = 1 AND is_forgotten = 0${memWhere}`).get(...memParams) as { count: number };
      const pendingCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE status = 'pending' AND is_forgotten = 0${memWhere}`).get(...memParams) as { count: number };
      const rejectedCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE status = 'rejected'${memWhere}`).get(...memParams) as { count: number };
      const episodeCount = db.prepare(`SELECT COUNT(*) as count FROM episodes${ownedWhere}`).get(...ownedParams) as { count: number };
      const consolidationCount = db.prepare(`SELECT COUNT(*) as count FROM consolidations${ownedWhere}`).get(...ownedParams) as { count: number };
      const taggedCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE tags IS NOT NULL AND is_forgotten = 0${memWhere}`).get(...memParams) as { count: number };
      const entityCount = db.prepare(`SELECT COUNT(*) as count FROM entities${ownedWhere}`).get(...ownedParams) as { count: number };
      const projectCount = db.prepare(`SELECT COUNT(*) as count FROM projects${ownedWhere}`).get(...ownedParams) as { count: number };
      const agentCount = db.prepare(`SELECT COUNT(*) as count FROM agents WHERE is_active = 1${isAdmin ? "" : " AND user_id = ?"}`).get(...(isAdmin ? [] : [uid])) as { count: number };
      const scopedMemCount = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE 1=1${memWhere}`).get(...memParams) as { count: number };
      const dbSize = statSync(DB_PATH).size;
      return json({
        status: "ok",
        version: "5.8.2",
        memories: scopedMemCount.count,
        embedded: embCount.count,
        unembedded: noEmbCount2,
        links: linkCount.count,
        forgotten: forgottenCount.count,
        archived: archivedCount.count,
          pending: pendingCount.count,
          rejected: rejectedCount.count,
        static: staticCount.count,
        versioned: versionedCount.count,
        tagged: taggedCount.count,
        episodes: episodeCount.count,
        consolidations: consolidationCount.count,
        entities: entityCount.count,
        projects: projectCount.count,
        agents: agentCount.count,
        conversations: convCount.count,
        messages: msgCount.count,
        embedding_model: EMBEDDING_MODEL,
        embedding_provider: EMBEDDING_PROVIDER,
        embedding_dim: EMBEDDING_DIM,
        llm_model: LLM_MODEL,
        llm_providers: LLM_PROVIDERS.filter(isProviderAvailable).map(p => p.name),
        llm_configured: isLLMAvailable(),
        features: {
          decay: "fsrs6",
          fsrs6: true,
          dual_strength: true,
          tags: true,
          episodes: true,
          consolidation: isLLMAvailable(),
          typed_relationships: true,
          access_tracking: true,
          confidence: true,
          webhooks: true,
          sync: true,
          pack: true,
          prompt_templates: true,
          auto_tagging: isLLMAvailable(),
          mem0_import: true,
          supermemory_import: true,
          entities: true,
          projects: true,
          scoped_search: true,
          reranker: RERANKER_ENABLED && isLLMAvailable(),
          cross_encoder: isRerankerReady(),
          conversation_extraction: isLLMAvailable(),
          derived_memories: isLLMAvailable(),
          graph: true,
          url_ingest: true,
          contradiction_detection: true,
          contradiction_resolution: isLLMAvailable(),
          time_travel: true,
          smart_context: true,
          reflections: isLLMAvailable(),
          scheduled_digests: true,
          agent_identity: true,
          trust_scoring: true,
          execution_signing: true,
        },
        warnings: (() => {
          const w: string[] = [];
          // Detect embedding dimension mismatch
          try {
            const sample = db.prepare("SELECT embedding FROM memories WHERE embedding IS NOT NULL LIMIT 1").get() as any;
            if (sample?.embedding) {
              const buf = sample.embedding instanceof ArrayBuffer ? sample.embedding
                : sample.embedding.buffer.slice(sample.embedding.byteOffset, sample.embedding.byteOffset + sample.embedding.byteLength);
              const storedDim = buf.byteLength / 4;
              if (storedDim !== EMBEDDING_DIM) {
                w.push(`Stored embeddings are ${storedDim}-dim but configured provider (${EMBEDDING_PROVIDER}) uses ${EMBEDDING_DIM}-dim. Run POST /admin/reembed to fix.`);
              }
            }
          } catch {}
          if (opsCounters.vec_write_failures > 0) w.push(`${opsCounters.vec_write_failures} vector column write failures since startup`);
          if (opsCounters.extraction_failures > 0) w.push(`${opsCounters.extraction_failures} LLM extraction failures since startup`);
          if (opsCounters.fts_rebuild_failures > 0) w.push(`${opsCounters.fts_rebuild_failures} FTS rebuild failures since startup`);
          return w.length > 0 ? w : undefined;
        })(),
        ops_counters: isAdmin ? opsCounters : undefined,
        ...(isAdmin ? { db_size_mb: Math.round(dbSize / 1048576 * 100) / 100 } : {}),
      });
    }

    if (url.pathname === "/scratch" && method === "GET") {
      if (!hasScope(auth, "read")) return errorResponse("Read scope required", 403);
      try {
        const agentFilter = url.searchParams.get("agent");
        const modelFilter = url.searchParams.get("model");
        const sessionFilter = url.searchParams.get("session");
        const rows = listScratchEntries.all(
          auth.user_id,
          agentFilter, agentFilter,
          modelFilter, modelFilter,
          sessionFilter, sessionFilter,
        ) as ScratchEntryRow[];
        return json({
          entries: rows.map((row) => ({
            session: row.session,
            agent: row.agent,
            model: row.model,
            key: row.entry_key,
            value: row.value,
            created_at: row.created_at,
            updated_at: row.updated_at,
            expires_at: row.expires_at,
          })),
          count: rows.length,
        });
      } catch (e: any) {
        return safeError("Scratch list", e);
      }
    }

    if (url.pathname === "/scratch" && method === "PUT") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const session = String(body.session || "").trim();
        const agent = String(body.agent || "").trim();
        const model = String(body.model || "").trim();
        const entries = Array.isArray(body.entries) ? body.entries : [];
        // TTL in minutes: default 30, max 1440 (24h)
        const ttl = Math.max(1, Math.min(1440, Number(body.ttl) || 30));
        if (!session) return errorResponse("session is required");
        if (!agent) return errorResponse("agent is required");
        if (!model) return errorResponse("model is required");
        if (entries.length === 0) return errorResponse("entries array is required");
        if (entries.length > 50) return errorResponse("too many scratch entries (max 50)");

        const cleaned = entries.map((entry: any) => ({
          key: String(entry?.key || "").trim(),
          value: entry?.value == null ? "" : String(entry.value),
        }));
        if (cleaned.some((entry: any) => !entry.key)) return errorResponse("each scratch entry needs a key");

        const ttlStr = String(ttl);
        const tx = db.transaction(() => {
          for (const entry of cleaned) {
            upsertScratchEntryWithTTL.run(auth.user_id, session, agent, model, entry.key, entry.value, ttlStr, ttlStr);
          }
        });
        tx();

        audit(auth.user_id, "scratch_put", "scratchpad", null, JSON.stringify({ session, entries: cleaned.length }), clientIp, requestId, auth.agent_id ?? null);
        const rows = listScratchEntries.all(
          auth.user_id,
          null, null,
          null, null,
          session, session,
        ) as ScratchEntryRow[];
        return json({
          stored: true,
          session,
          count: rows.length,
          entries: rows.map((row) => ({
            session: row.session,
            agent: row.agent,
            model: row.model,
            key: row.entry_key,
            value: row.value,
            updated_at: row.updated_at,
            expires_at: row.expires_at,
          })),
        });
      } catch (e: any) {
        return safeError("Scratch put", e);
      }
    }

    if (url.pathname.match(/^\/scratch\/[^/]+$/) && method === "DELETE") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const session = decodeURIComponent(url.pathname.split("/")[2] || "").trim();
        if (!session) return errorResponse("session is required");

        // Auto-summarize on session end if LLM is available and entries exist
        let summarized = false;
        let summaryId: number | null = null;
        if (isLLMAvailable()) {
          const rows = getScratchSessionAll.all(auth.user_id, session) as ScratchEntryRow[];
          if (rows.length >= 2) { // only summarize if there's meaningful content
            try {
              const agent = rows[0].agent;
              const model = rows[0].model;
              const entriesText = rows.map(r =>
                `[${r.entry_key}] ${r.value || "(empty)"}`
              ).join("\n");

              const summary = await callLLM(
                `You extract lasting knowledge from agent work sessions. Given an agent's scratchpad entries, identify facts worth remembering long-term (infrastructure details, endpoints, architectural decisions, bugs found, solutions). Ignore transient state. If nothing is worth keeping, say "nothing". Be concise.`,
                `Agent: ${agent}\nModel: ${model}\n\nEntries:\n${entriesText}`
              );

              if (summary && summary.toLowerCase().trim() !== "nothing") {
                const content = `[Session summary: ${agent}/${model} #${session.slice(0, 8)}] ${summary.trim()}`;
                const result = insertMemory.get(content, "discovery", agent, null, 5, null, 1, 1, null, null, 1, 0, 0, null, null, 0, model, auth.user_id, auth.space_id || null) as { id: number; created_at: string };
                summaryId = result.id;
                try {
                  const emb = await embed(content);
                  updateMemoryEmbedding.run(embeddingToBuffer(emb), summaryId);
                  try { updateMemoryVec.run(embeddingToVectorJSON(emb), summaryId); } catch {}
                  addToEmbeddingCache({ id: summaryId, embedding: emb, content, category: "discovery", importance: 5, is_static: 0, source_count: 1, user_id: auth.user_id, is_latest: 1, is_forgotten: 0 } as any);
                  await autoLink(summaryId, emb, auth.user_id);
                } catch {}
                summarized = true;
              }
            } catch (e: any) {
              log.warn({ msg: "scratch_auto_summarize_failed", session, error: e.message });
            }
          }
        }

        deleteScratchSession.run(auth.user_id, session);
        audit(auth.user_id, "scratch_delete_session", "scratchpad", summaryId,
          JSON.stringify({ session, auto_summarized: summarized }),
          clientIp, requestId, auth.agent_id ?? null);
        const result: Record<string, any> = { deleted: true, session };
        if (summarized) { result.summarized = true; result.memory_id = summaryId; }
        else if (!isLLMAvailable()) { result.summarized = false; result.reason = "llm_not_available"; }
        return json(result);
      } catch (e: any) {
        return safeError("Scratch delete", e);
      }
    }

    if (url.pathname.match(/^\/scratch\/[^/]+\/[^/]+$/) && method === "DELETE") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const parts = url.pathname.split("/");
        const session = decodeURIComponent(parts[2] || "").trim();
        const key = decodeURIComponent(parts[3] || "").trim();
        if (!session || !key) return errorResponse("session and key are required");
        deleteScratchSessionKey.run(auth.user_id, session, key);
        audit(auth.user_id, "scratch_delete_key", "scratchpad", null, JSON.stringify({ session, key }), clientIp, requestId, auth.agent_id ?? null);
        return json({ deleted: true, session, key });
      } catch (e: any) {
        return safeError("Scratch delete key", e);
      }
    }

    // ========================================================================
    // SCRATCH PROMOTE — push scratchpad entries to permanent memories
    // POST /scratch/:session/promote
    // Optionally filter by keys. Creates one memory per entry (or one combined).
    // ========================================================================

    if (url.pathname.match(/^\/scratch\/[^/]+\/promote$/) && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const session = decodeURIComponent(url.pathname.split("/")[2] || "").trim();
        if (!session) return errorResponse("session is required");

        const body = await req.json().catch(() => ({})) as any;
        const filterKeys: string[] | null = Array.isArray(body.keys) ? body.keys : null;
        const combine = body.combine === true; // combine all entries into one memory
        const category = body.category || "discovery";

        // Get all entries for this session (including expired - they're still in DB until purge)
        const rows = getScratchSessionAll.all(auth.user_id, session) as ScratchEntryRow[];
        if (rows.length === 0) return errorResponse("No entries found for session", 404);

        const filtered = filterKeys
          ? rows.filter(r => filterKeys.includes(r.entry_key))
          : rows;
        if (filtered.length === 0) return errorResponse("No matching entries for specified keys", 404);

        const promoted: number[] = [];

        if (combine) {
          // Single combined memory
          const lines = filtered.map(r => `[${r.agent}] ${r.entry_key}: ${r.value || ""}`);
          const content = `Session ${session.slice(0, 8)} (${filtered[0].agent}): ${lines.join("; ")}`;

          const result = insertMemory.get(
            content, category, filtered[0].agent, null, 5,
            null, 1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
          ) as { id: number; created_at: string };
          const newId = result.id;
          promoted.push(newId);

          // Embed async
          try {
            const emb = await embed(content);
            updateMemoryEmbedding.run(embeddingToBuffer(emb), newId);
            try { updateMemoryVec.run(embeddingToVectorJSON(emb), newId); } catch {}
            addToEmbeddingCache({ id: newId, embedding: emb, content, category, importance: 5, is_static: 0, source_count: 1, user_id: auth.user_id, is_latest: 1, is_forgotten: 0 } as any);
            await autoLink(newId, emb, auth.user_id);
          } catch {}
        } else {
          // One memory per entry
          for (const r of filtered) {
            const content = `${r.entry_key}: ${r.value || ""}`;
            const result = insertMemory.get(
              content, category, r.agent, null, 5,
              null, 1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
            ) as { id: number; created_at: string };
            const newId = result.id;
            promoted.push(newId);

            try {
              const emb = await embed(content);
              updateMemoryEmbedding.run(embeddingToBuffer(emb), newId);
              try { updateMemoryVec.run(embeddingToVectorJSON(emb), newId); } catch {}
              addToEmbeddingCache({ id: newId, embedding: emb, content, category, importance: 5, is_static: 0, source_count: 1, user_id: auth.user_id, is_latest: 1, is_forgotten: 0 } as any);
              await autoLink(newId, emb, auth.user_id);
            } catch {}
          }
        }

        audit(auth.user_id, "scratch_promote", "scratchpad", null,
          JSON.stringify({ session, promoted: promoted.length, combine }),
          clientIp, requestId, auth.agent_id ?? null);

        return json({ promoted: true, session, memory_ids: promoted, count: promoted.length });
      } catch (e: any) {
        return safeError("Scratch promote", e);
      }
    }

    // ========================================================================
    // SCRATCH SUMMARIZE — LLM-summarize session and store as permanent memory
    // POST /scratch/:session/summarize
    // Best called at session end before DELETE. Creates a single summary memory.
    // ========================================================================

    if (url.pathname.match(/^\/scratch\/[^/]+\/summarize$/) && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const session = decodeURIComponent(url.pathname.split("/")[2] || "").trim();
        if (!session) return errorResponse("session is required");

        const body = await req.json().catch(() => ({})) as any;
        const deleteAfter = body.delete !== false; // default: clean up after summarizing

        const rows = getScratchSessionAll.all(auth.user_id, session) as ScratchEntryRow[];
        if (rows.length === 0) return errorResponse("No entries found for session", 404);

        const agent = rows[0].agent;
        const model = rows[0].model;
        const entriesText = rows.map(r =>
          `[${r.entry_key}] ${r.value || "(empty)"} (set ${r.created_at}, updated ${r.updated_at})`
        ).join("\n");

        let summary: string;

        if (isLLMAvailable()) {
          summary = await callLLM(
            `You extract lasting knowledge from agent work sessions. Given an agent's scratchpad entries from a session, identify facts, decisions, or discoveries worth remembering long-term. Ignore transient state (files being edited, tasks in progress). Focus on: infrastructure details, credentials/endpoints, architectural decisions, bugs found, solutions applied. If nothing is worth keeping, say "nothing". Be concise - one line per fact.`,
            `Agent: ${agent}\nModel: ${model}\nSession: ${session}\n\nEntries:\n${entriesText}`
          );
        } else {
          // No LLM: just combine entries as-is
          summary = rows.map(r => `${r.entry_key}: ${r.value || ""}`).join("\n");
        }

        if (!summary || summary.toLowerCase().trim() === "nothing") {
          if (deleteAfter) deleteScratchSession.run(auth.user_id, session);
          return json({ summarized: true, session, stored: false, reason: "nothing worth keeping" });
        }

        const content = `[Session summary: ${agent}/${model} #${session.slice(0, 8)}] ${summary.trim()}`;
        const result = insertMemory.get(
          content, "discovery", agent, null, 5,
          null, 1, 1, null, null, 1, 0, 0, null, null, 0, model, auth.user_id, auth.space_id || null
        ) as { id: number; created_at: string };
        const newId = result.id;

        try {
          const emb = await embed(content);
          updateMemoryEmbedding.run(embeddingToBuffer(emb), newId);
          try { updateMemoryVec.run(embeddingToVectorJSON(emb), newId); } catch {}
          addToEmbeddingCache({ id: newId, embedding: emb, content, category: "discovery", importance: 5, is_static: 0, source_count: 1, user_id: auth.user_id, is_latest: 1, is_forgotten: 0 } as any);
          await autoLink(newId, emb, auth.user_id);
        } catch {}

        if (deleteAfter) deleteScratchSession.run(auth.user_id, session);

        audit(auth.user_id, "scratch_summarize", "scratchpad", newId,
          JSON.stringify({ session, entries: rows.length, delete_after: deleteAfter }),
          clientIp, requestId, auth.agent_id ?? null);

        return json({ summarized: true, session, stored: true, memory_id: newId, content });
      } catch (e: any) {
        return safeError("Scratch summarize", e);
      }
    }

    // ========================================================================
    // CONVERSATION EXTRACTION — POST /add (Mem0-compatible)
    // ========================================================================

    if (url.pathname === "/add" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      if (!isLLMAvailable()) return errorResponse("LLM not configured — /add requires fact extraction", 400);
      try {
        const body = await req.json() as any;
        const messages = body.messages as Array<{ role: string; content: string }>;
        if (!Array.isArray(messages) || messages.length === 0) {
          return errorResponse("messages array required: [{role: 'user'|'assistant'|'system', content: '...'}]");
        }

        const category = body.category || "general";
        const source = body.source || "conversation";
        const projectIds = body.project_ids as number[] | undefined;
        const entityIds = body.entity_ids as number[] | undefined;
        const episodeId = body.episode_id as number | undefined;

        // Format conversation for extraction
        const convoText = messages.map(m => `${m.role}: ${m.content}`).join("\n\n");

        const extractionPrompt = `You are a fact extraction engine. Analyze this conversation and extract distinct, atomic facts worth remembering long-term.

Rules:
- Extract facts primarily from USER messages. Only extract from ASSISTANT messages if they contain genuinely novel information (not just rephrasing the user).
- Each fact should be ONE self-contained statement. If you can't summarize it in under 50 words, split it.
- Skip greetings, filler, questions without assertions, and transient information.
- For each fact, classify:
  - category: task|discovery|decision|state|issue|general
  - importance: 1-10 (9-10=critical decisions, 7-8=useful knowledge, 5-6=context, <5=minor)
  - is_static: true if this is a permanent/rarely-changing fact, false if temporal
  - is_correction: true if this fact corrects, overrides, or clarifies a previously stated fact
  - tags: 2-5 lowercase keyword tags
- Detect temporal facts and set forget_after if appropriate (ISO datetime or null)

CRITICAL — Correction detection:
- If a USER message corrects the assistant (e.g. "no, X is Y", "that's wrong", "actually...", "I told you", "you forgot"), the corrected fact should:
  - Have is_correction: true
  - Have is_static: true (corrections are permanent by default)
  - Have importance: 9 or higher
  - Have the tag "correction"
  - State the CORRECT information clearly, not the wrong information
- Corrections about infrastructure, preferences, identities, or operational facts are the MOST important facts in any conversation. Never skip them.

Return JSON:
{
  "facts": [
    {
      "content": "extracted fact as a clear statement",
      "category": "task",
      "importance": 7,
      "is_static": false,
      "is_correction": false,
      "tags": ["keyword1", "keyword2"],
      "forget_after": null
    }
  ]
}

If no meaningful facts, return {"facts": []}`;

        const llmResp = await callLLM(extractionPrompt, convoText);
        if (!llmResp) return json({ added: 0, facts: [] });

        // Parse extracted facts
        let extracted: { facts: Array<any> };
        try {
          const cleaned = llmResp.replace(/```json\n?|\n?```/g, "").trim();
          // Try direct parse first, then extract JSON object
          try {
            extracted = JSON.parse(cleaned);
          } catch {
            const jsonMatch = cleaned.match(/\{[\s\S]*"facts"[\s\S]*\}/);
            if (jsonMatch) {
              extracted = JSON.parse(jsonMatch[0]);
            } else {
              log.error({ msg: "conversation_extraction_parse_error", response: cleaned.substring(0, 500) });
              return errorResponse("LLM returned unparseable response", 500);
            }
          }
        } catch (parseErr: any) {
          log.error({ msg: "conversation_extraction_error", error: parseErr.message });
          return errorResponse("LLM returned unparseable response", 500);
        }

        if (!extracted.facts?.length) return json({ added: 0, facts: [] });

        // Store each fact as a memory
        const stored: Array<{ id: number; content: string; category: string; is_correction?: boolean }> = [];
        for (const fact of extracted.facts) {
          if (!fact.content?.trim()) continue;

          // Corrections get elevated treatment
          const isCorrection = !!fact.is_correction;
          const effectiveImportance = isCorrection ? Math.max(fact.importance || 9, 9) : (fact.importance || DEFAULT_IMPORTANCE);
          const effectiveStatic = isCorrection ? 1 : (fact.is_static ? 1 : 0);
          const effectiveTags = fact.tags || [];
          if (isCorrection && !effectiveTags.includes("correction")) effectiveTags.push("correction");

          let embBuffer: Buffer | null = null;
          let embArray: Float32Array | null = null;
          try {
            embArray = await embed(fact.content.trim());
            embBuffer = embeddingToBuffer(embArray);
          } catch {}

          const result = insertMemory.get(
            fact.content.trim(), fact.category || category, source, null,
            effectiveImportance, embBuffer,
            1, 1, null, null, 1, effectiveStatic, 0,
            fact.forget_after || null, null, 0, null, auth.user_id, auth.space_id || null
          ) as { id: number; created_at: string };

          const syncId = randomUUID();
          const tagsJson = effectiveTags.length ? JSON.stringify(effectiveTags) : null;
          db.prepare(
            "UPDATE memories SET tags = ?, episode_id = ?, sync_id = ?, confidence = 1.0 WHERE id = ?"
          ).run(tagsJson, episodeId || null, syncId, result.id);

        // Link to entities/projects
        for (const eid of getOwnedEntityIds(entityIds, auth)) linkMemoryEntity.run(result.id, eid);
        for (const pid of getOwnedProjectIds(projectIds, auth)) linkMemoryProject.run(result.id, pid);

          // Auto-link
          if (embArray) { writeVec(result.id, embArray); await autoLink(result.id, embArray, auth.user_id); }

          // Queue async fact extraction (for relationship detection)
          if (LLM_API_KEY) {
            (async () => {
              try {
                // S4 FIX: extractFacts takes (content, category, similarMemories), not (id, content, embedding)
                const allMems = getCachedEmbeddings(true, auth.user_id);
                const sims: Array<{ id: number; content: string; category: string; score: number }> = [];
                if (embArray) {
                  for (const mem of allMems) {
                    if (mem.id === result.id) continue;
                    const sim = cosineSimilarity(embArray, mem.embedding);
                    if (sim > 0.4) sims.push({ id: mem.id, content: mem.content, category: mem.category, score: sim });
                  }
                  sims.sort((a, b) => b.score - a.score);
                }
                const extraction = await extractFacts(fact.content.trim(), fact.category || category, sims.slice(0, 3));
                if (extraction) {
                  // If the fact was flagged as a correction AND extraction found a relation, force "corrects"
                  if (isCorrection && extraction.relation_to_existing.existing_memory_id && extraction.relation_to_existing.type !== "corrects") {
                    extraction.relation_to_existing.type = "corrects";
                  }
                  processExtractionResult(result.id, extraction, embArray, auth.user_id);
                }
              } catch (e: any) {
                opsCounters.extraction_failures++;
                log.warn({ msg: "async_extraction_failed", memory_id: result.id, error: e?.message });
              }
            })();
          }

          emitWebhookEvent("memory.created", {
            id: result.id, content: fact.content.trim(), category: fact.category || category,
            importance: effectiveImportance, source: "conversation", is_correction: isCorrection,
          }, auth.user_id);

          stored.push({ id: result.id, content: fact.content.trim(), category: fact.category || category, is_correction: isCorrection || undefined });
          if (isCorrection) {
            log.info({ msg: "correction_from_conversation", id: result.id, content: fact.content.trim().substring(0, 100) });
          }
        }

        return json({
          added: stored.length,
          facts: stored,
          source: "conversation",
          messages_processed: messages.length,
        });
      } catch (e: any) {
        return safeError("Conversation extraction", e);
      }
    }

    // ========================================================================
    // INGEST — Extract memories from URLs or text blobs
    // ========================================================================

    if (url.pathname === "/ingest" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      if (!isLLMAvailable()) return errorResponse("LLM not configured — /ingest requires fact extraction", 400);
      try {
        const body = await req.json() as any;
        const { url: ingestUrl, text: ingestText, entity_ids, project_ids, episode_id, source } = body;

        if (!ingestUrl && !ingestText) {
          return errorResponse("Provide 'url' (string) or 'text' (string)");
        }

        let rawText = "";
        let ingestSource = source || "ingest";
        let title = "";

        // --- Fetch URL ---
        if (ingestUrl) {
          if (typeof ingestUrl !== "string" || !ingestUrl.match(/^https?:\/\//)) {
            return errorResponse("url must be a valid http/https URL");
          }
          // S7 FIX: SSRF protection — block private/internal IPs (same as webhook validation)
          try {
            const ingestParsed = new URL(ingestUrl);
            const hn = ingestParsed.hostname.toLowerCase();
            if (hn === "localhost" || hn === "127.0.0.1" || hn === "::1" || hn === "0.0.0.0" ||
                hn.startsWith("10.") || hn.startsWith("192.168.") || hn.startsWith("172.16.") ||
                hn.startsWith("172.17.") || hn.startsWith("172.18.") || hn.startsWith("172.19.") ||
                hn.startsWith("172.2") || hn.startsWith("172.30.") || hn.startsWith("172.31.") ||
                hn.endsWith(".local") || hn.endsWith(".internal") || hn.startsWith("100.64.") ||
                hn.startsWith("169.254.") || hn.startsWith("fc") || hn.startsWith("fd") || hn === "[::1]") {
              return errorResponse("Ingest URL cannot point to private/internal addresses", 400);
            }
          } catch { return errorResponse("Invalid ingest URL", 400); }
          try {
            const resp = await fetch(ingestUrl, {
              headers: { "User-Agent": "Engram/4.4 (memory ingest)" },
              redirect: "follow",
              signal: AbortSignal.timeout(15000),
            });
            if (!resp.ok) return errorResponse(`Fetch failed: ${resp.status} ${resp.statusText}`, 502);

            const contentType = resp.headers.get("content-type") || "";
            const raw = await resp.text();

            if (contentType.includes("html")) {
              // Extract title
              const titleMatch = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
              title = titleMatch ? titleMatch[1].trim() : new URL(ingestUrl).hostname;

              // Strip HTML to text using a robust HTML-to-text converter
              const extractedText = htmlToText(raw, {
                wordwrap: false,
                selectors: [
                  { selector: "script", format: "skip" },
                  { selector: "style", format: "skip" },
                  { selector: "nav", format: "skip" },
                  { selector: "footer", format: "skip" },
                  { selector: "header", format: "skip" },
                  { selector: "aside", format: "skip" },
                ],
              });
              rawText = extractedText
                .replace(/\n{3,}/g, "\n\n")
                .replace(/ {2,}/g, " ")
                .trim();
            } else {
              // Plain text, JSON, etc — use as-is
              rawText = raw.trim();
              title = new URL(ingestUrl).pathname.split("/").pop() || ingestUrl;
            }
            ingestSource = `url:${ingestUrl}`;
          } catch (fetchErr: any) {
            return errorResponse(`Fetch error: ${fetchErr.message}`, 502);
          }
        }

        // --- Raw text ---
        if (ingestText) {
          if (typeof ingestText !== "string" || ingestText.trim().length === 0) {
            return errorResponse("text must be a non-empty string");
          }
          rawText = ingestText.trim();
          title = body.title || rawText.substring(0, 60).replace(/\n/g, " ");
          ingestSource = source || "text";
        }

        // Truncate to ~12K chars for LLM context
        const MAX_INGEST = 12000;
        const truncated = rawText.length > MAX_INGEST;
        if (truncated) rawText = rawText.substring(0, MAX_INGEST);

        // --- Chunk into segments for extraction ---
        const CHUNK_SIZE = 3000;
        const CHUNK_OVERLAP = 200;
        const chunks: string[] = [];
        if (rawText.length <= CHUNK_SIZE) {
          chunks.push(rawText);
        } else {
          let pos = 0;
          while (pos < rawText.length) {
            let end = Math.min(pos + CHUNK_SIZE, rawText.length);
            // Try to break at paragraph or sentence boundary
            if (end < rawText.length) {
              const paraBreak = rawText.lastIndexOf("\n\n", end);
              if (paraBreak > pos + CHUNK_SIZE * 0.5) end = paraBreak;
              else {
                const sentBreak = rawText.lastIndexOf(". ", end);
                if (sentBreak > pos + CHUNK_SIZE * 0.5) end = sentBreak + 1;
              }
            }
            chunks.push(rawText.substring(pos, end));
            pos = end > pos ? end - CHUNK_OVERLAP : end + 1;
            if (pos >= rawText.length) break;
          }
        }

        // --- Extract facts from each chunk ---
        const allFacts: Array<{ id: number; content: string; category: string }> = [];
        let chunkNum = 0;

        for (const chunk of chunks) {
          chunkNum++;
          const extractionPrompt = `You are a fact extraction engine. Analyze this text and extract distinct, atomic facts worth remembering long-term.

Source: ${title}${ingestUrl ? ` (${ingestUrl})` : ""}
Chunk ${chunkNum}/${chunks.length}${truncated ? " (document was truncated)" : ""}

Rules:
- Each fact should be ONE self-contained statement. Under 50 words each.
- Skip boilerplate, navigation text, ads, cookie notices, and filler.
- Preserve specific numbers, names, dates, and technical details.
- For each fact, classify:
  - category: task|discovery|decision|state|issue|general
  - importance: 1-10
  - is_static: true if permanent/rarely-changing, false if temporal
  - tags: 2-5 lowercase keyword tags
- If the text has no meaningful facts, return {"facts": []}

Return JSON:
{
  "facts": [
    {
      "content": "extracted fact as a clear statement",
      "category": "discovery",
      "importance": 7,
      "is_static": true,
      "tags": ["keyword1", "keyword2"]
    }
  ]
}`;

          const llmResp = await callLLM(extractionPrompt, chunk);
          if (!llmResp) continue;

          let extracted: { facts: Array<any> };
          try {
            const cleaned = llmResp.replace(/```json\n?|\n?```/g, "").trim();
            try {
              extracted = JSON.parse(cleaned);
            } catch {
              const jsonMatch = cleaned.match(/\{[\s\S]*"facts"[\s\S]*\}/);
              if (jsonMatch) extracted = JSON.parse(jsonMatch[0]);
              else continue;
            }
          } catch { continue; }

          if (!extracted.facts?.length) continue;

          for (const fact of extracted.facts) {
            if (!fact.content?.trim()) continue;

            let embBuffer: Buffer | null = null;
            let embArray: Float32Array | null = null;
            try {
              embArray = await embed(fact.content.trim());
              embBuffer = embeddingToBuffer(embArray);
            } catch {}

            const result = insertMemory.get(
              fact.content.trim(), fact.category || "general", ingestSource, null,
              fact.importance || DEFAULT_IMPORTANCE, embBuffer,
              1, 1, null, null, 1, fact.is_static ? 1 : 0, 0,
              null, null, 0, null, auth.user_id, auth.space_id || null
            ) as { id: number; created_at: string };

            const syncId = randomUUID();
            const tags = fact.tags?.length ? JSON.stringify(fact.tags) : null;
            db.prepare(
              "UPDATE memories SET tags = ?, episode_id = ?, sync_id = ?, confidence = 1.0 WHERE id = ?"
            ).run(tags, episode_id || null, syncId, result.id);

            for (const eid of getOwnedEntityIds(entity_ids, auth)) linkMemoryEntity.run(result.id, eid);
            for (const pid of getOwnedProjectIds(project_ids, auth)) linkMemoryProject.run(result.id, pid);

            if (embArray) { writeVec(result.id, embArray); await autoLink(result.id, embArray, auth.user_id); }

            if (LLM_API_KEY) {
              (async () => {
                try {
                  // S4 FIX: extractFacts takes (content, category, similarMemories)
                  const allMems = getCachedEmbeddings(true, auth.user_id);
                  const sims: Array<{ id: number; content: string; category: string; score: number }> = [];
                  if (embArray) {
                    for (const mem of allMems) {
                      if (mem.id === result.id) continue;
                      const sim = cosineSimilarity(embArray, mem.embedding);
                      if (sim > 0.4) sims.push({ id: mem.id, content: mem.content, category: mem.category, score: sim });
                    }
                    sims.sort((a, b) => b.score - a.score);
                  }
                  const extraction = await extractFacts(fact.content.trim(), fact.category || "general", sims.slice(0, 3));
                  if (extraction) processExtractionResult(result.id, extraction, embArray, auth.user_id);
                } catch (e: any) {
                  opsCounters.extraction_failures++;
                  log.warn({ msg: "async_extraction_failed", memory_id: result.id, error: e?.message });
                }
              })();
            }

            emitWebhookEvent("memory.created", {
              id: result.id, content: fact.content.trim(), category: fact.category || "general",
              importance: fact.importance || DEFAULT_IMPORTANCE, source: ingestSource,
            }, auth.user_id);

            allFacts.push({ id: result.id, content: fact.content.trim(), category: fact.category || "general" });
          }
        }

        return json({
          ingested: allFacts.length,
          facts: allFacts,
          source: ingestSource,
          title,
          chunks_processed: chunks.length,
          truncated,
        });
      } catch (e: any) {
        return safeError("Ingest", e);
      }
    }

    // ========================================================================
    // CONTRADICTION DETECTION — find conflicting memories
    // ========================================================================

    if (url.pathname === "/contradictions" && method === "GET") {
      try {
        const threshold = Number(url.searchParams.get("threshold") || 0.6);
        const limitParam = Math.min(Number(url.searchParams.get("limit") || 30), 100);
        const useLLM = url.searchParams.get("verify") === "true" && isLLMAvailable();

        // Get all contradicts-type links first (already detected by fact extraction)
        const knownContradictions = db.prepare(
          `SELECT ml.source_id, ml.target_id, ml.similarity,
             ms.content as source_content, ms.category as source_category, ms.created_at as source_created,
             mt.content as target_content, mt.category as target_category, mt.created_at as target_created
           FROM memory_links ml
           JOIN memories ms ON ml.source_id = ms.id
           JOIN memories mt ON ml.target_id = mt.id
           WHERE ml.type = 'contradicts' AND ms.user_id = ? AND mt.user_id = ? AND ms.is_forgotten = 0 AND mt.is_forgotten = 0
           ORDER BY ml.created_at DESC LIMIT ?`
        ).all(auth.user_id, auth.user_id, limitParam) as any[];

        const contradictions: Array<{
          memory_a: { id: number; content: string; category: string; created_at: string };
          memory_b: { id: number; content: string; category: string; created_at: string };
          similarity: number;
          source: string;
          verified?: boolean;
          explanation?: string;
        }> = [];

        // Add known contradictions
        for (const c of knownContradictions) {
          contradictions.push({
            memory_a: { id: c.source_id, content: c.source_content, category: c.source_category, created_at: c.source_created },
            memory_b: { id: c.target_id, content: c.target_content, category: c.target_category, created_at: c.target_created },
            similarity: c.similarity,
            source: "link",
          });
        }

        // Scan for potential contradictions: high similarity but different content patterns
        // Same category memories with high embedding similarity often contain updates/contradictions
        if (contradictions.length < limitParam) {
          const allMems = getCachedEmbeddings(true, auth.user_id);

          const seenPairs = new Set(contradictions.map(c =>
            `${Math.min(c.memory_a.id, c.memory_b.id)}-${Math.max(c.memory_a.id, c.memory_b.id)}`
          ));

          const candidates: Array<{ a: any; b: any; sim: number }> = [];

          for (let i = 0; i < allMems.length && candidates.length < limitParam * 3; i++) {
            const embA = allMems[i].embedding;
            for (let j = i + 1; j < allMems.length; j++) {
              const pairKey = `${Math.min(allMems[i].id, allMems[j].id)}-${Math.max(allMems[i].id, allMems[j].id)}`;
              if (seenPairs.has(pairKey)) continue;

              // Same or related category + high similarity = potential contradiction
              if (allMems[i].category !== allMems[j].category && threshold < 0.8) continue;

              const embB = allMems[j].embedding;
              const sim = cosineSimilarity(embA, embB);

              // Sweet spot: similar enough to be about the same thing (>0.6) but not identical (>0.95)
              if (sim >= threshold && sim < 0.95) {
                candidates.push({ a: allMems[i], b: allMems[j], sim });
                seenPairs.add(pairKey);
              }
            }
          }

          candidates.sort((x, y) => y.sim - x.sim);
          const toVerify = candidates.slice(0, limitParam - contradictions.length);

          if (useLLM && toVerify.length > 0) {
            // Batch verify with LLM
            const pairs = toVerify.map((c, i) =>
              `[Pair ${i}]\nA (#${c.a.id}): ${c.a.content.substring(0, 300)}\nB (#${c.b.id}): ${c.b.content.substring(0, 300)}`
            ).join("\n\n");

            const verifyPrompt = `You detect contradictions between memory pairs. For each pair, determine if they CONTRADICT each other (state conflicting facts about the same thing).

NOT contradictions: updates (B supersedes A), extensions (B adds to A), or unrelated.
IS a contradiction: A says X, B says NOT-X or a different value for the same property.

Return JSON array:
[
  { "pair": 0, "contradicts": true/false, "explanation": "brief reason" },
  ...
]

Only include pairs that are actual contradictions.`;

            try {
              const resp = await callLLM(verifyPrompt, pairs);
              const cleaned = resp.replace(/```json\n?|\n?```/g, "").trim();
              const results = JSON.parse(cleaned) as Array<{ pair: number; contradicts: boolean; explanation: string }>;

              for (const r of results) {
                if (r.contradicts && toVerify[r.pair]) {
                  const c = toVerify[r.pair];
                  contradictions.push({
                    memory_a: { id: c.a.id, content: c.a.content, category: c.a.category, created_at: "" },
                    memory_b: { id: c.b.id, content: c.b.content, category: c.b.category, created_at: "" },
                    similarity: Math.round(c.sim * 1000) / 1000,
                    source: "scan",
                    verified: true,
                    explanation: r.explanation,
                  });
                }
              }
            } catch (llmErr: any) {
              // Fall back to returning unverified candidates
              for (const c of toVerify) {
                contradictions.push({
                  memory_a: { id: c.a.id, content: c.a.content, category: c.a.category, created_at: "" },
                  memory_b: { id: c.b.id, content: c.b.content, category: c.b.category, created_at: "" },
                  similarity: Math.round(c.sim * 1000) / 1000,
                  source: "scan",
                  verified: false,
                });
              }
            }
          } else {
            for (const c of toVerify) {
              contradictions.push({
                memory_a: { id: c.a.id, content: c.a.content, category: c.a.category, created_at: "" },
                memory_b: { id: c.b.id, content: c.b.content, category: c.b.category, created_at: "" },
                similarity: Math.round(c.sim * 1000) / 1000,
                source: "scan",
              });
            }
          }
        }

        return json({
          contradictions: contradictions.slice(0, limitParam),
          total: contradictions.length,
          threshold,
          verified: useLLM,
        });
      } catch (e: any) {
        return safeError("Contradiction scan", e);
      }
    }

    // ========================================================================
    // CONTRADICTION RESOLUTION — resolve a specific contradiction
    // ========================================================================

    if (url.pathname === "/contradictions/resolve" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const { memory_a_id, memory_b_id, resolution } = body;
        // resolution: "keep_a" | "keep_b" | "keep_both" | "merge"

        if (!memory_a_id || !memory_b_id || !resolution) {
          return errorResponse("memory_a_id, memory_b_id, and resolution (keep_a|keep_b|keep_both|merge) required");
        }

        const memA = getMemoryWithoutEmbedding.get(memory_a_id) as any;
        const memB = getMemoryWithoutEmbedding.get(memory_b_id) as any;
        if (!memA || !memB) return errorResponse("One or both memories not found", 404);
        if (!canAccessOwnedRow(memA, auth) || !canAccessOwnedRow(memB, auth)) return errorResponse("Forbidden", 403);

        if (resolution === "keep_a") {
          markArchived.run(memory_b_id);
          insertLink.run(memory_a_id, memory_b_id, 1.0, "resolves");
          // Remove contradicts links
          db.prepare("DELETE FROM memory_links WHERE type = 'contradicts' AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))").run(memory_a_id, memory_b_id, memory_b_id, memory_a_id);
          return json({ resolved: true, kept: memory_a_id, archived: memory_b_id });
        }

        if (resolution === "keep_b") {
          markArchived.run(memory_a_id);
          insertLink.run(memory_b_id, memory_a_id, 1.0, "resolves");
          db.prepare("DELETE FROM memory_links WHERE type = 'contradicts' AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))").run(memory_a_id, memory_b_id, memory_b_id, memory_a_id);
          return json({ resolved: true, kept: memory_b_id, archived: memory_a_id });
        }

        if (resolution === "keep_both") {
          // Remove the contradiction link, mark as intentional
          db.prepare("DELETE FROM memory_links WHERE type = 'contradicts' AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))").run(memory_a_id, memory_b_id, memory_b_id, memory_a_id);
          insertLink.run(memory_a_id, memory_b_id, 0.9, "related");
          return json({ resolved: true, action: "kept_both", linked: true });
        }

        if (resolution === "merge" && LLM_API_KEY) {
          const mergeResp = await callLLM(
            `Merge these two contradicting memories into a single accurate memory. Preserve the most recent/correct information. Return JSON: {"content": "merged text", "category": "category"}`,
            `Memory A (#${memA.id}, created ${memA.created_at}): ${memA.content}\n\nMemory B (#${memB.id}, created ${memB.created_at}): ${memB.content}`
          );
          const cleaned = mergeResp.replace(/```json\n?|\n?```/g, "").trim();
          const merged = JSON.parse(cleaned) as { content: string; category: string };

          let embBuffer: Buffer | null = null;
          let embArray: Float32Array | null = null;
          try { embArray = await embed(merged.content); embBuffer = embeddingToBuffer(embArray); } catch {}

          const result = insertMemory.get(
            merged.content, merged.category || memA.category, "contradiction-merge", null,
            Math.max(memA.importance, memB.importance), embBuffer,
            1, 1, null, null, (memA.source_count || 1) + (memB.source_count || 1), 0, 0, null, null, 0,
            memB.model || memA.model || null, auth.user_id, auth.space_id || null
          ) as { id: number; created_at: string };
          db.prepare("UPDATE memories SET tags = ?, episode_id = ?, confidence = ? WHERE id = ?")
            .run(memB.tags || memA.tags || null, memB.episode_id || memA.episode_id || null, Math.max(memA.confidence ?? 0, memB.confidence ?? 0, 1.0), result.id);

          markArchived.run(memory_a_id);
          markArchived.run(memory_b_id);
          insertLink.run(result.id, memory_a_id, 1.0, "resolves");
          insertLink.run(result.id, memory_b_id, 1.0, "resolves");
          db.prepare("DELETE FROM memory_links WHERE type = 'contradicts' AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))").run(memory_a_id, memory_b_id, memory_b_id, memory_a_id);

          if (embArray) { writeVec(result.id, embArray); await autoLink(result.id, embArray, auth.user_id); }

          return json({ resolved: true, merged_memory_id: result.id, content: merged.content, archived: [memory_a_id, memory_b_id] });
        }

        return errorResponse("Invalid resolution. Use: keep_a, keep_b, keep_both, merge");
      } catch (e: any) {
        return safeError("Resolution", e);
      }
    }

    // ========================================================================
    // TIME-TRAVEL — query memory state at a point in time
    // ========================================================================

    if (url.pathname === "/timetravel" && method === "POST") {
      try {
        const body = await req.json() as any;
        const { as_of, query, category, limit: lim } = body;

        if (!as_of) return errorResponse("as_of (ISO datetime) required");

        const asOfDate = new Date(as_of);
        if (isNaN(asOfDate.getTime())) return errorResponse("as_of must be valid ISO datetime");

        const asOfStr = asOfDate.toISOString().replace("T", " ").replace("Z", "");
        const resultLimit = Math.min(Number(lim) || 50, 200);

        // Get memories that existed at as_of, considering version chains
        // A memory was "current" at time T if:
        // 1. It was created before T
        // 2. It was either still is_latest OR was superseded after T
        let timeMemories: any[];

        if (query) {
          // Semantic search within the time window
          const embQ = await embed(query);
          const allMems = db.prepare(
            `SELECT id, content, category, source, importance, embedding, created_at, updated_at,
               version, is_latest, root_memory_id, parent_memory_id, is_static, is_forgotten, tags,
               is_archived, confidence, decay_score
             FROM memories
             WHERE created_at <= ? AND is_forgotten = 0 AND embedding IS NOT NULL AND user_id = ?
             ORDER BY created_at DESC`
          ).all(asOfStr, auth.user_id) as any[];

          // For version chains, find which version was current at as_of
          const rootLatest = new Map<number, any>(); // root_id -> best version at as_of
          const standalone: any[] = [];

          for (const m of allMems) {
            if (m.root_memory_id) {
              const rootId = m.root_memory_id;
              const existing = rootLatest.get(rootId);
              if (!existing || new Date(m.created_at) > new Date(existing.created_at)) {
                rootLatest.set(rootId, m);
              }
            } else if (!m.parent_memory_id) {
              // Check if this was later superseded — if so, check if superseded after as_of
              const laterVersion = db.prepare(
                `SELECT id, created_at FROM memories WHERE parent_memory_id = ? AND created_at <= ? ORDER BY created_at ASC LIMIT 1`
              ).get(m.id, asOfStr) as any;

              if (!laterVersion) {
                standalone.push(m); // No later version at that time — this was current
              }
              // If there IS a later version, that version will be picked up by the root chain logic
            }
          }

          const candidates = [...standalone, ...Array.from(rootLatest.values())];

          // Score by semantic similarity
          const scored = candidates.map(m => {
            const emb = bufferToEmbedding(m.embedding);
            const sim = cosineSimilarity(embQ, emb);
            return { ...m, similarity: sim, embedding: undefined };
          }).filter(m => m.similarity > 0.3);

          scored.sort((a, b) => b.similarity - a.similarity);
          timeMemories = scored.slice(0, resultLimit);
        } else {
          // Just list memories as of that time
          let catFilter = "";
          const params: any[] = [asOfStr, auth.user_id];
          if (category) {
            catFilter = " AND category = ?";
            params.push(category);
          }
          params.push(resultLimit);

          timeMemories = db.prepare(
            `SELECT id, content, category, source, importance, created_at, updated_at,
               version, is_latest, root_memory_id, is_static, tags, confidence
             FROM memories
             WHERE created_at <= ? AND is_forgotten = 0 AND user_id = ?${catFilter}
             AND (is_latest = 1 OR updated_at > ?)
             ORDER BY created_at DESC LIMIT ?`
          ).all(...[...params.slice(0, -1), asOfStr, ...params.slice(-1)]) as any[];
        }

        // Count stats at that time
        const statsAtTime = db.prepare(
          `SELECT COUNT(*) as total,
             SUM(CASE WHEN is_static = 1 THEN 1 ELSE 0 END) as static_count,
             SUM(CASE WHEN category = 'task' THEN 1 ELSE 0 END) as tasks,
             SUM(CASE WHEN category = 'state' THEN 1 ELSE 0 END) as states,
             SUM(CASE WHEN category = 'decision' THEN 1 ELSE 0 END) as decisions,
             SUM(CASE WHEN category = 'discovery' THEN 1 ELSE 0 END) as discoveries,
             SUM(CASE WHEN category = 'issue' THEN 1 ELSE 0 END) as issues
           FROM memories WHERE created_at <= ? AND is_forgotten = 0 AND user_id = ?`
        ).get(asOfStr, auth.user_id) as any;

        return json({
          as_of: as_of,
          query: query || null,
          memories: timeMemories.map(m => ({
            id: m.id,
            content: m.content,
            category: m.category,
            source: m.source,
            importance: m.importance,
            version: m.version,
            is_static: !!m.is_static,
            tags: m.tags ? JSON.parse(m.tags) : [],
            created_at: m.created_at,
            similarity: m.similarity || undefined,
          })),
          stats: statsAtTime,
          total_returned: timeMemories.length,
        });
      } catch (e: any) {
        return safeError("Time-travel", e);
      }
    }

    // ========================================================================
    // SMART CONTEXT BUILDER — optimal RAG context within token budget
    // ========================================================================

    if (url.pathname === "/context" && method === "POST") {
      try {
        const body = await req.json() as any;

        // Context mode presets: opinionated defaults on top of raw controls
        // mode=fast: depth 1, small budget, static facts + current state only
        // mode=balanced (default): depth 2, standard budget
        // mode=deep: depth 3, large budget, all layers including inference
        // mode=decision: depth 3, includes linked memories + version chains
        const contextMode = body.mode as string | undefined;
        if (contextMode) {
          if (contextMode === "fast") {
            body.depth = body.depth ?? 1;
            body.max_tokens = body.max_tokens ?? 2000;
          } else if (contextMode === "balanced") {
            body.depth = body.depth ?? 2;
            body.max_tokens = body.max_tokens ?? 6000;
          } else if (contextMode === "deep") {
            body.depth = body.depth ?? 3;
            body.max_tokens = body.max_tokens ?? 16000;
            body.include_inference = body.include_inference ?? true;
          } else if (contextMode === "decision") {
            body.depth = body.depth ?? 3;
            body.max_tokens = body.max_tokens ?? 10000;
            body.include_linked = true;
            body.include_structured_facts = true;
          }
        }

        const { query, max_tokens, token_budget: tokenBudgetAlt, budget, include_static, include_recent, strategy,
          // Benchmark/tuning overrides
          max_memory_tokens: overrideMaxMemTokens,
          dedup_threshold: overrideDedupThreshold,
          min_relevance: overrideMinRelevance,
          semantic_ceiling: overrideSemanticCeiling,
          semantic_limit: overrideSemanticLimit,
          // Layer toggles (all default to true for backward compat)
          include_episodes,
          include_linked,
          include_inference,
          include_current_state,
          include_preferences,
          include_structured_facts,
          include_working_memory,
          // Progressive disclosure: depth controls how many layers to load
          depth: disclosureDepth,
        } = body;

        if (!query || typeof query !== "string") return errorResponse("query (string) required");

        // Accept token_budget, budget, OR max_tokens (MCP sends token_budget)
        const rawBudget = Number(max_tokens) || Number(tokenBudgetAlt) || Number(budget) || 8000;
        const tokenBudget = Math.min(rawBudget, 64000);
        const contextStrategy = strategy || "balanced"; // balanced | precision | breadth

        // Progressive disclosure: depth 1 = core only, 2 = + semantic, 3 = full (default)
        // depth=1: static facts + current_state only (fast, minimal tokens)
        // depth=2: + semantic search results + preferences (standard)
        // depth=3: + episodes + linked + inferences + working memory + structured facts (full)
        const depth = Math.max(1, Math.min(3, Number(disclosureDepth) || 3));

        const includeStatic = include_static !== false && depth >= 1;
        const includeRecent = include_recent !== false && depth >= 2;
        const doIncludeEpisodes = include_episodes !== false && depth >= 3;
        const doIncludeLinked = include_linked !== false && depth >= 3;
        const doIncludeInference = include_inference === true && depth >= 3;
        const doIncludeCurrentState = include_current_state !== false && depth >= 1;
        const doIncludePreferences = include_preferences !== false && depth >= 2;
        const doIncludeStructuredFacts = include_structured_facts !== false && depth >= 2;
        const doIncludeWorkingMemory = include_working_memory !== false && depth >= 3;
        const workingMemorySession = typeof body.session === "string" && body.session.trim() ? body.session.trim() : null;

        const estimateTokens = (text: string) => Math.ceil(text.length / 4);
        const MAX_MEMORY_TOKENS = overrideMaxMemTokens != null ? Number(overrideMaxMemTokens) : 1500;

        const truncateContent = (content: string): string => {
          if (estimateTokens(content) <= MAX_MEMORY_TOKENS) return content;
          const maxChars = MAX_MEMORY_TOKENS * 4;
          const cutPoint = content.lastIndexOf(". ", maxChars);
          if (cutPoint > maxChars * 0.6) return content.substring(0, cutPoint + 1) + " [truncated]";
          return content.substring(0, maxChars) + "... [truncated]";
        };

        interface ContextBlock {
          id: number;
          content: string;
          category: string;
          score: number;
          source: string;
          tokens: number;
          created_at?: string;
          model?: string | null;
          origin?: string | null;
        }

        const blocks: ContextBlock[] = [];
        let usedTokens = 0;
        const seenIds = new Set<number>();
        const t0 = Date.now();
        const timing: Record<string, number> = {};

        // Unified dedup: single MMR-style diversity check replaces 3x O(N) scans
        const dedupThreshGlobal = overrideDedupThreshold != null ? Number(overrideDedupThreshold) : 0.88;
        const isDuplicateOfExisting = (memId: number): boolean => {
          const cached = embMap.get(memId);
          if (!cached || blockEmbeddings.length === 0) return false;
          for (const existing of blockEmbeddings) {
            if (cosineSimilarity(cached.embedding, existing) > dedupThreshGlobal) return true;
          }
          return false;
        };

        // Embed query for ranking statics + dedup
        let queryEmb: Float32Array | null = null;
        try { queryEmb = await embed(query); } catch {}
        timing.embed_ms = Date.now() - t0;

        // Build embedding lookup for dedup + static ranking
        const allCached = getCachedEmbeddings(true, auth.user_id);
        const embMap = new Map<number, { embedding: Float32Array }>();
        for (const c of allCached) {
          if ((c as any).user_id === auth.user_id) embMap.set(c.id, c);
        }
        const blockEmbeddings: Float32Array[] = [];

        // ---- Phase 1: Static facts, RANKED by query relevance ----
        if (includeStatic) {
          const statics = getStaticMemories.all(auth.user_id) as any[];
          const scored: Array<{ mem: any; relevance: number }> = [];
          for (const s of statics) {
            let relevance = 0.5;
            if (queryEmb) {
              const cached = embMap.get(s.id);
              if (cached) relevance = cosineSimilarity(queryEmb, cached.embedding);
            }
            relevance += Math.min((s.source_count || 1) / 20, 0.1);
            scored.push({ mem: s, relevance });
          }
          scored.sort((a, b) => b.relevance - a.relevance);

          const staticBudget = contextStrategy === "precision" ? 0.2 : 0.3;
          for (const { mem, relevance } of scored) {
            const truncated = truncateContent(mem.content);
            const tokens = estimateTokens(truncated);
            if (usedTokens + tokens > tokenBudget * staticBudget) break;
            blocks.push({
              id: mem.id, content: truncated, category: mem.category,
              score: relevance * 100, source: "static", tokens,
              model: mem.model || null, origin: mem.source || null,
            });
            seenIds.add(mem.id);
            usedTokens += tokens;
            const cached = embMap.get(mem.id);
            if (cached) blockEmbeddings.push(cached.embedding);
          }
        }

        timing.static_ms = Date.now() - t0 - (timing.embed_ms || 0);

        // ---- Phase 2: Semantic search (core relevance) ----
        const semanticCeiling = overrideSemanticCeiling != null ? Number(overrideSemanticCeiling) : (contextStrategy === "precision" ? 0.82 : contextStrategy === "breadth" ? 0.90 : 0.80);
        const semanticLimit = overrideSemanticLimit != null ? Number(overrideSemanticLimit) : (contextStrategy === "precision" ? 30 : contextStrategy === "breadth" ? 80 : 50);
        // Skip relationship expansion here - Phase 3 handles graph expansion separately
        // This avoids the N+1 link queries in hybridSearch which is the biggest latency cost
        const tSearch = Date.now();
        let semanticResults = await hybridSearch(query, semanticLimit, false, false, true, auth.user_id, undefined, queryEmb);
        timing.search_ms = Date.now() - tSearch;

        // Cross-encoder rerank: reorder semantic results so best matches get budget priority
        // Use smaller batch (8) for /context since other phases provide diversity
        if (isRerankerReady() && semanticResults.length > 3) {
          const tRerank = Date.now();
          semanticResults = await crossEncoderRerank(query, semanticResults, 8);
          timing.rerank_ms = Date.now() - tRerank;
        }

        for (const r of semanticResults) {
          if (seenIds.has(r.id)) continue;
          const truncated = truncateContent(r.content);
          const tokens = estimateTokens(truncated);
          if (usedTokens + tokens > tokenBudget * semanticCeiling) break;

          // Dedup: skip if too similar to already-included memory (unified helper)
          if (isDuplicateOfExisting(r.id)) continue;

          // Minimum relevance threshold (use semantic_score for quality, not RRF combined_score)
          const minRelev = overrideMinRelevance != null ? Number(overrideMinRelevance) : 0.55;
          const rawSemanticScore = r.semantic_score || r.score || 0;
          if (rawSemanticScore < minRelev) continue;
          const rawScore = r.combined_score || rawSemanticScore;

          // Recency boost: last 48h get +10%
          let score = rawScore;
          if (r.created_at) {
            const ageMs = Date.now() - new Date(r.created_at + "Z").getTime();
            if (ageMs < 48 * 60 * 60 * 1000) score *= 1.10;
          }

          blocks.push({
            id: r.id, content: truncated, category: r.category,
            score, source: "semantic", tokens,
            model: r.model || null, origin: r.source || null,
          });
          seenIds.add(r.id);
          usedTokens += tokens;
          const cachedEmb = embMap.get(r.id);
          if (cachedEmb) blockEmbeddings.push(cachedEmb.embedding);
        }

        timing.semantic_ms = Date.now() - t0 - Object.values(timing).reduce((a, b) => a + b, 0);

        // ---- Phase 2.5a: Version chain context (preference evolution tracking) ----
        // Surface version chains for semantic results that have prior versions,
        // so the LLM can see how preferences/facts evolved over time
        const tEvolution = Date.now();
        if (depth >= 2 && usedTokens < tokenBudget * 0.72) {
          const semanticIds = blocks.filter(b => b.source === "semantic").slice(0, 8);
          for (const b of semanticIds) {
            if (usedTokens >= tokenBudget * 0.72) break;
            const mem = getMemoryWithoutEmbedding.get(b.id) as any;
            if (!mem) continue;
            const rootId = mem.root_memory_id || mem.id;
            const chain = getVersionChainForUser.all(rootId, rootId, auth.user_id) as Array<{
              id: number; content: string; category: string; version: number; is_latest: boolean; created_at: string;
            }>;
            // Only include if there's actual evolution (2+ versions)
            if (chain.length < 2) continue;
            // Build a compact evolution summary
            const evolutionLines = chain.map(c =>
              `v${c.version} (${c.created_at?.slice(0, 10) || "?"}): ${c.content}`
            );
            const evolutionText = `[Evolution of memory #${rootId}]\n` + evolutionLines.join("\n");
            const truncated = truncateContent(evolutionText);
            const tokens = estimateTokens(truncated);
            if (usedTokens + tokens > tokenBudget * 0.75) break;
            blocks.push({
              id: -rootId, content: truncated, category: "evolution",
              score: 70, source: "evolution", tokens, created_at: chain[chain.length - 1].created_at,
            });
            // Mark all chain IDs as seen to avoid re-including them
            for (const c of chain) seenIds.add(c.id);
            usedTokens += tokens;
          }
        }
        timing.evolution_ms = Date.now() - tEvolution;

        // ---- Phase 2.5b: Episode context ----
        const tEpisodes = Date.now();
        const seenEpisodeIds = new Set<number>();
        if (doIncludeEpisodes && usedTokens < tokenBudget * 0.75) {
          for (const b of blocks.filter(b => b.source === "semantic").slice(0, 5)) {
            const mem = getMemoryWithoutEmbedding.get(b.id) as any;
            const epId = mem?.episode_id;
            if (epId && !seenEpisodeIds.has(epId)) {
              seenEpisodeIds.add(epId);
              const ep = getEpisodeForUser.get(epId, auth.user_id) as any;
              if (ep?.summary) {
                const truncated = truncateContent(ep.summary);
                const tokens = estimateTokens(truncated);
                if (usedTokens + tokens <= tokenBudget * 0.8) {
                  blocks.push({ id: -epId, content: truncated, category: "episode", score: 75, source: "episode", tokens, created_at: ep.started_at });
                  usedTokens += tokens;
                }
              }
            }
          }
        }
        timing.episodes_ms = Date.now() - tEpisodes;

        // ---- Phase 3: Linked memories (graph expansion) ----
        const tLinked = Date.now();
        if (doIncludeLinked && contextStrategy !== "precision" && usedTokens < tokenBudget * 0.85) {
          const semanticIds = blocks.filter(b => b.source === "semantic").slice(0, 5).map(b => b.id);
          for (const sid of semanticIds) {
            if (usedTokens >= tokenBudget * 0.85) break;
            const linked = getLinksForUser.all(sid, auth.user_id, sid, auth.user_id) as any[];
            for (const l of linked) {
              if (seenIds.has(l.id) || l.is_forgotten) continue;
              const truncated = truncateContent(l.content);
              const tokens = estimateTokens(truncated);
              if (usedTokens + tokens > tokenBudget * 0.88) break;

              // Dedup: skip if too similar to already-included memory (unified helper)
              if (isDuplicateOfExisting(l.id)) continue;

              blocks.push({
                id: l.id, content: truncated, category: l.category,
                score: (l.similarity || 0) * 50, source: "linked", tokens,
                model: l.model || null, origin: l.source || null,
              });
              seenIds.add(l.id);
              usedTokens += tokens;
              const cachedEmb = embMap.get(l.id);
              if (cachedEmb) blockEmbeddings.push(cachedEmb.embedding);
            }
          }
        }
        timing.linked_ms = Date.now() - tLinked;

        // ---- Phase 4: Recent memories (temporal context, capped at 12% of budget) ----
        const tRecent = Date.now();
        const recentCeiling = tokenBudget * 0.93;
        if (includeRecent && usedTokens < recentCeiling) {
          const recent = getRecentDynamicMemories.all(auth.user_id, 5) as any[];
          for (const r of recent) {
            if (seenIds.has(r.id)) continue;
            const truncated = truncateContent(r.content);
            const tokens = estimateTokens(truncated);
            if (usedTokens + tokens > recentCeiling) break;

            // Dedup: skip if too similar to already-included memory (unified helper)
            if (isDuplicateOfExisting(r.id)) continue;

            blocks.push({
              id: r.id, content: truncated, category: r.category,
              score: 10, source: "recent", tokens,
              model: r.model || null, origin: r.source || null,
            });
            seenIds.add(r.id);
            usedTokens += tokens;
            const cachedEmb = embMap.get(r.id);
            if (cachedEmb) blockEmbeddings.push(cachedEmb.embedding);
          }
        }
        timing.recent_ms = Date.now() - tRecent;

        // Phase 5: Implicit connection inference (LLM post-processing)
        const tInference = Date.now();
        const semanticBlocks = blocks.filter(b => b.source === "semantic");
        if (doIncludeInference && isLLMAvailable() && semanticBlocks.length >= 2 && usedTokens < tokenBudget * 0.95) {
          try {
            const topFacts = semanticBlocks.slice(0, 6).map(b => `[${b.id}] ${b.content}`).join("\n");
            const inferenceResult = await callLLM(
              `You find implicit connections between memories that aren't directly stated. Given these memories, identify 0-3 implicit connections. For each, write a single sentence stating the connection. If none exist, return "none". Be concise. Only state connections that are genuinely useful and non-obvious.`,
              `Query: ${query}\n\nMemories:\n${topFacts}`
            );
            if (inferenceResult && !inferenceResult.toLowerCase().startsWith("none")) {
              const tokens = estimateTokens(inferenceResult);
              if (usedTokens + tokens <= tokenBudget) {
                blocks.push({ id: 0, content: inferenceResult.trim(), category: "inference", score: 60, source: "inference", tokens });
                usedTokens += tokens;
              }
            }
          } catch {}
        }
        timing.inference_ms = Date.now() - tInference;

        // Build formatted context string with intelligence layers
        const tAssembly = Date.now();
        const contextParts: string[] = [];
        const staticBlocks = blocks.filter(b => b.source === "static");
        const linkedBlocks = blocks.filter(b => b.source === "linked");
        const recentBlocks = blocks.filter(b => b.source === "recent");

        if (doIncludeWorkingMemory) {
          try {
            const scratchRows = listScratchEntriesForContext.all(auth.user_id, workingMemorySession, workingMemorySession) as ScratchEntryRow[];
            const workingMemory = buildWorkingMemoryBlock(scratchRows);
            if (workingMemory) contextParts.push(workingMemory);
          } catch {}
        }

        // Intelligence Layer: Current State (key-value pairs tracked over time)
        if (doIncludeCurrentState) {
          try {
            const stateRows = db.prepare(
              "SELECT key, value, updated_count FROM current_state WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30"
            ).all(auth.user_id) as any[];
            if (stateRows.length > 0) {
              const stateLines = stateRows.map((s: any) => `- ${s.key}: ${s.value}${s.updated_count > 1 ? ` (updated ${s.updated_count}x)` : ""}`);
              contextParts.push("## Current State\n" + stateLines.join("\n"));
            }
          } catch {}
        }

        // Intelligence Layer: User Preferences
        if (doIncludePreferences) {
          try {
            const prefRows = db.prepare(
              "SELECT domain, preference, strength FROM user_preferences WHERE user_id = ? AND strength >= 1.5 ORDER BY strength DESC LIMIT 15"
            ).all(auth.user_id) as any[];
            if (prefRows.length > 0) {
              const prefLines = prefRows.map((p: any) => `- [${p.domain}] ${p.preference}`);
              contextParts.push("## User Preferences\n" + prefLines.join("\n"));
            }
          } catch {}
        }

        // Intelligence Layer: Structured Facts relevant to query (freshness-weighted)
        if (doIncludeStructuredFacts) {
          try {
            const memIds = blocks.map(b => b.id);
            if (memIds.length > 0) {
              const placeholders = memIds.map(() => "?").join(",");
              const sfRows = db.prepare(
                `SELECT subject, verb, object, quantity, unit, date_ref, date_approx, valid_at, invalid_at
                 FROM structured_facts WHERE memory_id IN (${placeholders}) AND invalid_at IS NULL
                 ORDER BY valid_at DESC NULLS LAST, date_approx DESC NULLS LAST`
              ).all(...memIds) as any[];
              if (sfRows.length > 0) {
                // Freshness weighting: sort by valid_at recency, flag stale facts (>90 days old)
                const now = Date.now();
                const STALE_MS = 90 * 24 * 60 * 60 * 1000;
                const scored = sfRows.map((sf: any) => {
                  let freshness = 0.5; // default for facts with no date
                  if (sf.valid_at) {
                    const ageMs = now - new Date(sf.valid_at).getTime();
                    freshness = ageMs < 0 ? 1.0 : Math.max(0.1, 1.0 - (ageMs / (365 * 24 * 60 * 60 * 1000)));
                  } else if (sf.date_approx) {
                    const ageMs = now - new Date(sf.date_approx).getTime();
                    freshness = ageMs < 0 ? 1.0 : Math.max(0.1, 1.0 - (ageMs / (365 * 24 * 60 * 60 * 1000)));
                  }
                  const isStale = sf.valid_at ? (now - new Date(sf.valid_at).getTime() > STALE_MS) : false;
                  return { sf, freshness, isStale };
                });
                scored.sort((a, b) => b.freshness - a.freshness);

                const sfLines = scored.map(({ sf, isStale }) => {
                  let line = `- ${sf.subject} ${sf.verb}`;
                  if (sf.object) line += ` ${sf.object}`;
                  if (sf.quantity != null) line += ` (qty: ${sf.quantity}${sf.unit ? " " + sf.unit : ""})`;
                  if (sf.valid_at) line += ` [${sf.valid_at}]`;
                  else if (sf.date_approx) line += ` [${sf.date_approx}]`;
                  else if (sf.date_ref) line += ` [${sf.date_ref}]`;
                  if (isStale) line += ` [possibly outdated]`;
                  return line;
                });
                contextParts.push("## Extracted Facts\n" + sfLines.join("\n"));
              }
            }
          } catch {}
        }

        // Attribution helper: produces "(by model via source)" tag for memory provenance
        const attrib = (b: ContextBlock): string => {
          const parts: string[] = [];
          if (b.model) parts.push(b.model);
          if (b.origin && b.origin !== "unknown") parts.push(`via ${b.origin}`);
          return parts.length > 0 ? ` (by ${parts.join(" ")})` : "";
        };

        if (staticBlocks.length > 0) {
          contextParts.push("## Permanent Facts\n" + staticBlocks.map(b => `- ${b.content}${attrib(b)}`).join("\n"));
        }
        if (semanticBlocks.length > 0) {
          contextParts.push("## Relevant Memories\n" + semanticBlocks.map(b => `- [${b.category}] ${b.content}${attrib(b)}`).join("\n"));
        }
        const evolutionBlocks = blocks.filter(b => b.source === "evolution");
        if (evolutionBlocks.length > 0) {
          contextParts.push("## Preference/Fact Evolution\n" + evolutionBlocks.map(b => b.content).join("\n\n"));
        }
        const episodeBlocks = blocks.filter(b => b.source === "episode");
        if (episodeBlocks.length > 0) {
          contextParts.push("## Episode Context\n" + episodeBlocks.map(b => `- [${b.created_at || ""}] ${b.content}${attrib(b)}`).join("\n"));
        }
        if (linkedBlocks.length > 0) {
          contextParts.push("## Related Context\n" + linkedBlocks.map(b => `- ${b.content}${attrib(b)}`).join("\n"));
        }
        if (recentBlocks.length > 0) {
          contextParts.push("## Recent Activity\n" + recentBlocks.map(b => `- [${b.created_at || ""}] ${b.content}${attrib(b)}`).join("\n"));
        }
        const inferenceBlocks = blocks.filter(b => b.source === "inference");
        if (inferenceBlocks.length > 0) {
          contextParts.push("## Implicit Connections\n" + inferenceBlocks.map(b => b.content).join("\n"));
        }

        timing.assembly_ms = Date.now() - tAssembly;
        timing.total_ms = Date.now() - t0;

        // Defer access tracking to after response
        const blockIds = blocks.filter(b => b.id > 0).map(b => b.id);
        setTimeout(() => { try { const batch = db.transaction(() => { for (const id of blockIds) trackAccessWithFSRS(id); }); batch(); } catch {} }, 0);

        return json({
          context: contextParts.join("\n\n"),
          blocks: blocks.map(b => ({ id: b.id, category: b.category, source: b.source, model: b.model || null, origin: b.origin || null, score: Math.round(b.score * 100) / 100, tokens: b.tokens })),
          token_estimate: usedTokens,
          token_budget: tokenBudget,
          utilization: Math.round(usedTokens / tokenBudget * 100) / 100,
          strategy: contextStrategy,
          breakdown: {
            static: staticBlocks.length,
            semantic: semanticBlocks.length,
            evolution: evolutionBlocks.length,
            episode: episodeBlocks.length,
            linked: linkedBlocks.length,
            recent: recentBlocks.length,
            inference: inferenceBlocks.length,
          },
          timing,
        });
      } catch (e: any) {
        return safeError("Context build", e);
      }
    }

    // ========================================================================
    // MEMORY REFLECTIONS — periodic meta-analysis
    // ========================================================================

    if (url.pathname === "/reflect" && method === "POST") {
      if (!isLLMAvailable()) return errorResponse("LLM not configured — /reflect requires inference", 400);
      try {
        const body = await req.json() as any;
        const period = body.period || "week"; // day | week | month
        const force = body.force === true;

        const now = new Date();
        let periodStart: Date;
        if (period === "day") periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        else if (period === "month") periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        else periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const periodStartStr = periodStart.toISOString().replace("T", " ").replace("Z", "");
        const periodEndStr = now.toISOString().replace("T", " ").replace("Z", "");

        // Check if we already reflected on this period
        if (!force) {
          const existing = db.prepare(
            `SELECT id, content, themes, created_at FROM reflections
             WHERE user_id = ? AND period_start >= ? ORDER BY created_at DESC LIMIT 1`
          ).get(auth.user_id, periodStartStr) as any;
          if (existing) {
            return json({
              reflection: existing.content,
              themes: existing.themes ? JSON.parse(existing.themes) : [],
              period: { start: periodStartStr, end: periodEndStr },
              cached: true,
              id: existing.id,
            });
          }
        }

        // Gather memories from the period
        const periodMemories = db.prepare(
          `SELECT id, content, category, importance, tags, created_at, is_static, confidence
           FROM memories WHERE created_at >= ? AND created_at <= ? AND is_forgotten = 0 AND user_id = ?
           ORDER BY importance DESC, created_at DESC LIMIT 100`
        ).all(periodStartStr, periodEndStr, auth.user_id) as any[];

        if (periodMemories.length < 3) {
          return json({
            reflection: null,
            message: `Only ${periodMemories.length} memories in the ${period} period — need at least 3 for reflection`,
            period: { start: periodStartStr, end: periodEndStr },
          });
        }

        // Get category distribution
        const categories: Record<string, number> = {};
        for (const m of periodMemories) {
          categories[m.category] = (categories[m.category] || 0) + 1;
        }

        const memoryList = periodMemories.map(m =>
          `[#${m.id} ${m.category} imp=${m.importance}] ${m.content.substring(0, 200)}`
        ).join("\n");

        const reflectPrompt = `You are a reflective intelligence analyzing a collection of memories from a ${period} period. Generate a meta-analysis that identifies:

1. **Key Themes**: The 3-5 dominant themes or areas of focus
2. **Progress Summary**: What was accomplished and what moved forward
3. **Patterns**: Recurring patterns, habits, or tendencies
4. **Unresolved Items**: Things mentioned but not completed or resolved
5. **Insights**: Non-obvious connections or observations

Category distribution: ${JSON.stringify(categories)}
Memory count: ${periodMemories.length}
Period: ${periodStartStr} to ${periodEndStr}

Return JSON:
{
  "reflection": "2-3 paragraph natural language reflection",
  "themes": ["theme1", "theme2", "theme3"],
  "progress": ["completed item 1", "completed item 2"],
  "patterns": ["pattern 1", "pattern 2"],
  "unresolved": ["unresolved item 1"],
  "insight": "one key non-obvious insight"
}`;

        const resp = await callLLM(reflectPrompt, memoryList);
        const cleaned = resp.replace(/```json\n?|\n?```/g, "").trim();
        let result: any;
        try {
          result = JSON.parse(cleaned);
        } catch {
          const jsonMatch = cleaned.match(/\{[\s\S]*"reflection"[\s\S]*\}/);
          if (jsonMatch) result = JSON.parse(jsonMatch[0]);
          else return errorResponse("LLM returned unparseable reflection", 500);
        }

        // Store the reflection
        const reflectionId = db.prepare(
          `INSERT INTO reflections (user_id, content, themes, period_start, period_end, memory_count, source_memory_ids)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
        ).get(
          auth.user_id,
          result.reflection,
          JSON.stringify(result.themes || []),
          periodStartStr,
          periodEndStr,
          periodMemories.length,
          JSON.stringify(periodMemories.map((m: any) => m.id))
        ) as { id: number };

        // Also store the reflection as a memory for future recall
        let embBuffer: Buffer | null = null;
        let embArray: Float32Array | null = null;
        try { embArray = await embed(result.reflection); embBuffer = embeddingToBuffer(embArray); } catch {}

        const reflectionMem = insertMemory.get(
          `[Reflection: ${period}ly, ${periodStartStr.substring(0, 10)} to ${periodEndStr.substring(0, 10)}] ${result.reflection}`,
          "discovery", "reflection", null, 7, embBuffer,
          1, 1, null, null, periodMemories.length, 1, 0, null, null, 1, null, auth.user_id, auth.space_id || null
        ) as { id: number; created_at: string };
        db.prepare("UPDATE memories SET tags = ? WHERE id = ?").run(
          JSON.stringify(["reflection", period, ...(result.themes || []).slice(0, 3)]),
          reflectionMem.id
        );
        if (embArray) await autoLink(reflectionMem.id, embArray, auth.user_id);

        emitWebhookEvent("reflection.created", {
          id: reflectionId.id,
          period,
          themes: result.themes,
          memory_count: periodMemories.length,
        }, auth.user_id);

        return json({
          id: reflectionId.id,
          memory_id: reflectionMem.id,
          reflection: result.reflection,
          themes: result.themes || [],
          progress: result.progress || [],
          patterns: result.patterns || [],
          unresolved: result.unresolved || [],
          insight: result.insight || null,
          period: { start: periodStartStr, end: periodEndStr },
          memories_analyzed: periodMemories.length,
          cached: false,
        });
      } catch (e: any) {
        return safeError("Reflection", e);
      }
    }

    if (url.pathname === "/reflections" && method === "GET") {
      const limitParam = Math.min(Number(url.searchParams.get("limit") || 10), 50);
      const reflections = db.prepare(
        `SELECT id, content, themes, period_start, period_end, memory_count, created_at
         FROM reflections WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
      ).all(auth.user_id, limitParam) as any[];

      return json({
        reflections: reflections.map(r => ({
          ...r,
          themes: r.themes ? JSON.parse(r.themes) : [],
        })),
        total: reflections.length,
      });
    }

    // ========================================================================
    // SCHEDULED DIGESTS — webhook delivery of memory summaries
    // ========================================================================

    if (url.pathname === "/digests" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const { webhook_url, webhook_secret, schedule, include_stats, include_new_memories, include_contradictions, include_reflections } = body;

        if (!webhook_url || typeof webhook_url !== "string") return errorResponse("webhook_url is required");
        const webhookError = validatePublicWebhookUrl(webhook_url, "Webhook URL");
        if (webhookError) return errorResponse(webhookError);

        const sched = ["hourly", "daily", "weekly"].includes(schedule) ? schedule : "daily";

        // Calculate next send time
        const now = new Date();
        let nextSend: Date;
        if (sched === "hourly") nextSend = new Date(now.getTime() + 60 * 60 * 1000);
        else if (sched === "weekly") nextSend = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        else nextSend = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const nextSendStr = nextSend.toISOString().replace("T", " ").replace("Z", "");

        const result = db.prepare(
          `INSERT INTO digests (user_id, schedule, webhook_url, webhook_secret, include_stats, include_new_memories, include_contradictions, include_reflections, next_send_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`
        ).get(
          auth.user_id, sched, webhook_url, webhook_secret || null,
          include_stats !== false ? 1 : 0,
          include_new_memories !== false ? 1 : 0,
          include_contradictions !== false ? 1 : 0,
          include_reflections !== false ? 1 : 0,
          nextSendStr
        ) as { id: number; created_at: string };

        return json({
          id: result.id,
          schedule: sched,
          webhook_url,
          next_send_at: nextSendStr,
          created_at: result.created_at,
        });
      } catch (e: any) {
        return safeError("Digest creation", e);
      }
    }

    if (url.pathname === "/digests" && method === "GET") {
      const digests = db.prepare(
        `SELECT id, schedule, webhook_url, include_stats, include_new_memories,
           include_contradictions, include_reflections, last_sent_at, next_send_at, active, created_at
         FROM digests WHERE user_id = ? ORDER BY created_at DESC`
      ).all(auth.user_id) as any[];
      return json({ digests });
    }

    if (url.pathname.match(/^\/digests\/\d+$/) && method === "DELETE") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const digestId = Number(url.pathname.split("/")[2]);
      db.prepare("DELETE FROM digests WHERE id = ? AND user_id = ?").run(digestId, auth.user_id);
      return json({ deleted: true, id: digestId });
    }

    if (url.pathname === "/digests/send" && method === "POST") {
      // Manually trigger a digest send (for testing)
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const digestId = body.digest_id;
        if (!digestId) return errorResponse("digest_id required");

        const digest = db.prepare("SELECT * FROM digests WHERE id = ? AND user_id = ?").get(digestId, auth.user_id) as any;
        if (!digest) return errorResponse("Digest not found", 404);

        const payload = await buildDigestPayload(digest, auth.user_id);
        const sent = await sendDigestWebhook(digest, payload);

        return json({ sent, digest_id: digestId, payload });
      } catch (e: any) {
        return safeError("Digest send", e);
      }
    }

    // ========================================================================
    // STORE — v3 with async fact extraction
    // ========================================================================

    if ((url.pathname === "/store" || url.pathname === "/memory" || url.pathname === "/memories") && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const { content, category, source, session_id, importance, tags, episode, model } = body;
        if (!content || typeof content !== "string" || content.trim().length === 0) {
          return errorResponse("content is required and must be a non-empty string");
        }
        if (content.length > MAX_CONTENT_SIZE) {
          return errorResponse(`Content too large (${content.length} bytes). Max: ${MAX_CONTENT_SIZE}`, 413);
        }

        const imp = Math.max(1, Math.min(10, Number(importance) || DEFAULT_IMPORTANCE));

        // Validate and serialize tags
        let tagsJson: string | null = null;
        if (tags) {
          if (Array.isArray(tags)) {
            tagsJson = JSON.stringify(tags.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean));
          } else if (typeof tags === "string") {
            tagsJson = JSON.stringify(tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean));
          }
        }

        // Episode management: auto-create or find existing episode
        let episodeId: number | null = null;
        if (episode !== false && session_id && source) {
          const existing = getEpisodeBySession.get(session_id, source, auth.user_id) as any;
          if (existing) {
            episodeId = existing.id;
          } else if (episode !== "none") {
            // Auto-create episode for this session
            const ep = insertEpisode.get(
              null, session_id, source, auth.user_id
            ) as { id: number; started_at: string };
            episodeId = ep.id;
          }
        }

        // SimHash near-duplicate check (before embedding to save compute)
        const simhashResult = checkSimHashDuplicate(content.trim(), auth.user_id);
        if (simhashResult.isDuplicate && simhashResult.existingId) {
          boostDuplicate(simhashResult.existingId);
          log.info({ msg: "simhash_duplicate_detected", existing_id: simhashResult.existingId, distance: simhashResult.distance });
          return json({
            stored: false,
            duplicate: true,
            existing_id: simhashResult.existingId,
            distance: simhashResult.distance,
            boosted: true,
          });
        }

        let embBuffer: Buffer | null = null;
        let embArray: Float32Array | null = null;
        try {
          embArray = await embed(content.trim());
          embBuffer = embeddingToBuffer(embArray);
        } catch (e: any) {
          log.warn({ msg: "embedding_failed_storing_without", error: e.message });
        }

        // B1+B2 FIX: Respect is_static, forget_after, is_inference from request body
        const isStatic = body.is_static ? 1 : 0;
        const forgetAfter = body.forget_after || null;
        const forgetReason = body.forget_reason || null;
        const isInference = body.is_inference ? 1 : 0;

        const result = insertMemory.get(
          content.trim(),
          (category || "general").trim(),
          (source || "unknown").trim(),
          session_id || null,
          imp,
          embBuffer,
          1, 1, null, null, 1, isStatic, 0, forgetAfter, forgetReason, isInference,
          (model && typeof model === "string") ? model.trim() : null, auth.user_id, auth.space_id || null
        ) as { id: number; created_at: string };

        // Set tags, episode_id, sync_id, confidence, status
        const syncId = randomUUID();
        const memStatus = body.status === "pending" ? "pending" : "approved";
        db.prepare(
          "UPDATE memories SET tags = ?, episode_id = ?, sync_id = ?, confidence = 1.0, status = ? WHERE id = ?"
        ).run(tagsJson, episodeId, syncId, memStatus, result.id);

        // Link to entities and projects if provided
        const entityIds = body.entity_ids as number[] | undefined;
        const projectIds = body.project_ids as number[] | undefined;
        const ownedEntityIds = getOwnedEntityIds(entityIds, auth);
        for (const eid of ownedEntityIds) linkMemoryEntity.run(result.id, eid);
        for (const pid of getOwnedProjectIds(projectIds, auth)) linkMemoryProject.run(result.id, pid);

        // Update entity cooccurrence graph if entities were linked
        if (ownedEntityIds.length >= 2) {
          updateCooccurrences(result.id, auth.user_id);
        }

        // Update episode memory count
        if (episodeId) {
          updateEpisodeForUser.run(null, null, null, episodeId, auth.user_id);
        }

        // Calculate initial decay score + FSRS state
        const initFSRS = fsrsProcessReview(null, FSRSRating.Good, 0);
        const decayScore = fsrsCalculateDecayScore(imp, result.created_at, 0, null, !!isStatic, 1, initFSRS.stability);
        db.prepare("UPDATE memories SET decay_score = ?, fsrs_stability = ?, fsrs_difficulty = ?, fsrs_storage_strength = ?, fsrs_retrieval_strength = ?, fsrs_learning_state = ?, fsrs_reps = ?, fsrs_lapses = ?, fsrs_last_review_at = ? WHERE id = ?").run(
          Math.round(decayScore * 1000) / 1000,
          initFSRS.stability, initFSRS.difficulty, initFSRS.storage_strength,
          initFSRS.retrieval_strength, initFSRS.learning_state, initFSRS.reps, initFSRS.lapses,
          initFSRS.last_review_at, result.id
        );

        // Store SimHash fingerprint for future dedup checks
        storeSimHash(result.id, simhashResult.simhash);

        // Emit webhook event (sync, fast)
        emitWebhookEvent("memory.created", {
          id: result.id, content: content.trim(), category: category || "general",
          importance: imp, tags: tagsJson ? JSON.parse(tagsJson) : [], episode_id: episodeId,
        }, auth.user_id);

        // Synchronous fast extraction (regex-based, no LLM, instant)
        fastExtractFacts(content.trim(), result.id, auth.user_id, episodeId);

        // Return response IMMEDIATELY — vector indexing + autoLink + fact extraction happen async
        const response = json({
          stored: true,
          id: result.id,
          created_at: result.created_at,
          importance: imp,
          linked: 0, // will be computed async
          embedded: !!embBuffer,
          tags: tagsJson ? JSON.parse(tagsJson) : [],
          episode_id: episodeId,
          decay_score: decayScore,
          fact_extraction: isLLMAvailable() ? "queued" : "disabled",
          status: memStatus,
          model: (model && typeof model === "string") ? model.trim() : null,
        });

        audit(auth.user_id, "memory.store", "memory", result.id, (category || "general"), clientIp, requestId);

        // === DURABLE POST-STORE PIPELINE ===
        // Enqueue to job table for reliable processing with retries.
        // Worker loop in server-split.ts processes these every 2 seconds.
        if (embArray) {
          const embBase64 = Buffer.from(embArray.buffer, embArray.byteOffset, embArray.byteLength).toString("base64");
          enqueueJob("post_store", {
            memoryId: result.id,
            content: content.trim(),
            category: category || "general",
            userId: auth.user_id,
            importance: imp,
            embeddingBase64: embBase64,
          });
        }

        return response;
      } catch (e: any) {
        return safeError("store", e);
      }
    }

    // ========================================================================
    // CORRECT — Explicit correction of an existing memory
    // Stores correction as static, high-importance, supersedes the old memory.
    // If no memory_id, searches for the best-matching memory to correct.
    // ========================================================================

    if (url.pathname === "/correct" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const correction = body.correction?.trim();
        if (!correction) return errorResponse("correction (string) is required — the correct information");

        const originalClaim = body.original_claim?.trim() || null; // what was wrong
        let memoryId = body.memory_id ? Number(body.memory_id) : null;
        const category = body.category || "state";

        // If no memory_id provided, try to find the most relevant memory to correct
        let correctedMemory: any = null;
        if (memoryId) {
          correctedMemory = getMemoryWithoutEmbedding.get(memoryId) as any;
          if (!correctedMemory) return errorResponse(`Memory #${memoryId} not found`, 404);
          if (correctedMemory.user_id !== auth.user_id) return errorResponse("Not your memory", 403);
        } else if (originalClaim) {
          // Search by the original (wrong) claim to find what to correct
          const candidates = await hybridSearch(originalClaim, 5, false, true, false, auth.user_id);
          if (candidates.length > 0) {
            // Take the best match that's not forgotten
            for (const c of candidates) {
              const full = getMemoryWithoutEmbedding.get(c.id) as any;
              if (full && !full.is_forgotten && full.user_id === auth.user_id) {
                correctedMemory = full;
                memoryId = full.id;
                break;
              }
            }
          }
        }

        // Embed the correction
        let embBuffer: Buffer | null = null;
        let embArray: Float32Array | null = null;
        try {
          embArray = await embed(correction);
          embBuffer = embeddingToBuffer(embArray);
        } catch (e: any) {
          log.warn({ msg: "correction_embed_failed", error: e.message });
        }

        // If still no memory found via search, try semantic search on the correction itself
        if (!correctedMemory && embArray) {
          const allMems = getCachedEmbeddings(true, auth.user_id);
          let bestSim = 0;
          let bestMem: any = null;
          for (const mem of allMems) {
            const sim = cosineSimilarity(embArray, mem.embedding);
            if (sim > 0.5 && sim > bestSim) {
              bestSim = sim;
              bestMem = mem;
            }
          }
          if (bestMem) {
            correctedMemory = getMemoryWithoutEmbedding.get(bestMem.id) as any;
            if (correctedMemory?.user_id === auth.user_id) {
              memoryId = bestMem.id;
            } else {
              correctedMemory = null;
            }
          }
        }

        // Build the stored content — include what was wrong for context
        let storedContent = correction;
        if (originalClaim && correctedMemory) {
          storedContent = `[CORRECTION] Was: "${originalClaim.substring(0, 200)}". Correct: ${correction}`;
        } else if (correctedMemory) {
          storedContent = `[CORRECTION of #${memoryId}] ${correction}`;
        }

        // Store as static, importance 9
        const imp = Math.max(body.importance || 9, 8); // floor at 8 for corrections
        const result = insertMemory.get(
          storedContent, category, (body.source || "correction").trim(),
          null, imp, embBuffer,
          1, 1, null, null, 1, 1, 0, // is_static=1
          null, null, 0, null, auth.user_id, auth.space_id || null
        ) as { id: number; created_at: string };

        // Set tags, status
        const correctionTags = JSON.stringify(["correction", ...(body.tags || [])]);
        db.prepare(
          "UPDATE memories SET tags = ?, status = 'approved' WHERE id = ?"
        ).run(correctionTags, result.id);

        // FSRS init
        const initFSRS = fsrsProcessReview(null, FSRSRating.Good, 0);
        const decayScore = fsrsCalculateDecayScore(imp, result.created_at, 0, null, true, 1, initFSRS.stability);
        db.prepare("UPDATE memories SET decay_score = ?, fsrs_stability = ?, fsrs_difficulty = ?, fsrs_storage_strength = ?, fsrs_retrieval_strength = ?, fsrs_learning_state = ?, fsrs_reps = ?, fsrs_lapses = ?, fsrs_last_review_at = ? WHERE id = ?").run(
          Math.round(decayScore * 1000) / 1000,
          initFSRS.stability, initFSRS.difficulty, initFSRS.storage_strength,
          initFSRS.retrieval_strength, initFSRS.learning_state, initFSRS.reps, initFSRS.lapses,
          initFSRS.last_review_at, result.id
        );

        // If we found the old memory, supersede it and link
        let corrected_memory_id: number | null = null;
        let corrected_content: string | null = null;
        if (correctedMemory && memoryId) {
          markSuperseded.run(memoryId);
          const rootId = correctedMemory.root_memory_id || correctedMemory.id;
          const newVersion = (correctedMemory.version || 1) + 1;
          db.prepare(
            `UPDATE memories SET version = ?, root_memory_id = ?, parent_memory_id = ? WHERE id = ?`
          ).run(newVersion, rootId, memoryId, result.id);
          insertLink.run(result.id, memoryId, 1.0, "corrects");
          corrected_memory_id = memoryId;
          corrected_content = correctedMemory.content?.substring(0, 200);
          log.info({ msg: "memory_corrected", correction_id: result.id, old_id: memoryId, old_content: correctedMemory.content?.substring(0, 100) });
        }

        // Vector index + cache update (durable job queue)
        if (embArray) {
          const embBase64 = Buffer.from(embArray.buffer, embArray.byteOffset, embArray.byteLength).toString("base64");
          enqueueJob("post_store", {
            memoryId: result.id,
            content: storedContent,
            category,
            userId: auth.user_id,
            importance: imp,
            embeddingBase64: embBase64,
          });
        }

        // Invalidate context cache so the correction is immediately available
        invalidateEmbeddingCache();

        audit(auth.user_id, "memory.correct", "memory", result.id, category, clientIp, requestId);
        emitWebhookEvent("memory.corrected", {
          id: result.id, correction, corrected_memory_id, corrected_content,
        }, auth.user_id);

        return json({
          corrected: true,
          id: result.id,
          corrected_memory_id,
          corrected_content,
          importance: imp,
          is_static: true,
          embedded: !!embBuffer,
          created_at: result.created_at,
        });
      } catch (e: any) {
        return safeError("correct", e);
      }
    }

    // ========================================================================
    // MEMORY HEALTH — surface stale, duplicate, and disconnected memories
    // ========================================================================

    if (url.pathname === "/memory-health" && method === "GET") {
      try {
        const staleDays = Number(url.searchParams.get("stale_days") || 60);
        const dupThreshold = Number(url.searchParams.get("dup_threshold") || 0.94);
        const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);

        // 1. Stale high-importance memories: important but not accessed recently
        const staleRows = db.prepare(
          `SELECT id, content, category, importance, created_at, source_count,
                  access_count, decay_score
           FROM memories
           WHERE user_id = ? AND is_forgotten = 0 AND is_static = 0 AND is_archived = 0
             AND importance >= 6
             AND created_at < datetime('now', '-' || ? || ' days')
             AND (access_count IS NULL OR access_count < 2)
           ORDER BY importance DESC, created_at ASC
           LIMIT ?`
        ).all(auth.user_id, staleDays, limit) as any[];

        // 2. Duplicate clusters: high-similarity unlinked memory pairs
        const allEmbs = getCachedEmbeddings(true, auth.user_id);
        const dupClusters: Array<{ ids: number[]; similarity: number; sample_content: string }> = [];
        const seen = new Set<string>();
        const userEmbs = allEmbs.filter((e: any) => e.user_id === auth.user_id);
        for (let i = 0; i < Math.min(userEmbs.length, 300); i++) {
          for (let j = i + 1; j < Math.min(userEmbs.length, 300); j++) {
            const sim = cosineSimilarity(userEmbs[i].embedding, userEmbs[j].embedding);
            if (sim >= dupThreshold) {
              const key = `${Math.min(userEmbs[i].id, userEmbs[j].id)}-${Math.max(userEmbs[i].id, userEmbs[j].id)}`;
              if (!seen.has(key)) {
                seen.add(key);
                const memA = getMemoryWithoutEmbedding.get(userEmbs[i].id) as any;
                dupClusters.push({
                  ids: [userEmbs[i].id, userEmbs[j].id],
                  similarity: Math.round(sim * 1000) / 1000,
                  sample_content: memA?.content?.substring(0, 120) || "",
                });
              }
            }
          }
        }
        dupClusters.sort((a, b) => b.similarity - a.similarity);

        // 3. High-value unlinked memories: important memories with no graph links
        const unlinkedRows = db.prepare(
          `SELECT m.id, m.content, m.category, m.importance, m.created_at
           FROM memories m
           WHERE m.user_id = ? AND m.is_forgotten = 0 AND m.importance >= 7
             AND NOT EXISTS (
               SELECT 1 FROM memory_links ml
               WHERE ml.source_id = m.id OR ml.target_id = m.id
             )
           ORDER BY m.importance DESC
           LIMIT ?`
        ).all(auth.user_id, limit) as any[];

        // 4. Contradiction hints: memories with contradicting keywords near same subjects
        const contradictionRows = db.prepare(
          `SELECT m.id, m.content, m.category, m.created_at
           FROM memories m
           WHERE m.user_id = ? AND m.is_forgotten = 0
             AND (m.content LIKE '%no longer%' OR m.content LIKE '%changed to%'
               OR m.content LIKE '%used to%' OR m.content LIKE '%instead now%'
               OR m.content LIKE '%but now%' OR m.content LIKE '%previously%')
           ORDER BY m.created_at DESC
           LIMIT ?`
        ).all(auth.user_id, limit) as any[];

        return json({
          stale: staleRows.map(r => ({
            id: r.id,
            content: r.content?.substring(0, 150),
            category: r.category,
            importance: r.importance,
            created_at: r.created_at,
            access_count: r.access_count || 0,
            decay_score: r.decay_score,
          })),
          duplicates: dupClusters.slice(0, limit),
          high_value_unlinked: unlinkedRows.map(r => ({
            id: r.id,
            content: r.content?.substring(0, 150),
            category: r.category,
            importance: r.importance,
            created_at: r.created_at,
          })),
          contradiction_hints: contradictionRows.map(r => ({
            id: r.id,
            content: r.content?.substring(0, 200),
            category: r.category,
            created_at: r.created_at,
          })),
          summary: {
            stale_count: staleRows.length,
            duplicate_pairs: dupClusters.length,
            unlinked_high_value: unlinkedRows.length,
            contradiction_hints: contradictionRows.length,
          },
        });
      } catch (e: any) {
        return safeError("Memory health", e);
      }
    }

    // ========================================================================
    // RETRIEVAL FEEDBACK — relevance signal collection
    // ========================================================================

    if (url.pathname === "/feedback" && method === "POST") {
      try {
        // Create table if not exists (idempotent)
        db.exec(`
          CREATE TABLE IF NOT EXISTS retrieval_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            query TEXT NOT NULL,
            memory_id INTEGER NOT NULL,
            signal TEXT NOT NULL CHECK(signal IN ('used', 'ignored', 'corrected', 'irrelevant', 'helpful')),
            context TEXT,
            agent TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (memory_id) REFERENCES memories(id)
          );
          CREATE INDEX IF NOT EXISTS idx_feedback_user ON retrieval_feedback(user_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_feedback_memory ON retrieval_feedback(memory_id, signal);
        `);

        const body = await req.json() as any;
        const { query: fbQuery, memory_id, signal, context: fbContext, agent: fbAgent, items } = body;

        // Support both single feedback and batch
        const feedbackItems: Array<{ query: string; memory_id: number; signal: string; context?: string; agent?: string }> = [];

        if (items && Array.isArray(items)) {
          for (const item of items) {
            if (!item.query || !item.memory_id || !item.signal) continue;
            if (!["used", "ignored", "corrected", "irrelevant", "helpful"].includes(item.signal)) continue;
            feedbackItems.push(item);
          }
        } else if (fbQuery && memory_id && signal) {
          if (!["used", "ignored", "corrected", "irrelevant", "helpful"].includes(signal)) {
            return errorResponse("Invalid signal. Must be one of: used, ignored, corrected, irrelevant, helpful", 400);
          }
          feedbackItems.push({ query: fbQuery, memory_id, signal, context: fbContext, agent: fbAgent });
        }

        if (feedbackItems.length === 0) {
          return errorResponse("Required: query, memory_id, signal (used|ignored|corrected|irrelevant|helpful). Or items[] for batch.", 400);
        }

        const insertFeedback = db.prepare(
          "INSERT INTO retrieval_feedback (user_id, query, memory_id, signal, context, agent) VALUES (?, ?, ?, ?, ?, ?)"
        );
        const batch = db.transaction(() => {
          for (const fb of feedbackItems) {
            insertFeedback.run(auth.user_id, fb.query, fb.memory_id, fb.signal, fb.context || null, fb.agent || null);
          }
        });
        batch();

        // Also update importance heuristically: "helpful" boosts, "irrelevant" penalizes
        for (const fb of feedbackItems) {
          try {
            if (fb.signal === "helpful") {
              db.prepare("UPDATE memories SET importance = MIN(importance + 0.5, 10) WHERE id = ? AND user_id = ?").run(fb.memory_id, auth.user_id);
            } else if (fb.signal === "irrelevant") {
              db.prepare("UPDATE memories SET importance = MAX(importance - 0.3, 0) WHERE id = ? AND user_id = ?").run(fb.memory_id, auth.user_id);
            }
          } catch {}
        }

        return json({ ok: true, recorded: feedbackItems.length });
      } catch (e: any) {
        return safeError("Feedback", e);
      }
    }

    // GET /feedback/stats — retrieval quality analytics
    if (url.pathname === "/feedback/stats" && method === "GET") {
      try {
        // Ensure table exists
        db.exec(`CREATE TABLE IF NOT EXISTS retrieval_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          query TEXT NOT NULL,
          memory_id INTEGER NOT NULL,
          signal TEXT NOT NULL CHECK(signal IN ('used', 'ignored', 'corrected', 'irrelevant', 'helpful')),
          context TEXT,
          agent TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);

        const days = Number(url.searchParams.get("days") || 30);
        const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

        const signalCounts = db.prepare(
          `SELECT signal, COUNT(*) as count FROM retrieval_feedback
           WHERE user_id = ? AND created_at >= ? GROUP BY signal ORDER BY count DESC`
        ).all(auth.user_id, sinceDate) as any[];

        const topIrrelevant = db.prepare(
          `SELECT memory_id, COUNT(*) as count FROM retrieval_feedback
           WHERE user_id = ? AND signal = 'irrelevant' AND created_at >= ?
           GROUP BY memory_id ORDER BY count DESC LIMIT 10`
        ).all(auth.user_id, sinceDate) as any[];

        const topHelpful = db.prepare(
          `SELECT memory_id, COUNT(*) as count FROM retrieval_feedback
           WHERE user_id = ? AND signal = 'helpful' AND created_at >= ?
           GROUP BY memory_id ORDER BY count DESC LIMIT 10`
        ).all(auth.user_id, sinceDate) as any[];

        const totalFeedback = signalCounts.reduce((sum: number, r: any) => sum + r.count, 0);
        const helpfulCount = signalCounts.find((r: any) => r.signal === "helpful")?.count || 0;
        const usedCount = signalCounts.find((r: any) => r.signal === "used")?.count || 0;
        const irrelevantCount = signalCounts.find((r: any) => r.signal === "irrelevant")?.count || 0;
        const precision = totalFeedback > 0 ? Math.round(((helpfulCount + usedCount) / totalFeedback) * 1000) / 1000 : null;

        return json({
          period_days: days,
          total_feedback: totalFeedback,
          signal_breakdown: signalCounts,
          estimated_precision: precision,
          top_irrelevant_memories: topIrrelevant,
          top_helpful_memories: topHelpful,
        });
      } catch (e: any) {
        return safeError("Feedback stats", e);
      }
    }

    // ========================================================================
    // SEARCH — v3
    // ========================================================================

    if ((url.pathname === "/search" || url.pathname === "/memories/search") && method === "POST") {
      try {
        const _searchT0 = performance.now();
        const body = await req.json() as any;

        // Search mode presets: opinionated defaults to reduce cognitive load
        // mode=fact (default): standard hybrid search for factual recall
        // mode=timeline: chronological ordering, broader results
        // mode=preference: lower vector floor, targets user preferences/values
        // mode=decision: focuses on decisions/corrections with version history
        // mode=recent: last 24h only, sorted by time
        const mode = body.mode as string | undefined;
        if (mode) {
          if (mode === "timeline") {
            body.temporal_sort = body.temporal_sort ?? "desc";
            body.limit = body.limit ?? 20;
            body.vector_floor = body.vector_floor ?? 0.15;
          } else if (mode === "preference") {
            body.vector_floor = body.vector_floor ?? 0.10;
            body.include_episodes = body.include_episodes ?? true;
          } else if (mode === "decision") {
            body.expand_relationships = body.expand_relationships ?? true;
            body.include_links = body.include_links ?? true;
          } else if (mode === "recent") {
            body.temporal_sort = body.temporal_sort ?? "desc";
            body.limit = body.limit ?? 15;
          }
        }

        const { query, limit, include_links, expand_relationships, latest_only, tag, episode_id: filterEpisode, temporal_sort, vector_floor } = body;
        if (!query || typeof query !== "string") return errorResponse("query is required");
        const _searchT1 = performance.now();
        let results = await hybridSearch(
          query,
          Math.min(limit || 10, 50),
          include_links || false,
          expand_relationships ?? true,
          latest_only ?? true,
          auth.user_id,
          vector_floor != null ? Number(vector_floor) : undefined
        );

        const _searchT2 = performance.now();
        log.info({ msg: "search_timing", phase: "hybridSearch", ms: (_searchT2 - _searchT1).toFixed(1) });

        // Filter by tag if specified
        if (tag) {
          results = results.filter(r => {
            const mem = getMemoryWithoutEmbedding.get(r.id) as any;
            if (!mem?.tags) return false;
            try { return JSON.parse(mem.tags).includes(tag); } catch { return false; }
          });
        }

        // Filter by episode if specified
        if (filterEpisode) {
          results = results.filter(r => {
            const mem = getMemoryWithoutEmbedding.get(r.id) as any;
            return mem?.episode_id === filterEpisode;
          });
        }

        // Rerank results for better precision
        // Cross-encoder: auto-on when loaded (disable per-request with rerank: false)
        // LLM reranker: opt-in fallback (rerank: true when cross-encoder unavailable)
        const explicitOff = body.rerank === false;
        if (!explicitOff && isRerankerReady() && results.length > 3) {
          results = await crossEncoderRerank(query, results) as typeof results;
          results = results.slice(0, Math.min(limit || 10, 50));
        } else if (body.rerank === true && results.length > 3) {
          results = await rerank(query, results) as typeof results;
          results = results.slice(0, Math.min(limit || 10, 50));
        }

        // Temporal sort: order by created_at instead of score (for "what happened first/before/after" queries)
        if (temporal_sort) {
          const dir = temporal_sort === "asc" ? 1 : -1;
          results.sort((a, b) => {
            const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
            const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
            return (ta - tb) * dir;
          });
        }

        // Defer access tracking to after response (non-blocking, batched in transaction)
        const resultIds = results.map(r => r.id);
        setTimeout(() => {
          try {
            const batch = db.transaction(() => {
              for (const id of resultIds) trackAccessWithFSRS(id);
            });
            batch();
          } catch {}
        }, 0);

        // Episode context: fetch episode summaries for results with episode_id
        const episodeContext: Array<{ episode_id: number; title: string; summary: string; started_at: string }> = [];
        if (body.include_episodes) {
          const seenEpisodes = new Set<number>();
          for (const r of results) {
            const mem = getMemoryWithoutEmbedding.get(r.id) as any;
            const epId = mem?.episode_id;
            if (epId && !seenEpisodes.has(epId)) {
              seenEpisodes.add(epId);
              const ep = getEpisode.get(epId) as any;
              if (ep?.summary) {
                episodeContext.push({ episode_id: ep.id, title: ep.title || "", summary: ep.summary, started_at: ep.started_at });
              }
            }
          }
        }

        const _searchT3 = performance.now();
        log.info({ msg: "search_timing", total_ms: (_searchT3 - _searchT0).toFixed(1), hybrid_ms: (_searchT2 - _searchT1).toFixed(1), post_ms: (_searchT3 - _searchT2).toFixed(1), results: results.length });

        const topScore = results.length > 0 ? results[0].score : 0;
        const topSemanticScore = results.length > 0 ? (results[0].semantic_score || topScore) : 0;
        const minScore = body.min_score ?? SEARCH_MIN_SCORE;
        const abstained = results.length === 0 || topSemanticScore < minScore;

        // Search explainability: add explain object showing why each result ranked
        const explainResults = body.explain !== false ? (abstained ? [] : results).map((r: any) => {
          const explain: Record<string, any> = {};
          if (r.semantic_score != null) explain.vector = Math.round(r.semantic_score * 1000) / 1000;
          if (r.fts_score != null) explain.fts = Math.round(r.fts_score * 1000) / 1000;
          if (r.graph_score != null) explain.graph = Math.round(r.graph_score * 1000) / 1000;
          if (r.personality_signal_score != null) explain.personality = Math.round(r.personality_signal_score * 1000) / 1000;
          if (r.ce_score != null) explain.reranker = Math.round(r.ce_score * 1000) / 1000;
          if (r.combined_score != null) explain.rrf = Math.round(r.combined_score * 1000) / 1000;
          if (r.decay_score != null) explain.decay = Math.round(r.decay_score * 100) / 100;
          if (r.temporal_boost != null) explain.temporal_boost = r.temporal_boost;
          if (r.is_static) explain.static = true;
          if (r.source_count && r.source_count > 1) explain.corroborated = r.source_count;
          if (r.question_type) explain.question_type = r.question_type;
          if (r._channels && r._channels.length > 0) explain.channels = r._channels;
          // Build human-readable reason
          const reasons: string[] = [];
          if (explain.vector && explain.vector > 0.7) reasons.push("strong semantic match");
          else if (explain.vector && explain.vector > 0.5) reasons.push("moderate semantic match");
          if (explain.fts != null) reasons.push("full-text match");
          if (explain.graph != null) reasons.push("graph hop");
          if (explain.personality != null) reasons.push("personality signal");
          if (explain.temporal_boost != null) reasons.push("temporal proximity boost");
          if (explain.reranker && explain.reranker > 0.9) reasons.push("high reranker confidence");
          if (explain.static) reasons.push("permanent fact");
          if (explain.corroborated) reasons.push(`corroborated ${explain.corroborated}x`);
          if (r.importance >= 8) reasons.push("high importance");
          explain.reasons = reasons;
          // Strip internal fields from result before returning
          const { _channels, fts_score, graph_score, temporal_boost, ...rest } = r;
          return { ...rest, explain };
        }) : (abstained ? [] : results);

        return json({
          results: explainResults,
          abstained,
          top_score: Math.round(topScore * 1000) / 1000,
          ...(episodeContext.length > 0 ? { episodes: episodeContext } : {}),
          ...(body.mode ? { mode: body.mode } : {}),
        });
      } catch (e: any) {
        return safeError("Search", e);
      }
    }

    // ========================================================================
    // LIST
    // ========================================================================

    if (url.pathname === "/list" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
      const category = url.searchParams.get("category");
      const source = url.searchParams.get("source");
      // B3 FIX: Support source filter
      if (source) {
        const results = db.prepare(
          `SELECT id, content, category, source, session_id, importance, created_at,
             version, is_latest, parent_memory_id, root_memory_id, source_count,
             is_static, is_forgotten, is_inference, forget_after, is_archived, status, model
           FROM memories WHERE source = ? AND is_forgotten = 0 AND is_archived = 0 AND status != 'pending' AND user_id = ?
           ${category ? "AND category = ?" : ""}
           ORDER BY created_at DESC LIMIT ?`
        ).all(...(category ? [source, auth.user_id, category, limit] : [source, auth.user_id, limit]));
        return json({ results });
      }
      const results = category ? listByCategory.all(category, auth.user_id, limit) : listRecent.all(auth.user_id, limit);
      return json({ results });
    }

    // ========================================================================
    // MEMORY — get / delete / forget
    // ========================================================================

    if (url.pathname.match(/^\/memory\/\d+\/forget$/) && method === "POST") {
      const id = Number(url.pathname.split("/")[2]);
      if (isNaN(id)) return errorResponse("Invalid id");
      // S7 FIX: Ownership check — only memory owner or admin can forget
      const mem = getMemoryWithoutEmbedding.get(id) as any;
      if (!mem) return errorResponse("Not found", 404);
      if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
      const body = await req.json().catch(() => ({})) as any;
      markForgotten.run(id);
      if (body.reason) {
        db.prepare("UPDATE memories SET forget_reason = ? WHERE id = ?").run(body.reason, id);
      }
      audit(auth.user_id, "memory.forget", "memory", id, body.reason || "manual", clientIp, requestId);
      invalidateEmbeddingCache();
      return json({ forgotten: true, id });
    }

    // ========================================================================
    // ARCHIVE / UNARCHIVE
    // ========================================================================

    if (url.pathname.match(/^\/memory\/\d+\/archive$/) && method === "POST") {
      const id = Number(url.pathname.split("/")[2]);
      if (isNaN(id)) return errorResponse("Invalid id");
      const mem = getMemoryWithoutEmbedding.get(id) as any;
      if (!mem) return errorResponse("Not found", 404);
      if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
      markArchived.run(id);
      audit(auth.user_id, "memory.archive", "memory", id, null, clientIp, requestId);
      invalidateEmbeddingCache();
      return json({ archived: true, id });
    }

    if (url.pathname.match(/^\/memory\/\d+\/unarchive$/) && method === "POST") {
      const id = Number(url.pathname.split("/")[2]);
      if (isNaN(id)) return errorResponse("Invalid id");
      const mem = getMemoryWithoutEmbedding.get(id) as any;
      if (!mem) return errorResponse("Not found", 404);
      if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
      markUnarchived.run(id);
      audit(auth.user_id, "memory.unarchive", "memory", id, null, clientIp, requestId);
      invalidateEmbeddingCache();
      return json({ unarchived: true, id });
    }

    // ========================================================================
    // UPDATE (versioned) — creates new version via version chain
    // ========================================================================

    if (url.pathname.match(/^\/memory\/\d+\/update$/) && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const id = Number(url.pathname.split("/")[2]);
        if (isNaN(id)) return errorResponse("Invalid id");
        const existing = getMemoryWithoutEmbedding.get(id) as any;
        if (!existing) return errorResponse("Not found", 404);
        if (!canAccessOwnedRow(existing, auth)) return errorResponse("Forbidden", 403);
        if (existing.is_forgotten) return errorResponse("Cannot update a forgotten memory", 400);

        const body = await req.json() as any;
        const newContent = body.content;
        if (!newContent || typeof newContent !== "string" || newContent.trim().length === 0) {
          return errorResponse("content is required and must be a non-empty string");
        }

        const category = body.category || existing.category;
        const imp = body.importance ? Math.max(1, Math.min(10, Number(body.importance))) : existing.importance;

        // Embed the new content
        let embBuffer: Buffer | null = null;
        let embArray: Float32Array | null = null;
        try {
          embArray = await embed(newContent.trim());
          embBuffer = embeddingToBuffer(embArray);
        } catch (e: any) {
          log.warn({ msg: "embedding_failed_update", error: e.message });
        }

        // Determine version chain
        const rootId = existing.root_memory_id || existing.id;
        const newVersion = (existing.version || 1) + 1;

        // Mark the old memory as superseded
        markSuperseded.run(id);

        // Insert the new version
        const result = insertMemory.get(
          newContent.trim(),
          category,
          existing.source,
          existing.session_id,
          imp,
          embBuffer,
          newVersion,      // version
          1,               // is_latest
          id,              // parent_memory_id
          rootId,          // root_memory_id
          existing.source_count || 1,
           existing.is_static ? 1 : 0,
           0,               // is_forgotten
           null,            // forget_after
           null,            // forget_reason
           existing.is_inference ? 1 : 0,
           existing.model || null, existing.user_id, existing.space_id || null
        ) as { id: number; created_at: string };

        db.prepare("UPDATE memories SET tags = ?, episode_id = ?, confidence = ? WHERE id = ?")
          .run(existing.tags || null, existing.episode_id || null, existing.confidence ?? 1.0, result.id);

        // Link old -> new as "updates"
        insertLink.run(result.id, id, 1.0, "updates");

        // Auto-link new version
        let linked = 0;
        if (embArray) {
          writeVec(result.id, embArray);
          linked = await autoLink(result.id, embArray, auth.user_id);
        }

        log.info({ msg: "memory_version_created", old_id: id, new_id: result.id, version: newVersion, root: rootId });

        return json({
          updated: true,
          old_id: id,
          new_id: result.id,
          version: newVersion,
          root_id: rootId,
          linked,
          embedded: !!embBuffer,
        });
      } catch (e: any) {
        return safeError("Update", e);
      }
    }

    // ========================================================================
    // DUPLICATES — find near-duplicate memory clusters
    // ========================================================================

    if (url.pathname === "/duplicates" && method === "GET") {
      try {
        const threshold = Number(url.searchParams.get("threshold") || 0.85);
        const limitParam = Math.min(Number(url.searchParams.get("limit") || 50), 200);

        const allMems = getCachedEmbeddings(true, auth.user_id);

        // Find clusters of similar memories
        const clusters: Array<{
          anchor: { id: number; content: string; category: string };
          duplicates: Array<{ id: number; content: string; category: string; similarity: number }>;
        }> = [];
        const seen = new Set<number>();

        for (let i = 0; i < allMems.length; i++) {
          if (seen.has(allMems[i].id)) continue;
          const embA = allMems[i].embedding;
          const dupes: Array<{ id: number; content: string; category: string; similarity: number }> = [];

          for (let j = i + 1; j < allMems.length; j++) {
            if (seen.has(allMems[j].id)) continue;
            const embB = allMems[j].embedding;
            const sim = cosineSimilarity(embA, embB);
            if (sim >= threshold) {
              dupes.push({
                id: allMems[j].id,
                content: allMems[j].content.substring(0, 200),
                category: allMems[j].category,
                similarity: Math.round(sim * 1000) / 1000,
              });
              seen.add(allMems[j].id);
            }
          }

          if (dupes.length > 0) {
            seen.add(allMems[i].id);
            clusters.push({
              anchor: {
                id: allMems[i].id,
                content: allMems[i].content.substring(0, 200),
                category: allMems[i].category,
              },
              duplicates: dupes,
            });
            if (clusters.length >= limitParam) break;
          }
        }

        return json({ threshold, clusters, total_clusters: clusters.length });
      } catch (e: any) {
        return safeError("Duplicate scan", e);
      }
    }

    // ========================================================================
    // DEDUPLICATE — merge duplicate clusters (keep anchor, archive dupes)
    // ========================================================================

    if (url.pathname === "/deduplicate" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const threshold = Number(body.threshold || 0.85);
        const dryRun = body.dry_run !== false; // default to dry run for safety
        const maxMerge = Math.min(Number(body.max_merge || 50), 500);

        const allMems = getCachedEmbeddings(true, auth.user_id);

        const merged: Array<{ kept: number; archived: number[]; similarity: number }> = [];
        const seen = new Set<number>();
        let totalArchived = 0;

        for (let i = 0; i < allMems.length && merged.length < maxMerge; i++) {
          if (seen.has(allMems[i].id)) continue;
          const embA = allMems[i].embedding;
          const dupes: Array<{ id: number; similarity: number; source_count: number }> = [];

          for (let j = i + 1; j < allMems.length; j++) {
            if (seen.has(allMems[j].id)) continue;
            const embB = allMems[j].embedding;
            const sim = cosineSimilarity(embA, embB);
            if (sim >= threshold) {
              dupes.push({ id: allMems[j].id, similarity: sim, source_count: allMems[j].source_count || 1 });
              seen.add(allMems[j].id);
            }
          }

          if (dupes.length > 0) {
            seen.add(allMems[i].id);

            if (!dryRun) {
              // Aggregate source_count to the kept memory
              let totalSourceCount = allMems[i].source_count || 1;
              for (const d of dupes) {
                totalSourceCount += (d.source_count || 1) - 1;
                markArchived.run(d.id);
                insertLink.run(allMems[i].id, d.id, d.similarity, "derives");
                totalArchived++;
              }
              db.prepare("UPDATE memories SET source_count = ?, updated_at = datetime('now') WHERE id = ?")
                .run(totalSourceCount, allMems[i].id);
            }

            merged.push({
              kept: allMems[i].id,
              archived: dupes.map(d => d.id),
              similarity: Math.round(dupes[0].similarity * 1000) / 1000,
            });
          }
        }

        return json({
          dry_run: dryRun,
          threshold,
          clusters_found: merged.length,
          total_archived: dryRun ? 0 : totalArchived,
          merges: merged,
        });
      } catch (e: any) {
        return safeError("Dedup", e);
      }
    }

    // ========================================================================
    // SMART RECALL — context-aware memory retrieval for plugin
    // ========================================================================

    if (url.pathname === "/recall" && method === "POST") {
      try {
        const body = await req.json() as any;
        const context = body.context || body.query || ""; // 'query' for BotMemory compat
        const limit = Math.min(Number(body.limit) || 20, 50);
        const includeTags = body.tags as string[] | undefined;
        const workingMemorySession = typeof body.session === "string" && body.session.trim() ? body.session.trim() : null;

        const results: Map<number, { memory: any; score: number; source: string }> = new Map();

        // 1. Static facts (always included, highest priority)
        const staticFacts = getStaticMemories.all(auth.user_id) as Array<any>;
        for (const sf of staticFacts) {
          results.set(sf.id, { memory: sf, score: 100, source: "static" });
        }

        // 2. Semantic search against context (if provided)
        if (context.trim()) {
          const semanticResults = await hybridSearch(context, limit, false, true, true, auth.user_id);
          for (const sr of semanticResults) {
            if (!results.has(sr.id)) {
              // Use decay_score instead of raw search score
              const decayMultiplier = sr.decay_score ? (sr.decay_score / sr.importance) : 1;
              results.set(sr.id, { memory: sr, score: sr.score * 50 * decayMultiplier, source: "semantic" });
            }
          }
        }

        // 3. High-importance memories weighted by decay (not just raw importance)
        const recentImportant = db.prepare(
          `SELECT id, content, category, source, importance, created_at, source_count, is_static,
             access_count, last_accessed_at, decay_score, tags, episode_id
           FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
           ORDER BY COALESCE(decay_score, importance) DESC, created_at DESC LIMIT ?`
        ).all(auth.user_id, limit) as Array<any>;
        for (const ri of recentImportant) {
          if (!results.has(ri.id)) {
            const effectiveScore = ri.decay_score || ri.importance;
            results.set(ri.id, { memory: ri, score: effectiveScore * 2, source: "important" });
          }
        }

        // 4. Recent activity (fill any remaining)
        const recent = listRecent.all(auth.user_id, Math.min(limit, 15)) as Array<any>;
        for (const r of recent) {
          if (!results.has(r.id)) {
            results.set(r.id, { memory: r, score: 1, source: "recent" });
          }
        }

        // 5. Tag-based boost: if caller specifies tags, boost matching memories
        if (includeTags && includeTags.length > 0) {
          for (const [id, entry] of results) {
            const mem = getMemoryWithoutEmbedding.get(id) as any;
            if (mem?.tags) {
              try {
                const memTags = JSON.parse(mem.tags) as string[];
                const overlap = includeTags.filter(t => memTags.includes(t)).length;
                if (overlap > 0) entry.score *= (1 + overlap * 0.2);
              } catch {}
            }
          }
        }

        // Sort by score descending, limit
        const sorted = Array.from(results.values())
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        // Track access on recalled memories
        for (const s of sorted) {
          trackAccessWithFSRS(s.memory.id);
        }

        // Episodic expansion: find episodes referenced by recalled memories
        const episodeContext: Array<{ episode_id: number; title: string; memory_count: number }> = [];
        const seenEpisodes = new Set<number>();
        for (const s of sorted) {
          const mem = getMemoryWithoutEmbedding.get(s.memory.id) as any;
          if (mem?.episode_id && !seenEpisodes.has(mem.episode_id)) {
            seenEpisodes.add(mem.episode_id);
            const ep = getEpisodeForUser.get(mem.episode_id, auth.user_id) as any;
            if (ep) {
              episodeContext.push({
                episode_id: mem.episode_id,
                title: ep.title || `Session ${ep.session_id || ep.id}`,
                memory_count: ep.memory_count,
              });
            }
          }
        }

        let workingMemory = "";
        try {
          const scratchRows = listScratchEntriesForContext.all(auth.user_id, workingMemorySession, workingMemorySession) as ScratchEntryRow[];
          workingMemory = buildWorkingMemoryBlock(scratchRows);
        } catch {}

        return json({
          // Standard Engram format
          memories: sorted.map(s => ({
            ...s.memory,
            recall_source: s.source,
            recall_score: Math.round(s.score * 100) / 100,
            tags: s.memory.tags ? (() => { try { return JSON.parse(s.memory.tags); } catch { return []; } })() : [],
          })),
          breakdown: {
            static: sorted.filter(s => s.source === "static").length,
            semantic: sorted.filter(s => s.source === "semantic").length,
            important: sorted.filter(s => s.source === "important").length,
            recent: sorted.filter(s => s.source === "recent").length,
          },
          ...(episodeContext.length > 0 ? { episodes: episodeContext } : {}),
          // BotMemory v1 compat fields (for Discord bots)
          profile: sorted.filter(s => s.source === "static").map(s => s.memory.content),
          recent: sorted.filter(s => s.source === "recent").map(s => ({
            id: s.memory.id, content: s.memory.content, category: s.memory.category,
            source: s.memory.source, createdAt: s.memory.created_at,
          })),
          results: sorted.filter(s => s.source === "semantic" || s.source === "important").map(s => ({
            id: s.memory.id, content: s.memory.content, category: s.memory.category,
            source: s.memory.source, score: s.score, createdAt: s.memory.created_at,
          })),
          ...(workingMemory ? { working_memory: workingMemory } : {}),
          count: sorted.length,
        });
      } catch (e: any) {
        return safeError("Smart recall", e);
      }
    }

    if (url.pathname.startsWith("/memory/") && method === "GET") {
      const id = Number(url.pathname.split("/")[2]);
      if (isNaN(id)) return errorResponse("Invalid id");
      const memory = getMemoryWithoutEmbedding.get(id) as any;
      if (!memory) return errorResponse("Not found", 404);
      // S7 FIX: User isolation — only owner or admin can read
      if (memory.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Not found", 404);

      // Track access
      trackAccessWithFSRS(id);

      const links = getLinksForUser.all(id, auth.user_id, id, auth.user_id) as Array<{
        id: number; similarity: number; type: string; content: string; category: string;
      }>;

      const rootId = memory.root_memory_id || memory.id;
      const chain = getVersionChainForUser.all(rootId, rootId, auth.user_id) as Array<{
        id: number; content: string; version: number; is_latest: boolean;
        created_at: string; source_count: number;
      }>;

      // Parse tags and include episode info
      let tags: string[] = [];
      try { tags = memory.tags ? JSON.parse(memory.tags) : []; } catch {}
      let episode = null;
      if (memory.episode_id) {
        episode = getEpisodeForUser.get(memory.episode_id, auth.user_id) as any;
      }

      return json({
        ...memory,
        tags,
        episode: episode ? { id: episode.id, title: episode.title, session_id: episode.session_id } : null,
        decay_score: fsrsCalculateDecayScore(
          memory.importance, memory.created_at, memory.access_count || 0,
          memory.last_accessed_at, !!memory.is_static, memory.source_count || 1
        ),
        links: links.map(l => ({ ...l })),
        version_chain: chain.length > 1 ? chain : undefined,
      });
    }

    if (url.pathname.startsWith("/memory/") && method === "DELETE") {
      const id = Number(url.pathname.split("/")[2]);
      if (isNaN(id)) return errorResponse("Invalid id");
      // S7 FIX: Ownership check — only memory owner or admin can delete
      const mem = getMemoryWithoutEmbedding.get(id) as any;
      if (!mem) return errorResponse("Not found", 404);
      if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
      deleteMemory(id);
      audit(auth.user_id, "memory.delete", "memory", id, null, clientIp, requestId);
      invalidateEmbeddingCache();
      return json({ deleted: true, id });
    }

    // ========================================================================
    // BACKFILL
    // ========================================================================

    if (url.pathname === "/backfill" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json().catch(() => ({}));
        const batch = Math.min(Number((body as any).batch) || 50, 200);
        const count = await backfillEmbeddings(batch, auth.user_id);
        const remaining = (countNoEmbeddingForUser.get(auth.user_id) as { count: number }).count;
        return json({ backfilled: count, remaining });
      } catch (e: any) {
        return safeError("Backfill", e);
      }
    }

    // ========================================================================
    // LINKS
    // ========================================================================

    if (url.pathname.startsWith("/links/") && method === "GET") {
      const id = Number(url.pathname.split("/")[2]);
      if (isNaN(id)) return errorResponse("Invalid id");
      const mem = getMemoryWithoutEmbedding.get(id) as any;
      if (!canAccessOwnedRow(mem, auth)) return errorResponse("Not found", 404);
      const links = getLinksForUser.all(id, auth.user_id, id, auth.user_id);
      return json({ memory_id: id, links });
    }

    // ========================================================================
    // PROFILE
    // ========================================================================

    if (url.pathname === "/profile" && method === "GET") {
      try {
        const summary = url.searchParams.get("summary") === "true";
        const profile = await generateProfile(auth.user_id, summary);
        return json(profile);
      } catch (e: any) {
        return safeError("Profile generation", e);
      }
    }

    // ========================================================================
    // PROFILE SYNTHESIZE — personality narrative from accumulated signals
    // ========================================================================

    if (url.pathname === "/profile/synthesize" && method === "POST") {
      try {
        const body = await req.json().catch(() => ({})) as any;
        const force = !!body.force;

        // Check cache first unless force
        if (!force) {
          const cached = getCachedProfile(auth.user_id);
          if (cached) {
            const signalCount = (getPersonalitySignalCount.get(auth.user_id) as { count: number }).count;
            return json({ profile: cached, signal_count: signalCount, cached: true });
          }
        }

        const profile = await synthesizePersonalityProfile(auth.user_id);
        const signalCount = (getPersonalitySignalCount.get(auth.user_id) as { count: number }).count;
        return json({ profile, signal_count: signalCount, cached: false });
      } catch (e: any) {
        return safeError("Profile synthesis", e);
      }
    }

    // ========================================================================
    // RAW GRAPH DATA (legacy — use GET /graph with params instead)
    // ========================================================================

    if (url.pathname === "/graph/raw" && method === "GET") {
      const memories = getAllMemoriesForGraph.all(auth.user_id);
      const links = getAllLinksForGraph.all(auth.user_id);
      return json({ memories, links });
    }

    // ========================================================================
    // VERSION CHAIN
    // ========================================================================

    if (url.pathname.startsWith("/versions/") && method === "GET") {
      const id = Number(url.pathname.split("/")[2]);
      if (isNaN(id)) return errorResponse("Invalid id");
      const mem = getMemoryWithoutEmbedding.get(id) as any;
      if (!mem) return errorResponse("Not found", 404);
      if (!canAccessOwnedRow(mem, auth)) return errorResponse("Not found", 404);
      const rootId = mem.root_memory_id || mem.id;
      const chain = getVersionChainForUser.all(rootId, rootId, auth.user_id);
      return json({ root_id: rootId, chain });
    }

    // ========================================================================
    // SWEEP
    // ========================================================================

    if (url.pathname === "/sweep" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const count = sweepExpiredMemories(auth.user_id);
      return json({ swept: count });
    }

    // ========================================================================
    // CONVERSATIONS
    // ========================================================================

    if (url.pathname === "/conversations" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const { agent, session_id, title, metadata } = body;
        if (!agent || typeof agent !== "string") return errorResponse("agent is required");
        const result = insertConversation.get(
          agent.trim(), session_id || null, title || null,
          metadata ? JSON.stringify(metadata) : null,
          auth.user_id
        ) as { id: number; started_at: string };
        return json({ id: result.id, started_at: result.started_at });
      } catch (e: any) {
        return safeError("create conversation", e);
      }
    }

    if (url.pathname === "/conversations" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
      const agent = url.searchParams.get("agent");
      const results = agent
        ? listConversationsByAgent.all(auth.user_id, agent, limit)
        : listConversations.all(auth.user_id, limit);
      return json({ results });
    }

    if (/^\/conversations\/\d+$/.test(url.pathname) && method === "GET") {
      const id = Number(url.pathname.split("/")[2]);
      const conv = getConversationForUser.get(id, auth.user_id) as any;
      if (!conv) return errorResponse("Not found", 404);
      const limit = Math.min(Number(url.searchParams.get("limit") || 10000), 100000);
      const offset = Number(url.searchParams.get("offset") || 0);
      const msgs = getMessages.all(id, limit, offset);
      return json({ conversation: conv, messages: msgs });
    }

    if (/^\/conversations\/\d+$/.test(url.pathname) && method === "PATCH") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const id = Number(url.pathname.split("/")[2]);
        const conv = getConversationForUser.get(id, auth.user_id) as any;
        if (!conv) return errorResponse("Not found", 404);
        const body = await req.json() as any;
        updateConversation.run(
          body.title || null,
          body.metadata ? JSON.stringify(body.metadata) : null,
          id,
          auth.user_id
        );
        return json({ updated: true, id });
      } catch (e: any) {
        return safeError("update", e);
      }
    }

    if (/^\/conversations\/\d+$/.test(url.pathname) && method === "DELETE") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const id = Number(url.pathname.split("/")[2]);
      deleteConversation.run(id, auth.user_id);
      return json({ deleted: true, id });
    }

    // ========================================================================
    // MESSAGES
    // ========================================================================

    if (/^\/conversations\/\d+\/messages$/.test(url.pathname) && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const convId = Number(url.pathname.split("/")[2]);
        const conv = getConversationForUser.get(convId, auth.user_id);
        if (!conv) return errorResponse("Conversation not found", 404);
        const body = await req.json() as any;
        const msgs = Array.isArray(body) ? body : [body];
        const results: Array<{ id: number; created_at: string }> = [];
        for (const msg of msgs) {
          if (!msg.role || !msg.content) continue;
          const result = insertMessage.get(
            convId, msg.role, msg.content, msg.metadata ? JSON.stringify(msg.metadata) : null
          ) as { id: number; created_at: string };
          results.push(result);
        }
        touchConversation.run(convId);
        return json({ added: results.length, messages: results });
      } catch (e: any) {
        return safeError("add messages", e);
      }
    }

    // ========================================================================
    // BULK + UPSERT
    // ========================================================================

    if (url.pathname === "/conversations/bulk" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const { agent, session_id, title, metadata, messages: msgs } = body;
        if (!agent) return errorResponse("agent is required");
        if (!msgs || !Array.isArray(msgs) || msgs.length === 0) {
          return errorResponse("messages array is required and must not be empty");
        }
        const conv = bulkInsertConvo(
          agent.trim(), session_id || null, title || null,
          metadata ? JSON.stringify(metadata) : null,
          auth.user_id,
          msgs.map((m: any) => ({
            role: m.role || "user",
            content: m.content || "",
            metadata: m.metadata ? JSON.stringify(m.metadata) : null,
          }))
        );
        return json({ id: conv.id, started_at: conv.started_at, messages: msgs.length });
      } catch (e: any) {
        return safeError("Bulk store", e);
      }
    }

    if (url.pathname === "/conversations/upsert" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const { agent, session_id, title, metadata, messages: msgs } = body;
        if (!agent) return errorResponse("agent is required");
        if (!session_id) return errorResponse("session_id is required for upsert");

        let conv = getConversationBySession.get(agent, session_id, auth.user_id) as any;
        let created = false;
        if (!conv) {
          const result = insertConversation.get(
            agent, session_id, title || null,
            metadata ? JSON.stringify(metadata) : null,
            auth.user_id
          ) as { id: number; started_at: string };
          conv = { id: result.id };
          created = true;
        } else if (title || metadata) {
          updateConversation.run(
            title || null,
            metadata ? JSON.stringify(metadata) : null,
            conv.id,
            auth.user_id
          );
        }

        let added = 0;
        if (msgs && Array.isArray(msgs)) {
          for (const msg of msgs) {
            if (!msg.role || !msg.content) continue;
            insertMessage.run(
              conv.id, msg.role, msg.content,
              msg.metadata ? JSON.stringify(msg.metadata) : null
            );
            added++;
          }
          if (added > 0) touchConversation.run(conv.id);
        }
        return json({ id: conv.id, created, added });
      } catch (e: any) {
        return safeError("Upsert", e);
      }
    }

    // ========================================================================
    // SEARCH MESSAGES
    // ========================================================================

    if (url.pathname === "/messages/search" && method === "POST") {
      try {
        const body = await req.json() as any;
        const { query, limit } = body;
        if (!query || typeof query !== "string") return errorResponse("query is required");
        const sanitized = sanitizeFTS(query);
        if (!sanitized) return json({ results: [] });
        const results = searchMessages.all(sanitized, auth.user_id, Math.min(limit || 30, 200));
        return json({ results });
      } catch (e: any) {
        return safeError("Search", e);
      }
    }

    // ========================================================================
    // GUI CRUD — create/edit/delete memories from the web interface
    // ========================================================================

    if (url.pathname === "/gui/memories" && method === "POST") {
      if (!guiAuthed(req)) return errorResponse("GUI auth required", 401);
      try {
        const body = await req.json() as any;
        if (!body.content?.trim()) return errorResponse("content is required");
        const imp = Math.max(1, Math.min(10, Number(body.importance) || 5));
        let tagsJson: string | null = null;
        if (body.tags) {
          const tags = Array.isArray(body.tags) ? body.tags : body.tags.split(",");
          tagsJson = JSON.stringify(tags.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean));
        }
        let embBuffer: Buffer | null = null;
        try {
          const embArray = await embed(body.content.trim());
          embBuffer = embeddingToBuffer(embArray);
          const result = insertMemory.get(
            body.content.trim(), body.category || "general", "gui", null,
            imp, embBuffer, 1, 1, null, null, 1, body.is_static ? 1 : 0, 0, null, null, 0, null, 1, null
          ) as { id: number; created_at: string };
          db.prepare("UPDATE memories SET tags = ? WHERE id = ?").run(tagsJson, result.id);
          const initFSRS2 = fsrsProcessReview(null, FSRSRating.Good, 0);
          const decayScore = fsrsCalculateDecayScore(imp, result.created_at, 0, null, !!(body as any).is_static, 1, initFSRS2.stability);
          db.prepare("UPDATE memories SET decay_score = ?, fsrs_stability = ?, fsrs_difficulty = ?, fsrs_storage_strength = ?, fsrs_retrieval_strength = ?, fsrs_learning_state = ?, fsrs_reps = ?, fsrs_lapses = ?, fsrs_last_review_at = ? WHERE id = ?").run(
            Math.round(decayScore * 1000) / 1000,
            initFSRS2.stability, initFSRS2.difficulty, initFSRS2.storage_strength,
            initFSRS2.retrieval_strength, initFSRS2.learning_state, initFSRS2.reps, initFSRS2.lapses,
            initFSRS2.last_review_at, result.id
          );
          writeVec(result.id, embArray);
          await autoLink(result.id, embArray, auth.user_id);
          return json({ created: true, id: result.id });
        } catch (e: any) {
          return safeError("Operation", e);
        }
      } catch (e: any) { return errorResponse(`Bad request: ${e.message}`, 400); }
    }

    if (url.pathname.match(/^\/gui\/memories\/\d+$/) && method === "PATCH") {
      if (!guiAuthed(req)) return errorResponse("GUI auth required", 401);
      try {
        const id = Number(url.pathname.split("/")[3]);
        const body = await req.json() as any;
        const sets: string[] = [];
        const vals: any[] = [];
        if (body.content !== undefined) { sets.push("content = ?"); vals.push(body.content.trim()); }
        if (body.category !== undefined) { sets.push("category = ?"); vals.push(body.category); }
        if (body.importance !== undefined) { sets.push("importance = ?"); vals.push(Math.max(1, Math.min(10, Number(body.importance)))); }
        if (body.is_static !== undefined) { sets.push("is_static = ?"); vals.push(body.is_static ? 1 : 0); }
        if (sets.length === 0) return errorResponse("Nothing to update");
        sets.push("updated_at = datetime('now')");
        vals.push(id);
        db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        // Re-embed if content changed
        if (body.content !== undefined) {
          try {
            const emb = await embed(body.content.trim());
            updateMemoryEmbedding.run(embeddingToBuffer(emb), id); try { updateMemoryVec.run(embeddingToVectorJSON(emb), id); } catch {}
          } catch {}
        }
        // B5 FIX: Invalidate cache so search reflects edits
        invalidateEmbeddingCache();
        return json({ updated: true, id });
      } catch (e: any) { return safeError("Operation", e); }
    }

    if (url.pathname.match(/^\/gui\/memories\/\d+$/) && method === "DELETE") {
      if (!guiAuthed(req)) return errorResponse("GUI auth required", 401);
      const id = Number(url.pathname.split("/")[3]);
      deleteMemory(id);
      audit(null, "gui.delete", "memory", id, null, clientIp, requestId);
      return json({ deleted: true, id });
    }

    if (url.pathname === "/gui/memories/bulk-archive" && method === "POST") {
      if (!guiAuthed(req)) return errorResponse("GUI auth required", 401);
      try {
        const body = await req.json() as any;
        const ids = body.ids;
        if (!Array.isArray(ids)) return errorResponse("ids array required");
        let count = 0;
        for (const id of ids) { markArchived.run(id); count++; }
        return json({ archived: count });
      } catch (e: any) { return safeError("Operation", e); }
    }

    // ========================================================================
    // TAGS — v4.1
    // ========================================================================

    if (url.pathname === "/tags" && method === "GET") {
      const rows = getAllTags.all(auth.user_id) as Array<{ tags: string }>;
      const tagSet = new Set<string>();
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.tags) as string[];
          for (const t of parsed) tagSet.add(t);
        } catch {}
      }
      return json({ tags: Array.from(tagSet).sort() });
    }

    if (url.pathname === "/tags/search" && method === "POST") {
      try {
        const body = await req.json() as any;
        const tag = body.tag?.trim().toLowerCase();
        if (!tag) return errorResponse("tag is required");
        const limit = Math.min(Number(body.limit) || 20, 100);
        const safeTag = tag
          .replace(/\\/g, "\\\\")
          .replace(/%/g, "\\%")
          .replace(/_/g, "\\_");
        const results = getByTag.all(`%"${safeTag}"%`, auth.user_id, limit) as any[];
        for (const r of results) {
          try { r.tags = JSON.parse(r.tags); } catch { r.tags = []; }
          trackAccessWithFSRS(r.id);
        }
        return json({ results, tag });
      } catch (e: any) {
        return safeError("Tag search", e);
      }
    }

    if (url.pathname.match(/^\/memory\/\d+\/tags$/) && method === "PUT") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const id = Number(url.pathname.split("/")[2]);
        const mem = getMemoryWithoutEmbedding.get(id) as any;
        if (!mem) return errorResponse("Not found", 404);
        if (mem.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
        const body = await req.json() as any;
        let tags: string[] = [];
        if (Array.isArray(body.tags)) {
          tags = body.tags.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean);
        }
        db.prepare("UPDATE memories SET tags = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(tags), id);
        return json({ updated: true, id, tags });
      } catch (e: any) {
        return safeError("update tags", e);
      }
    }

    // ========================================================================
    // EPISODES — v4.1
    // ========================================================================

    if (url.pathname === "/episodes" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const ep = insertEpisode.get(
          body.title || null, body.session_id || null, body.agent || null, auth.user_id
        ) as { id: number; started_at: string };

        // If conversation text provided, generate narrative summary via LLM
        let summary = body.summary || null;
        if (body.conversation && isLLMAvailable() && !summary) {
          try {
            summary = await callLLM(
              `You are a memory system. Summarize this conversation into a concise episodic narrative (1-3 paragraphs). Capture: what the user asked for, what the assistant did, key decisions made, problems solved, and outcomes. Include temporal flow ("first... then... finally..."). Write in past tense.`,
              body.conversation.substring(0, 8000)
            );
          } catch (e: any) {
            log.warn({ msg: "episode_summarization_failed", error: e.message });
          }
        }

        // Update with summary, timestamps, duration
        if (summary || body.ended_at) {
          updateEpisodeForUser.run(body.title || null, summary, body.ended_at || null, ep.id, auth.user_id);
        }
        if (body.started_at && body.ended_at) {
          const dur = Math.round((new Date(body.ended_at).getTime() - new Date(body.started_at).getTime()) / 1000);
          if (dur > 0) db.prepare("UPDATE episodes SET duration_seconds = ? WHERE id = ?").run(dur, ep.id);
        }

        // Embed the summary for semantic search
        const textToEmbed = summary || body.title || body.conversation?.substring(0, 500) || "";
        if (textToEmbed) {
          try {
            const embArray = await embed(textToEmbed);
            updateEpisodeEmbedding.run(embeddingToBuffer(embArray), ep.id);
            try { updateEpisodeVec.run(embeddingToVectorJSON(embArray), ep.id); } catch {}
            refreshEmbeddingCache();
          } catch (e: any) {
            log.warn({ msg: "episode_embed_failed", error: e.message });
          }
        }

        return json({ created: true, id: ep.id, started_at: ep.started_at, summary });
      } catch (e: any) {
        return safeError("create episode", e);
      }
    }

    if (url.pathname === "/episodes" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
      const query = url.searchParams.get("query");
      const after = url.searchParams.get("after");
      const before = url.searchParams.get("before");

      // Temporal search
      if (after || before) {
        const from = after || "2000-01-01";
        const to = before || "2099-12-31";
        const episodes = listEpisodesByTimeRange.all(auth.user_id, from, to, limit) as any[];
        return json({ episodes });
      }

      // Semantic search over episodes
      if (query) {
        try {
          const queryEmb = await embed(query);
          const scored: Array<any & { score: number }> = [];

          // Vector search over episode cache
          for (const ep of episodeCache) {
            if (ep.user_id !== auth.user_id) continue;
            const sim = cosineSimilarity(queryEmb, ep.embedding);
            if (sim > 0.3) scored.push({ id: ep.id, summary: ep.summary, score: sim });
          }

          // FTS search
          try {
            const ftsHits = searchEpisodesFTS.all(sanitizeFTS(query), auth.user_id, limit) as any[];
            for (const hit of ftsHits) {
              const existing = scored.find(s => s.id === hit.id);
              if (existing) { existing.score += 0.2; }
              else { scored.push({ ...hit, score: 0.3 }); }
            }
          } catch {}

          scored.sort((a, b) => b.score - a.score);
          const topIds = scored.slice(0, limit).map(s => s.id);
            const episodes = topIds.map(id => {
              const ep = getEpisodeForUser.get(id, auth.user_id) as any;
              const s = scored.find(x => x.id === id);
              return ep ? { ...ep, score: Math.round((s?.score || 0) * 1000) / 1000 } : null;
            }).filter(Boolean);

          return json({ episodes });
        } catch (e: any) {
          return safeError("episode search", e);
        }
      }

      // Default: list recent
      const episodes = listEpisodes.all(auth.user_id, limit) as any[];
      return json({ episodes });
    }

    if (/^\/episodes\/\d+$/.test(url.pathname) && method === "GET") {
      const id = Number(url.pathname.split("/")[2]);
      const episode = getEpisodeForUser.get(id, auth.user_id) as any;
      if (!episode) return errorResponse("Episode not found", 404);
      const memories = getEpisodeMemories.all(id, auth.user_id) as any[];
      for (const m of memories) {
        try { m.tags = JSON.parse(m.tags); } catch { m.tags = []; }
      }
      return json({ ...episode, memories });
    }

    if (/^\/episodes\/\d+$/.test(url.pathname) && method === "PATCH") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const id = Number(url.pathname.split("/")[2]);
        const episode = getEpisodeForUser.get(id, auth.user_id) as any;
        if (!episode) return errorResponse("Episode not found", 404);
        const body = await req.json() as any;
        updateEpisodeForUser.run(body.title || null, body.summary || null, body.ended_at || null, id, auth.user_id);
        // Re-embed if summary changed
        if (body.summary) {
          try {
            const embArray = await embed(body.summary);
            updateEpisodeEmbedding.run(embeddingToBuffer(embArray), id);
            try { updateEpisodeVec.run(embeddingToVectorJSON(embArray), id); } catch {}
            refreshEmbeddingCache();
          } catch {}
        }
        return json({ updated: true, id });
      } catch (e: any) {
        return safeError("update episode", e);
      }
    }

    if (/^\/episodes\/\d+\/memories$/.test(url.pathname) && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const episodeId = Number(url.pathname.split("/")[2]);
        const episode = getEpisodeForUser.get(episodeId, auth.user_id) as any;
        if (!episode) return errorResponse("Episode not found", 404);
        const body = await req.json() as any;
        const memoryIds = body.memory_ids;
        if (!Array.isArray(memoryIds)) return errorResponse("memory_ids array required");
        let assigned = 0;
        for (const mid of memoryIds) {
          const mem = getMemoryWithoutEmbedding.get(mid) as any;
          if (!canAccessOwnedRow(mem, auth)) continue;
          assignToEpisodeForUser.run(episodeId, mid, auth.user_id);
          assigned++;
        }
        updateEpisodeForUser.run(null, null, null, episodeId, auth.user_id);
        return json({ assigned, episode_id: episodeId });
      } catch (e: any) {
        return safeError("assign memories", e);
      }
    }

    // Finalize episode: generate summary from memories, embed, set ended_at
    if (/^\/episodes\/\d+\/finalize$/.test(url.pathname) && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const episodeId = Number(url.pathname.split("/")[2]);
        const ep = getEpisodeForUser.get(episodeId, auth.user_id) as any;
        if (!ep) return errorResponse("Episode not found", 404);

        const memories = getEpisodeMemories.all(episodeId, auth.user_id) as Array<{ content: string; category: string; created_at: string }>;
        if (memories.length === 0) return errorResponse("Episode has no memories", 400);

        let summary = ep.summary;
        if (!summary) {
          if (isLLMAvailable()) {
            try {
              const memText = memories.map(m => `[${m.category}] ${m.content}`).join("\n").substring(0, 8000);
              summary = await callLLM(
                `You are a memory system. Summarize these memories from a single session into a concise episodic narrative (1-3 paragraphs). Capture: what the user asked for, what the assistant did, key decisions made, problems solved, and outcomes. Include temporal flow. Write in past tense.`,
                memText
              );
            } catch (e: any) {
              log.warn({ msg: "episode_llm_summary_failed", error: e.message });
            }
          }
          if (!summary) {
            summary = memories.map(m => m.content).join(" ").substring(0, 1000);
          }
        }

        const endedAt = new Date().toISOString().replace("T", " ").replace("Z", "");
        updateEpisodeForUser.run(ep.title || `Session ${ep.session_id || ep.id}`, summary, endedAt, episodeId, auth.user_id);

        // Calculate duration
        if (ep.started_at) {
          const dur = Math.round((Date.now() - new Date(ep.started_at).getTime()) / 1000);
          if (dur > 0) db.prepare("UPDATE episodes SET duration_seconds = ? WHERE id = ?").run(dur, episodeId);
        }

        // Embed the summary
        try {
          const embArray = await embed(summary);
          updateEpisodeEmbedding.run(embeddingToBuffer(embArray), episodeId);
          try { updateEpisodeVec.run(embeddingToVectorJSON(embArray), episodeId); } catch {}
          refreshEmbeddingCache();
        } catch (e: any) {
          log.warn({ msg: "episode_finalize_embed_failed", error: e.message });
        }

        return json({ finalized: true, id: episodeId, summary, memory_count: memories.length });
      } catch (e: any) {
        return safeError("finalize episode", e);
      }
    }

    // ========================================================================
    // AGENT IDENTITY — registration, trust scoring, passports
    // ========================================================================

    if (url.pathname === "/agents" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const { name, category, description, code_hash } = body;
        if (!name || typeof name !== "string") return errorResponse("name (string) required");

        // Check if agent already exists for this user
        const existing = getAgentByName.get(name, auth.user_id) as any;
        if (existing) return errorResponse(`Agent '${name}' already registered`, 409);

        const row = insertAgent.get(auth.user_id, name, category || null, description || null, code_hash || null) as any;

        // Auto-link to the current API key if authenticated with one
        if (auth.key_id) {
          linkKeyToAgent.run(row.id, auth.key_id, auth.user_id);
        }

        audit(auth.user_id, "agent.register", "agent", row.id, name, clientIp, requestId, row.id);
        return json({ agent_id: row.id, name, trust_score: row.trust_score, created_at: row.created_at }, 201);
      } catch (e: any) {
        return safeError("agent register", e);
      }
    }

    if (url.pathname === "/agents" && method === "GET") {
      try {
        const agents = listAgents.all(auth.user_id) as any[];
        return json({ agents });
      } catch (e: any) {
        return safeError("list agents", e);
      }
    }

    // GET /agents/:id
    {
      const agentMatch = url.pathname.match(/^\/agents\/(\d+)$/);
      if (agentMatch && method === "GET") {
        const agentId = Number(agentMatch[1]);
        const agent = getAgentById.get(agentId, auth.user_id) as any;
        if (!agent) return errorResponse("Agent not found", 404);
        const { code_hash, ...safe } = agent;
        return json(safe);
      }

      // POST /agents/:id/revoke
      if (agentMatch && method === "POST" && url.pathname.endsWith("/revoke")) {
        // already matched by agentMatch — need separate pattern
      }
    }

    {
      const revokeMatch = url.pathname.match(/^\/agents\/(\d+)\/revoke$/);
      if (revokeMatch && method === "POST") {
        if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
        const agentId = Number(revokeMatch[1]);
        const body = await req.json().catch(() => ({})) as any;
        const reason = body.reason || "revoked";
        revokeAgent.run(reason, agentId, auth.user_id);
        audit(auth.user_id, "agent.revoke", "agent", agentId, reason, clientIp, requestId, agentId);
        return json({ revoked: true, agent_id: agentId });
      }
    }

    // GET /agents/:id/passport
    {
      const passportMatch = url.pathname.match(/^\/agents\/(\d+)\/passport$/);
      if (passportMatch && method === "GET") {
        const agentId = Number(passportMatch[1]);
        const agent = getAgentById.get(agentId, auth.user_id) as any;
        if (!agent) return errorResponse("Agent not found", 404);
        if (!agent.is_active) return errorResponse("Agent is revoked", 403);
        const passport = createPassport(signingSecret, agent, auth.user_id);
        return json(passport);
      }
    }

    // POST /agents/:id/link-key — link an API key to this agent
    {
      const linkMatch = url.pathname.match(/^\/agents\/(\d+)\/link-key$/);
      if (linkMatch && method === "POST") {
        if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
        const agentId = Number(linkMatch[1]);
        const body = await req.json() as any;
        const keyId = body.key_id;
        if (!keyId) return errorResponse("key_id required");
        const agent = getAgentById.get(agentId, auth.user_id) as any;
        if (!agent) return errorResponse("Agent not found", 404);
        linkKeyToAgent.run(agentId, keyId, auth.user_id);
        return json({ linked: true, agent_id: agentId, key_id: keyId });
      }
    }

    // GET /agents/:id/executions — signed execution history
    {
      const execMatch = url.pathname.match(/^\/agents\/(\d+)\/executions$/);
      if (execMatch && method === "GET") {
        const agentId = Number(execMatch[1]);
        const agent = getAgentById.get(agentId, auth.user_id) as any;
        if (!agent) return errorResponse("Agent not found", 404);
        const limit = Number(url.searchParams.get("limit") || 50);
        const executions = getAgentExecutions.all(agentId, limit) as any[];
        return json({ agent_id: agentId, executions });
      }
    }

    // POST /verify — verify a signed execution or passport
    if (url.pathname === "/verify" && method === "POST") {
      try {
        const body = await req.json() as any;
        if (body.passport) {
          const result = verifyPassport(signingSecret, body.passport);
          return json({ type: "passport", ...result });
        }
        if (body.execution) {
          const valid = verifyExecution(signingSecret, body.execution);
          return json({ type: "execution", valid });
        }
        if (body.message) {
          const result = verifyMessage(signingSecret, body.message, nonceTracker);
          return json({ type: "message", ...result });
        }
        if (body.tool_manifest) {
          const result = verifyToolManifest(signingSecret, body.tool_manifest);
          return json({ type: "tool_manifest", ...result });
        }
        return errorResponse("Provide 'passport', 'execution', 'message', or 'tool_manifest' to verify");
      } catch (e: any) {
        return safeError("verify", e);
      }
    }

    // ========================================================================
    // GUARDRAILS — pre-action conflict check against stored rules + trust
    // ========================================================================

    function heuristicGuard(action: string, rules: Array<{ content: string; score: number; importance: number }>): "allow" | "warn" | "block" {
      for (const r of rules) {
        const rl = r.content.toLowerCase();
        const hasProhibition = /\bnever\b|\bdo not\b|\bdon't\b|\bcritical\b|\bnot\b.*\ballowed\b|\bno\s+(?:purple|blue|indigo)\b/.test(rl);
        // Any importance-10 rule that matches at all = warn (these are critical rules)
        if (r.importance >= 10) return "warn";
        // Prohibition language in a static rule = warn
        if (hasProhibition) return "warn";
      }
      return "allow";
    }

    if (url.pathname === "/guard" && method === "POST") {
      try {
        const body = await req.json() as any;
        const action = body.action;
        if (!action || typeof action !== "string") return errorResponse("action (string) required — describe what you are about to do");

        // Search static high-importance memories for conflicts
        const results = await hybridSearch(action, 20, false, false, true, auth.user_id);
        const rules = results.filter(r => r.is_static && r.importance >= 8);

        // Get agent trust score if identified
        let trustScore: number | null = null;
        if (auth.agent_id) {
          const agent = db.prepare("SELECT trust_score FROM agents WHERE id = ?").get(auth.agent_id) as any;
          if (agent) trustScore = agent.trust_score;
        }

        if (rules.length === 0) {
          // Record clean guard pass
          recordAgentGuard(auth.agent_id, "allow");
          const exec = auth.agent_id ? signExecution(signingSecret, auth.agent_id, "guard", { action }, { signal: "allow" }) : null;
          if (exec) audit(auth.user_id, "guard", null, null, "allow", clientIp, requestId, auth.agent_id, exec.execution_hash, exec.signature);
          return json({ signal: "allow", action, rules: [], message: "No conflicting rules found.", trust_score: trustScore, execution: exec });
        }

        // Ask LLM if any rules conflict with the proposed action
        let signal: "allow" | "warn" | "block" = "warn";
        let message = "";

        if (isLLMAvailable()) {
          try {
            const trustContext = trustScore !== null ? `\nAGENT TRUST SCORE: ${trustScore}/100 (${trustScore < 30 ? "LOW — be strict" : trustScore < 70 ? "MODERATE" : "HIGH — earned trust"})` : "";
            const rulesText = rules.slice(0, 5).map((r, i) => `RULE ${i + 1} (importance ${r.importance}): ${r.content}`).join("\n\n");
            const llmResult = await callLLM(
              `You are a guardrail system. Given an agent's PROPOSED ACTION and a set of RULES from memory, determine if the action conflicts with any rule. Respond with ONLY one of: BLOCK (action directly violates a rule), WARN (action is related to a rule and should proceed with caution), or ALLOW (no conflict). After the signal word, write a brief explanation on the same line.${trustContext ? " Factor the agent's trust score into borderline decisions — low-trust agents should get WARN or BLOCK more readily." : ""}`,
              `PROPOSED ACTION: ${action}\n\nRULES:\n${rulesText}${trustContext}`
            );
            const first = llmResult.trim().split("\n")[0].toUpperCase();
            if (first.startsWith("BLOCK")) { signal = "block"; message = llmResult.trim(); }
            else if (first.startsWith("ALLOW")) { signal = "allow"; message = llmResult.trim(); }
            else { signal = "warn"; message = llmResult.trim(); }
          } catch {
            signal = heuristicGuard(action, rules);
            message = signal !== "allow" ? "Rule conflict detected (semantic + keyword heuristic). Review the rules before proceeding." : "No conflicts detected (LLM unavailable for deeper analysis).";
          }
        } else {
          signal = heuristicGuard(action, rules);
          // Trust-based escalation: low-trust agent + heuristic warn → block
          if (trustScore !== null && trustScore < 30 && signal === "warn") {
            signal = "block";
            message = `Blocked: low trust score (${trustScore}) combined with rule conflict.`;
          } else {
            message = signal !== "allow" ? "Rule conflict detected (semantic + keyword heuristic). Review the rules before proceeding." : "No conflicts detected.";
          }
        }

        // Record guard result for trust scoring
        recordAgentGuard(auth.agent_id, signal);

        // Sign the guard execution
        const exec = auth.agent_id ? signExecution(signingSecret, auth.agent_id, "guard", { action }, { signal, rules_matched: rules.length }) : null;
        if (exec) audit(auth.user_id, "guard", null, null, signal, clientIp, requestId, auth.agent_id, exec.execution_hash, exec.signature);

        return json({
          signal,
          action,
          message,
          trust_score: trustScore,
          rules: rules.slice(0, 5).map(r => ({ id: r.id, content: r.content, importance: r.importance })),
          execution: exec,
        });
      } catch (e: any) {
        return safeError("guard check", e);
      }
    }

    // ========================================================================
    // CONSOLIDATION — v4.1
    // ========================================================================

    if (url.pathname === "/consolidate" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json().catch(() => ({})) as any;
        const memoryId = body.memory_id; // optional: consolidate specific cluster

        if (memoryId) {
          const result = await consolidateCluster(memoryId, auth.user_id);
          if (!result) return json({ consolidated: false, reason: "Cluster too small or already consolidated" });
          return json({ consolidated: true, summary_id: result.summaryId, archived: result.archivedCount });
        } else {
          const total = await runConsolidationSweep(auth.user_id);
          return json({ consolidated: total > 0, archived: total });
        }
      } catch (e: any) {
        return safeError("Consolidation", e);
      }
    }

    if (url.pathname === "/consolidations" && method === "GET") {
      const rows = db.prepare(
        `SELECT c.id, c.summary_memory_id, c.source_memory_ids, c.cluster_label, c.created_at,
          m.content as summary_content
          FROM consolidations c JOIN memories m ON c.summary_memory_id = m.id
          WHERE c.user_id = ?
          ORDER BY c.created_at DESC LIMIT 50`
      ).all(auth.user_id) as any[];
      for (const r of rows) {
        try { r.source_memory_ids = JSON.parse(r.source_memory_ids); } catch {}
      }
      return json({ consolidations: rows });
    }

    // ========================================================================
    // DECAY — v4.1
    // ========================================================================

    if (url.pathname === "/decay/refresh" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const updated = updateDecayScores(auth.user_id);
      return json({ refreshed: updated });
    }

    if (url.pathname === "/decay/scores" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
      const order = url.searchParams.get("order") === "asc" ? "ASC" : "DESC";
      const rows = db.prepare(
        `SELECT id, content, category, importance, decay_score, access_count, last_accessed_at,
           created_at, is_static, source_count, confidence,
           fsrs_stability, fsrs_difficulty, fsrs_storage_strength, fsrs_retrieval_strength,
           fsrs_learning_state, fsrs_reps, fsrs_lapses, fsrs_last_review_at
         FROM memories WHERE user_id = ? AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1
         ORDER BY COALESCE(decay_score, importance) ${order} LIMIT ?`
      ).all(auth.user_id, limit) as any[];
      return json({ memories: rows });
    }

    // FSRS-6 endpoints
    if (url.pathname === "/fsrs/review" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const id = Number(body.id);
        const grade = Number(body.grade || 3) as FSRSRating;
        if (!id || grade < 1 || grade > 4) return errorResponse("id required, grade 1-4", 400);
        const mem = getMemoryWithoutEmbedding.get(id) as any;
        if (!canAccessOwnedRow(mem, auth)) return errorResponse("not found", 404);
        trackAccessWithFSRS(id, grade);
        const updated = getFSRSForUser.get(id, auth.user_id) as any;
        return json({ id, fsrs: updated });
      } catch (e: any) { return errorResponse(e.message, 400); }
    }

    if (url.pathname === "/fsrs/state" && method === "GET") {
      const id = Number(url.searchParams.get("id"));
      if (!id) return errorResponse("id required", 400);
      const row = getFSRSForUser.get(id, auth.user_id) as any;
      if (!row) return errorResponse("not found", 404);
      const elapsed = row.fsrs_last_review_at
        ? (Date.now() - new Date(row.fsrs_last_review_at + "Z").getTime()) / 86400000
        : (Date.now() - new Date(row.created_at + "Z").getTime()) / 86400000;
      const retrievability = row.fsrs_stability
        ? fsrsRetrievability(row.fsrs_stability, elapsed)
        : null;
      const nextReview = row.fsrs_stability
        ? fsrsNextInterval(row.fsrs_stability)
        : null;
      return json({ id, retrievability, next_review_days: nextReview, ...row });
    }

    if (url.pathname === "/fsrs/init" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      // Backfill FSRS state for all memories that don't have it
      const uninitialized = db.prepare(
        `SELECT id, created_at FROM memories WHERE user_id = ? AND fsrs_stability IS NULL AND is_forgotten = 0 AND is_latest = 1`
      ).all(auth.user_id) as any[];
      let count = 0;
      const batch = db.transaction(() => {
        for (const m of uninitialized) {
          const init = fsrsProcessReview(null, FSRSRating.Good, 0);
          updateFSRS.run(init.stability, init.difficulty, init.storage_strength,
            init.retrieval_strength, init.learning_state, init.reps, init.lapses,
            init.last_review_at, m.id);
          count++;
        }
      });
      batch();
      return json({ initialized: count });
    }

    // ========================================================================
    // CONTEXT WINDOW OPTIMIZER — POST /pack
    // ========================================================================

    if (url.pathname === "/pack" && method === "POST") {
      try {
        const body = await req.json() as any;
        const context = body.context || "";
        const tokenBudget = Math.max(100, Math.min(Number(body.tokens) || 4000, 128000));
        const format = body.format || "text"; // text, json, xml

        // Run recall to get candidate memories
        const candidates: Array<{ content: string; category: string; importance: number; decay_score: number; confidence: number; score: number; source: string; id: number }> = [];

        // Static facts first
        const staticFacts = getStaticMemories.all(auth.user_id) as Array<any>;
        for (const sf of staticFacts) {
          candidates.push({ ...sf, score: 100, source: "static", decay_score: sf.importance, confidence: sf.confidence || 1 });
        }

        // Semantic search
        if (context.trim()) {
          const semantic = await hybridSearch(context, 50, false, true, true, auth.user_id);
          for (const sr of semantic) {
            if (!candidates.find(c => c.id === sr.id)) {
              candidates.push({
                id: sr.id, content: sr.content, category: sr.category,
                importance: sr.importance, decay_score: sr.decay_score || sr.importance,
                confidence: 1, score: sr.score * 50, source: "semantic",
              });
            }
          }
        }

        // High importance
        const important = db.prepare(
          `SELECT id, content, category, importance, decay_score, confidence
           FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
           ORDER BY COALESCE(decay_score, importance) DESC LIMIT 30`
        ).all(auth.user_id) as Array<any>;
        for (const m of important) {
          if (!candidates.find(c => c.id === m.id)) {
            candidates.push({ ...m, score: (m.decay_score || m.importance) * 2, source: "important" });
          }
        }

        // Sort by effective score (score * confidence)
        candidates.sort((a, b) => (b.score * (b.confidence || 1)) - (a.score * (a.confidence || 1)));

        // Greedy packing within token budget (~4 chars per token)
        const packed: typeof candidates = [];
        let tokensUsed = 0;
        for (const c of candidates) {
          const memTokens = Math.ceil(c.content.length / 4) + 10; // overhead for formatting
          if (tokensUsed + memTokens > tokenBudget) continue;
          packed.push(c);
          tokensUsed += memTokens;
        }

        // Track access
        for (const p of packed) trackAccessWithFSRS(p.id);

        // Format output
        let output: string;
        if (format === "xml") {
          output = packed.map(p =>
            `<memory id="${p.id}" category="${p.category}" importance="${p.importance}">\n${p.content}\n</memory>`
          ).join("\n");
        } else if (format === "json") {
          output = JSON.stringify(packed.map(p => ({
            id: p.id, content: p.content, category: p.category, importance: p.importance,
          })));
        } else {
          output = packed.map(p => `[${p.category}] ${p.content}`).join("\n\n");
        }

        return json({
          packed: output,
          memories_included: packed.length,
          tokens_estimated: tokensUsed,
          token_budget: tokenBudget,
          utilization: Math.round((tokensUsed / tokenBudget) * 100) + "%",
        });
      } catch (e: any) {
        return safeError("Pack", e);
      }
    }

    // ========================================================================
    // PROMPT TEMPLATE ENGINE — GET /prompt
    // ========================================================================

    if (url.pathname === "/prompt" && method === "GET") {
      try {
        const format = url.searchParams.get("format") || "raw"; // raw, anthropic, openai, llamaindex
        const tokenBudget = Math.max(100, Math.min(Number(url.searchParams.get("tokens") || 4000), 128000));
        const context = url.searchParams.get("context") || "";

        // Use pack logic internally
        const packReq = new Request("http://localhost/pack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context, tokens: tokenBudget, format: "text" }),
        });
        // Run pack inline
        const candidates: Array<any> = [];
        const staticFacts = getStaticMemories.all(auth.user_id) as Array<any>;
        for (const sf of staticFacts) candidates.push({ ...sf, score: 100 });
        if (context.trim()) {
          const semantic = await hybridSearch(context, 30, false, true, true, auth.user_id);
          for (const sr of semantic) {
            if (!candidates.find((c: any) => c.id === sr.id)) candidates.push({ ...sr, score: sr.score * 50 });
          }
        }
        const important = db.prepare(
          `SELECT id, content, category, importance, decay_score, confidence
           FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
           ORDER BY COALESCE(decay_score, importance) DESC LIMIT 1000`
        ).all(auth.user_id) as Array<any>;
        for (const m of important) {
          if (!candidates.find((c: any) => c.id === m.id)) candidates.push({ ...m, score: (m.decay_score || m.importance) * 2 });
        }
        candidates.sort((a: any, b: any) => b.score - a.score);

        const packed: string[] = [];
        let tokensUsed = 0;
        for (const c of candidates) {
          const t = Math.ceil(c.content.length / 4) + 5;
          if (tokensUsed + t > tokenBudget) continue;
          packed.push(`[${c.category}] ${c.content}`);
          tokensUsed += t;
          trackAccessWithFSRS(c.id);
        }

        const memoryBlock = packed.join("\n\n");

        let prompt: string;
        if (format === "anthropic") {
          prompt = `<context>
<engram-memories count="${packed.length}" tokens="~${tokensUsed}">
${memoryBlock}
</engram-memories>
</context>

The above are persistent memories from previous sessions. Use them to maintain continuity. If a memory contradicts the current conversation, prefer the conversation.`;
        } else if (format === "openai") {
          prompt = `# Persistent Memory (Engram)
The following are ${packed.length} memories from previous sessions (~${tokensUsed} tokens):

${memoryBlock}

Use these memories for context. If they conflict with the current conversation, prefer the conversation.`;
        } else if (format === "llamaindex") {
          prompt = `[MEMORY CONTEXT]
${memoryBlock}
[/MEMORY CONTEXT]`;
        } else {
          prompt = memoryBlock;
        }

        return json({
          prompt,
          format,
          memories_included: packed.length,
          tokens_estimated: tokensUsed,
        });
      } catch (e: any) {
        return safeError("Prompt generation", e);
      }
    }

    // ========================================================================
    // HEADER — Universal prompt header for multi-model attribution
    // ========================================================================

    if (url.pathname === "/header" && method === "POST") {
      try {
        const body = await req.json() as any;
        const actorModel = body.actor_model || "unknown";
        const actorRole = body.actor_role || "assistant"; // audit | verify | fix | assistant
        const taskContext = body.context || "";
        const limit = Math.min(Number(body.limit) || 10, 30);

        // Find recent memories from OTHER models to surface prior work
        const recentAll = db.prepare(
          `SELECT id, content, category, source, model, created_at, importance
           FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
           ORDER BY created_at DESC LIMIT ?`
        ).all(auth.user_id, limit * 3) as any[];

        const priorModels = new Set<string>();
        const priorWork: any[] = [];
        for (const m of recentAll) {
          if (m.model && m.model !== actorModel) {
            priorModels.add(m.model);
            if (priorWork.length < limit) {
              priorWork.push({ id: m.id, model: m.model, source: m.source, category: m.category, summary: m.content.slice(0, 200), created_at: m.created_at });
            }
          }
        }

        // Build structured header
        const header: any = {
          actor_model: actorModel,
          actor_role: actorRole,
          prior_models: Array.from(priorModels),
          prior_work_count: priorWork.length,
          prior_work: priorWork,
          attribution_rule: "Memories tagged with a model field were stored by that model, not by you. Do not claim credit for work done by other models. When referencing prior work, attribute it to the model that performed it.",
        };

        // If context provided, find relevant attributed memories
        if (taskContext.trim()) {
          const relevant = await hybridSearch(taskContext, 10, false, true, false, auth.user_id);
          header.relevant_attributed = relevant.map(r => ({
            id: r.id, model: r.model || null, source: r.source, category: r.category,
            summary: r.content.slice(0, 200), score: Math.round((r.score || 0) * 1000) / 1000,
          }));
        }

        // Generate the text header for injection into system prompts
        const lines = [
          `# Engram Task Header`,
          `actor_model: ${actorModel}`,
          `actor_role: ${actorRole}`,
          `prior_models: [${Array.from(priorModels).join(", ")}]`,
          ``,
          `## Attribution Rule`,
          `You are ${actorModel}. Memories in Engram tagged with a different model were NOT created by you.`,
          `When you see "(by X via Y)" on a memory, model X stored it via client Y.`,
          `Do not take credit for prior work. Attribute it correctly when referencing it.`,
        ];

        if (priorWork.length > 0) {
          lines.push(``, `## Recent Work by Other Models`);
          for (const pw of priorWork.slice(0, 5)) {
            lines.push(`- [${pw.model}] ${pw.summary}${pw.summary.length >= 200 ? "..." : ""}`);
          }
        }

        return json({
          header: header,
          text: lines.join("\n"),
          actor_model: actorModel,
          prior_models: Array.from(priorModels),
        });
      } catch (e: any) {
        return safeError("Header generation", e);
      }
    }

    // ========================================================================
    // WEBHOOKS — v4.2
    // ========================================================================

    if (url.pathname === "/webhooks" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        if (!body.url) return errorResponse("url is required");
        const webhookError = validatePublicWebhookUrl(body.url, "Webhook URL");
        if (webhookError) return errorResponse(webhookError, 400);
        const events = body.events || ["*"];
        const secret = body.secret || null;
        const result = insertWebhook.get(body.url, JSON.stringify(events), secret, auth.user_id) as { id: number; created_at: string };
        return json({ created: true, id: result.id, url: body.url, events });
      } catch (e: any) {
        return safeError("create webhook", e);
      }
    }

    if (url.pathname === "/webhooks" && method === "GET") {
      const hooks = listWebhooks.all(auth.user_id) as any[];
      for (const h of hooks) {
        try { h.events = JSON.parse(h.events); } catch {}
      }
      return json({ webhooks: hooks });
    }

    if (url.pathname.match(/^\/webhooks\/\d+$/) && method === "DELETE") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const id = Number(url.pathname.split("/")[2]);
      deleteWebhook.run(id, auth.user_id);
      return json({ deleted: true, id });
    }

    // ========================================================================
    // SYNC — v4.2 (Multi-instance replication)
    // ========================================================================

    if (url.pathname === "/sync/changes" && method === "GET") {
      const since = url.searchParams.get("since") || "1970-01-01T00:00:00";
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 1000);
      const changes = getChangesSince.all(since, auth.user_id, limit) as any[];
      for (const c of changes) {
        try { c.tags = c.tags ? JSON.parse(c.tags) : []; } catch { c.tags = []; }
      }
      return json({
        changes,
        count: changes.length,
        since,
        server_time: new Date().toISOString(),
      });
    }

    if (url.pathname === "/sync/receive" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const memories = body.memories;
        if (!Array.isArray(memories)) return errorResponse("memories array required");

        let created = 0, updated = 0, skipped = 0;
        for (const mem of memories) {
          if (!mem.sync_id || !mem.content) { skipped++; continue; }

          const existing = getMemoryBySyncId.get(mem.sync_id, auth.user_id) as any;
          if (existing) {
            // Conflict resolution: last-write-wins
            if (mem.updated_at > existing.updated_at) {
              db.prepare(
                `UPDATE memories SET content = ?, category = ?, importance = ?, tags = ?,
                 confidence = ?, is_static = ?, is_forgotten = ?, is_archived = ?,
                 model = COALESCE(?, model), updated_at = ? WHERE id = ?`
              ).run(
                mem.content, mem.category || "general", mem.importance || 5,
                mem.tags ? JSON.stringify(mem.tags) : null,
                mem.confidence ?? 1.0, mem.is_static ? 1 : 0,
                mem.is_forgotten ? 1 : 0, mem.is_archived ? 1 : 0,
                mem.model || null, mem.updated_at, existing.id
              );
              // Re-embed on content change
              try {
                const emb = await embed(mem.content);
                updateMemoryEmbedding.run(embeddingToBuffer(emb), existing.id); try { updateMemoryVec.run(embeddingToVectorJSON(emb), existing.id); } catch {}
              } catch {}
              updated++;
            } else {
              skipped++;
            }
          } else {
            // New memory from remote
            let embBuffer: Buffer | null = null;
            let embArray: Float32Array | null = null;
            try {
              embArray = await embed(mem.content);
              embBuffer = embeddingToBuffer(embArray);
            } catch {}
            const result = insertMemory.get(
              mem.content, mem.category || "general", mem.source || "sync", mem.session_id || null,
              mem.importance || 5, embBuffer, mem.version || 1, 1, null, null, 1,
              mem.is_static ? 1 : 0, mem.is_forgotten ? 1 : 0, null, null, 0,
              mem.model || null, auth.user_id, auth.space_id || null
            ) as { id: number; created_at: string };
            db.prepare(
              "UPDATE memories SET sync_id = ?, tags = ?, confidence = ?, is_archived = ?, model = COALESCE(?, model) WHERE id = ?"
            ).run(
              mem.sync_id, mem.tags ? JSON.stringify(mem.tags) : null,
              mem.confidence ?? 1.0, mem.is_archived ? 1 : 0, mem.model || null, result.id
            );
            if (embArray) {
              writeVec(result.id, embArray);
              await autoLink(result.id, embArray, auth.user_id);
            }
            created++;
          }
        }

        return json({ synced: true, created, updated, skipped });
      } catch (e: any) {
        return safeError("Sync receive", e);
      }
    }

    // ========================================================================
    // DERIVE — Infer new facts from memory clusters
    // ========================================================================

    if (url.pathname === "/derive" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      if (!isLLMAvailable()) return errorResponse("LLM not configured — /derive requires inference", 400);
      try {
        const body = await req.json() as any;
        const context = body.context || "";
        const limit = Math.min(Number(body.limit || 30), 100);
        const minCluster = Number(body.min_cluster || 3);

        // Gather candidate memories to derive from
        let candidates: any[];
        if (context.trim()) {
          candidates = await hybridSearch(context, limit, false, true, true, auth.user_id);
        } else {
          candidates = db.prepare(
            `SELECT id, content, category, importance, tags, created_at
             FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
             ORDER BY COALESCE(decay_score, importance) DESC LIMIT ?`
          ).all(auth.user_id, limit) as any[];
        }

        if (candidates.length < minCluster) {
          return json({ derived: 0, message: `Need at least ${minCluster} memories, found ${candidates.length}` });
        }

        // Format memories for LLM inference
        const memoryList = candidates.map((c, i) =>
          `[${c.id}] (${c.category}) ${c.content}`
        ).join("\n");

        const derivePrompt = `You are an inference engine for a memory system. Given a collection of memories, identify patterns, connections, and inferences that are NOT explicitly stated but can be logically derived.

Rules:
- Only derive facts that are NOT already stored — don't repeat existing memories
- Each derived fact must cite which memory IDs it was inferred from (source_ids)
- Confidence should reflect how certain the inference is (0.3-0.9, never 1.0)
- Prefer actionable insights over trivial observations
- Maximum 5 derived facts per batch

Return JSON:
{
  "derived": [
    {
      "content": "inferred fact",
      "category": "discovery",
      "importance": 6,
      "confidence": 0.7,
      "source_ids": [123, 456],
      "reasoning": "brief explanation of the inference"
    }
  ]
}

If no meaningful inferences, return {"derived": []}`;

        const resp = await callLLM(derivePrompt, `Here are the memories:\n\n${memoryList}`);
        if (!resp) return json({ derived: 0, facts: [] });

        let parsed: { derived: Array<any> };
        try {
          const cleaned = resp.replace(/```json\n?|\n?```/g, "").trim();
          try {
            parsed = JSON.parse(cleaned);
          } catch {
            const jsonMatch = cleaned.match(/\{[\s\S]*"derived"[\s\S]*\}/);
            if (jsonMatch) {
              parsed = JSON.parse(jsonMatch[0]);
            } else {
              log.error({ msg: "derive_parse_error", response: cleaned.substring(0, 500) });
              return json({ derived: 0, facts: [], error: "LLM returned unparseable response" });
            }
          }
        } catch {
          return json({ derived: 0, facts: [], error: "LLM returned unparseable response" });
        }

        if (!parsed.derived?.length) return json({ derived: 0, facts: [] });

        const stored: Array<{ id: number; content: string; confidence: number; source_ids: number[] }> = [];
        for (const d of parsed.derived) {
          if (!d.content?.trim()) continue;

          let embBuffer: Buffer | null = null;
          let embArray: Float32Array | null = null;
          try {
            embArray = await embed(d.content.trim());
            embBuffer = embeddingToBuffer(embArray);
          } catch {}

          const result = insertMemory.get(
            d.content.trim(), d.category || "discovery", "derived", null,
            d.importance || 5, embBuffer, 1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
          ) as { id: number; created_at: string };

          const syncId = randomUUID();
          db.prepare(
            "UPDATE memories SET sync_id = ?, confidence = ?, tags = ? WHERE id = ?"
          ).run(syncId, d.confidence || 0.7, JSON.stringify(["derived", ...(d.tags || [])]), result.id);

          // Link to source memories
          if (d.source_ids && Array.isArray(d.source_ids)) {
            for (const srcId of d.source_ids) {
              try { insertLink.run(result.id, srcId, d.confidence || 0.7, "derived_from"); } catch {}
            }
          }

          if (embArray) { writeVec(result.id, embArray); await autoLink(result.id, embArray, auth.user_id); }

          emitWebhookEvent("memory.derived", {
            id: result.id, content: d.content.trim(), confidence: d.confidence,
            source_ids: d.source_ids, reasoning: d.reasoning,
          }, auth.user_id);

          stored.push({ id: result.id, content: d.content.trim(), confidence: d.confidence || 0.7, source_ids: d.source_ids || [] });
        }

        return json({ derived: stored.length, facts: stored });
      } catch (e: any) {
        return safeError("Derive", e);
      }
    }

    // ========================================================================
    // MEM0 IMPORT — v4.2
    // ========================================================================

    if (url.pathname === "/import/mem0" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const memories = body.memories || body.results || body;
        if (!Array.isArray(memories)) return errorResponse("Expected array of mem0 memories");

        let imported = 0;
        for (const mem of memories) {
          // Mem0 format: { id, memory/text/content, metadata?, created_at?, updated_at?, user_id? }
          const content = mem.memory || mem.text || mem.content;
          if (!content) continue;

          const category = mem.metadata?.category || mem.category || "general";
          const source = mem.metadata?.source || mem.source || "mem0-import";
          const importance = mem.metadata?.importance || 5;
          const tags = mem.metadata?.tags || ["mem0-import"];

          let embBuffer: Buffer | null = null;
          let embArray: Float32Array | null = null;
          try {
            embArray = await embed(content.trim());
            embBuffer = embeddingToBuffer(embArray);
          } catch {}

          const result = insertMemory.get(
            content.trim(), category, source, null, importance, embBuffer,
            1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
          ) as { id: number; created_at: string };

          db.prepare(
            "UPDATE memories SET tags = ?, sync_id = ?, confidence = 1.0 WHERE id = ?"
          ).run(JSON.stringify(tags), randomUUID(), result.id);

          if (embArray) { writeVec(result.id, embArray); await autoLink(result.id, embArray, auth.user_id); }
          imported++;
        }

        return json({ imported, source: "mem0" });
      } catch (e: any) {
        return safeError("Mem0 import", e);
      }
    }

    // ========================================================================
    // SUPERMEMORY IMPORT — v4.2
    // ========================================================================

    if (url.pathname === "/import/supermemory" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        // Supermemory formats:
        //   v1 API: { documents: [{ content, spaces?, type?, createdAt?, metadata? }] }
        //   Export: { memories: [{ content/text, space?, tags?, ...}] }
        //   Raw array: [{ content, ... }]
        const items = body.documents || body.memories || body.data || (Array.isArray(body) ? body : null);
        if (!items || !Array.isArray(items)) {
          return errorResponse("Expected documents/memories array. Accepted shapes: { documents: [...] }, { memories: [...] }, or raw array");
        }

        let imported = 0, skipped = 0;
        for (const item of items) {
          const content = item.content || item.text || item.description || item.raw;
          if (!content?.trim()) { skipped++; continue; }

          // Map supermemory type → engram category
          const typeMap: Record<string, string> = {
            note: "general", tweet: "discovery", page: "discovery",
            document: "task", bookmark: "discovery", conversation: "state",
          };
          const category = item.category
            || typeMap[item.type?.toLowerCase()]
            || (item.space?.toLowerCase() === "work" ? "task" : null)
            || "general";

          // Supermemory spaces → tags
          const tags: string[] = ["supermemory-import"];
          if (item.spaces && Array.isArray(item.spaces)) {
            for (const s of item.spaces) tags.push(String(s).toLowerCase());
          } else if (item.space) {
            tags.push(String(item.space).toLowerCase());
          }
          if (item.tags && Array.isArray(item.tags)) {
            for (const t of item.tags) tags.push(String(t).toLowerCase());
          }
          if (item.type) tags.push(item.type.toLowerCase());

          const importance = item.importance || item.metadata?.importance || 5;
          const source = item.source || item.metadata?.source || "supermemory-import";

          let embBuffer: Buffer | null = null;
          let embArray: Float32Array | null = null;
          try {
            embArray = await embed(content.trim());
            embBuffer = embeddingToBuffer(embArray);
          } catch {}

          const result = insertMemory.get(
            content.trim(), category, source, null, importance, embBuffer,
            1, 1, null, null, 1, 0, 0, null, null, 0, null, auth.user_id, auth.space_id || null
          ) as { id: number; created_at: string };

          db.prepare(
            "UPDATE memories SET tags = ?, sync_id = ?, confidence = 1.0 WHERE id = ?"
          ).run(JSON.stringify([...new Set(tags)]), randomUUID(), result.id);

          if (embArray) { writeVec(result.id, embArray); await autoLink(result.id, embArray, auth.user_id); }
          imported++;
        }

        return json({ imported, skipped, source: "supermemory" });
      } catch (e: any) {
        return safeError("Supermemory import", e);
      }
    }

    // ========================================================================
    // MEMORY GRAPH — v4.3
    // ========================================================================

    if (url.pathname === "/graph" && method === "GET") {
      try {
        const center = url.searchParams.get("center");
        const depth = Math.min(Number(url.searchParams.get("depth") || 2), 4);
        const maxNodes = Math.min(Number(url.searchParams.get("max") || 1000), 2000);
        const includeEntities = url.searchParams.get("entities") !== "0";
        const context = url.searchParams.get("q");

        // 30s response cache
        const cacheKey = `graph:${auth.user_id}:${center||""}:${depth}:${maxNodes}:${includeEntities?1:0}:${context||""}`;
        if (graphCache && graphCache.key === cacheKey && Date.now() - graphCache.ts < 30_000) {
          return json(graphCache.data);
        }

        type GNode = { id: string; label: string; type: string; [k: string]: any };
        type GEdge = { source: string; target: string; type: string; weight: number };
        const nodes: Map<string, GNode> = new Map();
        const edges: GEdge[] = [];

        // Phase 1: Collect memory IDs (no per-row fetches)
        let memoryIds: number[];
        if (center) {
          // BFS from center using batch link queries per depth level
          const visited = new Set<number>([Number(center)]);
          let frontier = [Number(center)];
          for (let d = 0; d < depth && frontier.length > 0 && visited.size < maxNodes; d++) {
            const ph = frontier.map(() => "?").join(",");
            const linked = db.prepare(
              `SELECT DISTINCT CASE WHEN source_id IN (${ph}) THEN target_id ELSE source_id END as linked_id
               FROM memory_links ml
               JOIN memories ms ON ms.id = ml.source_id
               JOIN memories mt ON mt.id = ml.target_id
               WHERE (source_id IN (${ph}) OR target_id IN (${ph}))
                 AND ms.user_id = ? AND mt.user_id = ?`
            ).all(...frontier, ...frontier, ...frontier, auth.user_id, auth.user_id) as any[];
            frontier = [];
            for (const r of linked) {
              if (!visited.has(r.linked_id) && visited.size < maxNodes) {
                visited.add(r.linked_id);
                frontier.push(r.linked_id);
              }
            }
          }
          memoryIds = [...visited];
        } else if (context) {
          const results = await hybridSearch(context, maxNodes, false, true, true, auth.user_id);
          memoryIds = results.map((r: any) => r.id);
        } else {
          const rows = db.prepare(
            `SELECT id FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
             ORDER BY COALESCE(decay_score, importance) DESC LIMIT ?`
          ).all(auth.user_id, maxNodes) as any[];
          memoryIds = rows.map((r: any) => r.id);
        }

        if (memoryIds.length === 0) {
          const empty = { nodes: [], edges: [], links: [], node_count: 0, edge_count: 0 };
          setGraphCache({ key: cacheKey, data: empty, ts: Date.now() });
          return json(empty);
        }

        // Phase 2: Batch fetch all memories (single query, chunked for safety)
        const CHUNK = 900;
        const allMems: any[] = [];
        for (let i = 0; i < memoryIds.length; i += CHUNK) {
          const chunk = memoryIds.slice(i, i + CHUNK);
          const ph = chunk.map(() => "?").join(",");
          const rows = db.prepare(
            `SELECT id, content, category, source, importance, confidence, created_at,
                    is_static, is_forgotten, is_archived, parent_memory_id, source_count,
                    version, forget_after
             FROM memories WHERE id IN (${ph}) AND user_id = ? AND is_forgotten = 0`
          ).all(...chunk, auth.user_id) as any[];
          allMems.push(...rows);
        }

        for (const mem of allMems) {
          nodes.set(`m${mem.id}`, {
            id: `m${mem.id}`,
            label: mem.content.substring(0, 60) + (mem.content.length > 60 ? "\u2026" : ""),
            type: "memory", category: mem.category, importance: mem.importance,
            confidence: mem.confidence, group: mem.category,
            size: Math.max(3, (mem.importance || 5) * 1.5),
            source: mem.source, created_at: mem.created_at, is_static: mem.is_static,
            is_forgotten: mem.is_forgotten, is_archived: mem.is_archived,
            parent_memory_id: mem.parent_memory_id, source_count: mem.source_count,
            content: mem.content, version: mem.version,
            forget_after: mem.forget_after,
          });
        }

        // Phase 3: Batch fetch all links between graph nodes (single query per chunk)
        const validIds = allMems.map((m: any) => m.id);
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          const ph = chunk.map(() => "?").join(",");
          // For links, both source and target must be in the full set
          // Use subquery for the full set if chunked
          const linkRows = db.prepare(
            `SELECT ml.source_id, ml.target_id, ml.similarity, ml.type FROM memory_links ml
             JOIN memories ms ON ms.id = ml.source_id
             JOIN memories mt ON mt.id = ml.target_id
             WHERE (ml.source_id IN (${ph}) OR ml.target_id IN (${ph}))
               AND ms.user_id = ? AND mt.user_id = ?`
          ).all(...chunk, ...chunk, auth.user_id, auth.user_id) as any[];
          const validSet = new Set(validIds);
          for (const link of linkRows) {
            if (validSet.has(link.source_id) && validSet.has(link.target_id)) {
              edges.push({
                source: `m${link.source_id}`, target: `m${link.target_id}`,
                type: link.type || "related", weight: link.similarity,
              });
            }
          }
        }

        // Phase 4: Entities (batch)
        if (includeEntities && validIds.length > 0) {
          for (let i = 0; i < validIds.length; i += CHUNK) {
            const chunk = validIds.slice(i, i + CHUNK);
            const ph = chunk.map(() => "?").join(",");
            const meRows = db.prepare(
              `SELECT me.memory_id, e.id, e.name, e.type FROM entities e
               JOIN memory_entities me ON me.entity_id = e.id WHERE me.memory_id IN (${ph}) AND e.user_id = ?`
            ).all(...chunk, auth.user_id) as any[];
            for (const ent of meRows) {
              const entNodeId = `e${ent.id}`;
              if (!nodes.has(entNodeId)) {
                nodes.set(entNodeId, { id: entNodeId, label: ent.name, type: "entity", group: ent.type, size: 8 });
              }
              edges.push({ source: `m${ent.memory_id}`, target: entNodeId, type: "about", weight: 1.0 });
            }
          }
          const entityIds = [...nodes.entries()].filter(([k]) => k.startsWith("e")).map(([k]) => Number(k.slice(1)));
          if (entityIds.length > 0) {
            const eph = entityIds.map(() => "?").join(",");
            const rels = db.prepare(
              `SELECT er.source_entity_id, er.target_entity_id, er.relationship FROM entity_relationships er
               JOIN entities es ON es.id = er.source_entity_id
               JOIN entities et ON et.id = er.target_entity_id
               WHERE (er.source_entity_id IN (${eph}) OR er.target_entity_id IN (${eph}))
                 AND es.user_id = ? AND et.user_id = ?`
            ).all(...entityIds, ...entityIds, auth.user_id, auth.user_id) as any[];
            for (const r of rels) {
              edges.push({ source: `e${r.source_entity_id}`, target: `e${r.target_entity_id}`, type: r.relationship, weight: 0.9 });
            }
          }
        }

        // Phase 5: Projects (already efficient — few projects)
        const projectNodes = db.prepare(
          `SELECT DISTINCT p.id, p.name, p.status FROM projects p
           JOIN memory_projects mp ON mp.project_id = p.id
           JOIN memories m ON m.id = mp.memory_id
           WHERE p.user_id = ? AND m.is_forgotten = 0`
        ).all(auth.user_id) as any[];
        for (const proj of projectNodes) {
          const projNodeId = `p${proj.id}`;
          nodes.set(projNodeId, { id: projNodeId, label: proj.name, type: "project", group: "project", size: 10 });
           const projMems = db.prepare(
             `SELECT mp.memory_id FROM memory_projects mp
              JOIN memories m ON m.id = mp.memory_id
              WHERE mp.project_id = ? AND m.user_id = ?`
           ).all(proj.id, auth.user_id) as any[];
          for (const pm of projMems) {
            if (nodes.has(`m${(pm as any).memory_id}`)) {
              edges.push({ source: projNodeId, target: `m${(pm as any).memory_id}`, type: "contains", weight: 0.8 });
            }
          }
        }

        const result = { nodes: [...nodes.values()], edges, links: edges.slice(), node_count: nodes.size, edge_count: edges.length };
        setGraphCache({ key: cacheKey, data: result, ts: Date.now() });
        log.info({ msg: "graph_served", nodes: nodes.size, edges: edges.length, cached: false, rid: requestId });
        return json(result);
      } catch (e: any) {
        return safeError("Graph", e);
      }
    }

        // Graph visualization page
    if (url.pathname === "/graph/view" && method === "GET") {
      const graphHtml = await readFile(resolve(DATA_DIR, "..", "engram-graph.html"), "utf-8").catch(() => null);
      if (!graphHtml) return errorResponse("Graph view not found. Place engram-graph.html in the project root", 404);
      return new Response(graphHtml, { headers: { "Content-Type": "text/html" } });
    }

    // ========================================================================
    // ENTITIES — v4.3
    // ========================================================================

    // Create entity
    if (url.pathname === "/entities" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        if (!body.name?.trim()) return errorResponse("name is required");
        const validTypes = ["person", "organization", "team", "device", "product", "service", "generic"];
        const type = validTypes.includes(body.type) ? body.type : "generic";
        const result = insertEntity.get(
          body.name.trim(), type, body.description || null,
          body.aka || null, body.metadata ? JSON.stringify(body.metadata) : null,
          auth.user_id
        ) as { id: number; created_at: string };
        return json({ created: true, id: result.id, name: body.name.trim(), type, created_at: result.created_at });
      } catch (e: any) {
        return safeError("create entity", e);
      }
    }

    // List entities
    if (url.pathname === "/entities" && method === "GET") {
      const type = url.searchParams.get("type");
      const q = url.searchParams.get("q");
      let entities: any[];
      if (q) {
        const like = `%${q}%`;
        entities = searchEntities.all(auth.user_id, like, like, like, 100) as any[];
      } else if (type) {
        entities = listEntitiesByType.all(auth.user_id, type) as any[];
      } else {
        entities = listEntities.all(auth.user_id) as any[];
      }
      for (const e of entities) {
        try { if (e.metadata) e.metadata = JSON.parse(e.metadata); } catch {}
      }
      return json({ entities, count: entities.length });
    }

    // Get single entity with details
    if (url.pathname.match(/^\/entities\/\d+$/) && method === "GET") {
      const id = Number(url.pathname.split("/")[2]);
      const entity = getEntityForUser.get(id, auth.user_id) as any;
      if (!entity) return errorResponse("Entity not found", 404);
      try { if (entity.metadata) entity.metadata = JSON.parse(entity.metadata); } catch {}
      entity.memory_ids = entity.memory_ids ? entity.memory_ids.split(",").map(Number) : [];
      entity.relationships = (getEntityRelationships.all(id, id, id, id, id) as any[])
        .filter((rel) => !!getEntityForUser.get(rel.related_entity_id, auth.user_id));
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
      entity.memories = getEntityMemories.all(id, auth.user_id, limit) as any[];
      for (const m of entity.memories) {
        try { if (m.tags) m.tags = JSON.parse(m.tags); } catch { m.tags = []; }
      }
      return json(entity);
    }

    // Update entity
    if (url.pathname.match(/^\/entities\/\d+$/) && method === "PUT") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const id = Number(url.pathname.split("/")[2]);
        const body = await req.json() as any;
        updateEntity.run(
          body.name || null, body.type || null, body.description || null,
          body.aka || null, body.metadata ? JSON.stringify(body.metadata) : null,
          id, auth.user_id
        );
        return json({ updated: true, id });
      } catch (e: any) {
        return safeError("Update", e);
      }
    }

    // Delete entity
    if (url.pathname.match(/^\/entities\/\d+$/) && method === "DELETE") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const id = Number(url.pathname.split("/")[2]);
      deleteEntity.run(id, auth.user_id);
      return json({ deleted: true, id });
    }

    // Link memory ↔ entity
    if (url.pathname.match(/^\/entities\/\d+\/memories\/\d+$/) && method === "PUT") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const parts = url.pathname.split("/");
      const entityId = Number(parts[2]);
      const memoryId = Number(parts[4]);
      if (!getEntityForUser.get(entityId, auth.user_id)) return errorResponse("Entity not found", 404);
      const mem = getMemoryWithoutEmbedding.get(memoryId) as any;
      if (!canAccessOwnedRow(mem, auth)) return errorResponse("Memory not found", 404);
      linkMemoryEntity.run(memoryId, entityId);
      return json({ linked: true, entity_id: entityId, memory_id: memoryId });
    }

    // Unlink memory ↔ entity
    if (url.pathname.match(/^\/entities\/\d+\/memories\/\d+$/) && method === "DELETE") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const parts = url.pathname.split("/");
      const entityId = Number(parts[2]);
      const memoryId = Number(parts[4]);
      if (!getEntityForUser.get(entityId, auth.user_id)) return errorResponse("Entity not found", 404);
      const mem = getMemoryWithoutEmbedding.get(memoryId) as any;
      if (!canAccessOwnedRow(mem, auth)) return errorResponse("Memory not found", 404);
      unlinkMemoryEntity.run(memoryId, entityId);
      return json({ unlinked: true, entity_id: entityId, memory_id: memoryId });
    }

    // Entity relationships
    if (url.pathname.match(/^\/entities\/\d+\/relationships$/) && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const entityId = Number(url.pathname.split("/")[2]);
        const body = await req.json() as any;
        if (!body.target_id || !body.relationship) return errorResponse("target_id and relationship required");
        if (!getEntityForUser.get(entityId, auth.user_id) || !getEntityForUser.get(Number(body.target_id), auth.user_id)) {
          return errorResponse("Entity not found", 404);
        }
        insertEntityRelationship.run(entityId, body.target_id, body.relationship);
        return json({ linked: true, source: entityId, target: body.target_id, relationship: body.relationship });
      } catch (e: any) {
        return safeError("Relationship", e);
      }
    }

    if (url.pathname.match(/^\/entities\/\d+\/relationships$/) && method === "DELETE") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const entityId = Number(url.pathname.split("/")[2]);
        const body = await req.json() as any;
        if (!body.target_id || !body.relationship) return errorResponse("target_id and relationship required");
        if (!getEntityForUser.get(entityId, auth.user_id) || !getEntityForUser.get(Number(body.target_id), auth.user_id)) {
          return errorResponse("Entity not found", 404);
        }
        deleteEntityRelationship.run(entityId, body.target_id, body.relationship);
        return json({ unlinked: true, source: entityId, target: body.target_id, relationship: body.relationship });
      } catch (e: any) {
        return safeError("Unlink", e);
      }
    }

    // ========================================================================
    // PROJECTS — v4.3
    // ========================================================================

    // Create project
    if (url.pathname === "/projects" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        if (!body.name?.trim()) return errorResponse("name is required");
        const validStatuses = ["active", "paused", "completed", "archived"];
        const status = validStatuses.includes(body.status) ? body.status : "active";
        const result = insertProject.get(
          body.name.trim(), body.description || null, status,
          body.metadata ? JSON.stringify(body.metadata) : null, auth.user_id
        ) as { id: number; created_at: string };
        return json({ created: true, id: result.id, name: body.name.trim(), status, created_at: result.created_at });
      } catch (e: any) {
        return safeError("create project", e);
      }
    }

    // List projects
    if (url.pathname === "/projects" && method === "GET") {
      const status = url.searchParams.get("status");
      const projects = status
        ? listProjectsByStatus.all(auth.user_id, status) as any[]
        : listProjects.all(auth.user_id) as any[];
      for (const p of projects) {
        try { if (p.metadata) p.metadata = JSON.parse(p.metadata); } catch {}
      }
      return json({ projects, count: projects.length });
    }

    // Get single project
    if (url.pathname.match(/^\/projects\/\d+$/) && method === "GET") {
      const id = Number(url.pathname.split("/")[2]);
      const project = getProjectForUser.get(id, auth.user_id) as any;
      if (!project) return errorResponse("Project not found", 404);
      try { if (project.metadata) project.metadata = JSON.parse(project.metadata); } catch {}
      project.memory_ids = project.memory_ids ? project.memory_ids.split(",").map(Number) : [];
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      project.memories = getProjectMemories.all(id, auth.user_id, limit) as any[];
      for (const m of project.memories) {
        try { if (m.tags) m.tags = JSON.parse(m.tags); } catch { m.tags = []; }
      }
      return json(project);
    }

    // Update project
    if (url.pathname.match(/^\/projects\/\d+$/) && method === "PUT") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const id = Number(url.pathname.split("/")[2]);
        const body = await req.json() as any;
        updateProject.run(
          body.name || null, body.description || null,
          body.status || null, body.metadata ? JSON.stringify(body.metadata) : null,
          id, auth.user_id
        );
        return json({ updated: true, id });
      } catch (e: any) {
        return safeError("Update", e);
      }
    }

    // Delete project
    if (url.pathname.match(/^\/projects\/\d+$/) && method === "DELETE") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const id = Number(url.pathname.split("/")[2]);
      deleteProject.run(id, auth.user_id);
      return json({ deleted: true, id });
    }

    // Link memory ↔ project
    if (url.pathname.match(/^\/projects\/\d+\/memories\/\d+$/) && method === "PUT") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const parts = url.pathname.split("/");
      const projectId = Number(parts[2]);
      const memoryId = Number(parts[4]);
      if (!getProjectForUser.get(projectId, auth.user_id)) return errorResponse("Project not found", 404);
      const mem = getMemoryWithoutEmbedding.get(memoryId) as any;
      if (!canAccessOwnedRow(mem, auth)) return errorResponse("Memory not found", 404);
      linkMemoryProject.run(memoryId, projectId);
      return json({ linked: true, project_id: projectId, memory_id: memoryId });
    }

    // Unlink memory ↔ project
    if (url.pathname.match(/^\/projects\/\d+\/memories\/\d+$/) && method === "DELETE") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const parts = url.pathname.split("/");
      const projectId = Number(parts[2]);
      const memoryId = Number(parts[4]);
      if (!getProjectForUser.get(projectId, auth.user_id)) return errorResponse("Project not found", 404);
      const mem = getMemoryWithoutEmbedding.get(memoryId) as any;
      if (!canAccessOwnedRow(mem, auth)) return errorResponse("Memory not found", 404);
      unlinkMemoryProject.run(memoryId, projectId);
      return json({ unlinked: true, project_id: projectId, memory_id: memoryId });
    }

    // Scoped search — search memories within a project
    if (url.pathname.match(/^\/projects\/\d+\/search$/) && method === "POST") {
      try {
        const projectId = Number(url.pathname.split("/")[2]);
        if (!getProjectForUser.get(projectId, auth.user_id)) return errorResponse("Project not found", 404);
        const body = await req.json() as any;
        const query = body.query;
        if (!query) return errorResponse("query is required");
        const limit = Math.min(Number(body.limit || 20), 100);

        // Get all memory IDs in this project
        const projectMemIds = (db.prepare(
          `SELECT mp.memory_id FROM memory_projects mp
           JOIN memories m ON m.id = mp.memory_id
           WHERE mp.project_id = ? AND m.user_id = ?`
        ).all(projectId, auth.user_id) as any[]).map(r => r.memory_id);

        if (projectMemIds.length === 0) return json({ results: [], count: 0, project_id: projectId });

        // Run normal search then filter to project scope
        const allResults = await hybridSearch(query, limit * 3, false, true, true, auth.user_id);
        const scoped = allResults.filter(r => projectMemIds.includes(r.id)).slice(0, limit);
        for (const r of scoped) trackAccessWithFSRS(r.id);
        return json({ results: scoped, count: scoped.length, project_id: projectId });
      } catch (e: any) {
        return safeError("Project search", e);
      }
    }

    // Entity-scoped search
    if (url.pathname.match(/^\/entities\/\d+\/search$/) && method === "POST") {
      try {
        const entityId = Number(url.pathname.split("/")[2]);
        if (!getEntityForUser.get(entityId, auth.user_id)) return errorResponse("Entity not found", 404);
        const body = await req.json() as any;
        const query = body.query;
        if (!query) return errorResponse("query is required");
        const limit = Math.min(Number(body.limit || 20), 100);

        const entityMemIds = (db.prepare(
          `SELECT me.memory_id FROM memory_entities me
           JOIN memories m ON m.id = me.memory_id
           WHERE me.entity_id = ? AND m.user_id = ?`
        ).all(entityId, auth.user_id) as any[]).map(r => r.memory_id);

        if (entityMemIds.length === 0) return json({ results: [], count: 0, entity_id: entityId });

        const allResults = await hybridSearch(query, limit * 3, false, true, true, auth.user_id);
        const scoped = allResults.filter(r => entityMemIds.includes(r.id)).slice(0, limit);
        for (const r of scoped) trackAccessWithFSRS(r.id);
        return json({ results: scoped, count: scoped.length, entity_id: entityId });
      } catch (e: any) {
        return safeError("Entity search", e);
      }
    }

    // ========================================================================
    // STATS — v4
    // ========================================================================

    // ========================================================================
    // STRUCTURED FACTS — query extracted quantifiable facts
    // ========================================================================
    if (url.pathname === "/facts" && method === "GET") {
      try {
        const subject = url.searchParams.get("subject");
        const verb = url.searchParams.get("verb");
        const includeInvalid = url.searchParams.get("include_invalid") === "true";
        const validAt = url.searchParams.get("valid_at"); // filter: facts valid at this date
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);

        let query = "SELECT * FROM structured_facts WHERE user_id = ?";
        const params: any[] = [auth.user_id];
        if (subject) { query += " AND subject LIKE ?"; params.push(`%${subject}%`); }
        if (verb) { query += " AND verb = ?"; params.push(verb); }
        if (!includeInvalid) { query += " AND invalid_at IS NULL"; }
        if (validAt) {
          // Facts that were valid at the given point in time
          query += " AND (valid_at IS NULL OR valid_at <= ?) AND (invalid_at IS NULL OR invalid_at > ?)";
          params.push(validAt, validAt);
        }
        query += " ORDER BY valid_at DESC NULLS LAST, created_at DESC LIMIT ?";
        params.push(limit);

        const facts = db.prepare(query).all(...params);
        return json({ facts, count: (facts as any[]).length });
      } catch (e: any) {
        return safeError("Facts query", e);
      }
    }

    // ========================================================================
    // ENTITY COOCCURRENCES — query entity co-mention graph
    // ========================================================================
    if (url.pathname.match(/^\/entities\/(\d+)\/cooccurrences$/) && method === "GET") {
      try {
        const entityId = parseInt(url.pathname.split("/")[2]);
        const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 50);
        const { getCooccurringEntities } = await import("../graph/cooccurrence.ts");
        const cooccurrences = getCooccurringEntities(entityId, auth.user_id, limit);
        return json({ entity_id: entityId, cooccurrences, count: cooccurrences.length });
      } catch (e: any) {
        return safeError("Entity cooccurrences", e);
      }
    }

    // ========================================================================
    // RE-EMBED ALL MEMORIES -- migrate between embedding providers/models
    // ========================================================================
    if (url.pathname === "/admin/reembed" && method === "POST") {
      if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
      try {
        const { reembedAll, getEmbeddingProviderInfo } = await import("../embeddings/index.ts");
        const info = getEmbeddingProviderInfo();
        log.info({ msg: "reembed_started", ...info, triggered_by: auth.user_id });
        const result = await reembedAll((done, total) => {
          log.info({ msg: "reembed_progress", done, total, pct: Math.round(done / total * 100) });
        });
        return json({ ...result, provider: info });
      } catch (e: any) {
        return safeError("Re-embed", e);
      }
    }

    // ========================================================================
    // EMBEDDING PROVIDER INFO -- show current embedding configuration
    // ========================================================================
    if (url.pathname === "/admin/embedding-info" && method === "GET") {
      if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
      try {
        const { getEmbeddingProviderInfo } = await import("../embeddings/index.ts");
        return json(getEmbeddingProviderInfo());
      } catch (e: any) {
        return safeError("Embedding info", e);
      }
    }

    // ========================================================================
    // FACT VALIDITY BACKFILL — populate valid_at for existing facts
    // ========================================================================
    if (url.pathname === "/admin/backfill-facts" && method === "POST") {
      if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
      try {
        const { backfillFactValidity } = await import("../intelligence/temporal.ts");
        const filled = backfillFactValidity(auth.user_id);
        return json({ backfilled: filled });
      } catch (e: any) {
        return safeError("Fact backfill", e);
      }
    }

    // ========================================================================
    // COOCCURRENCE REBUILD — rebuild entity cooccurrence graph from scratch
    // ========================================================================
    if (url.pathname === "/admin/rebuild-cooccurrences" && method === "POST") {
      if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
      try {
        const { rebuildCooccurrences } = await import("../graph/cooccurrence.ts");
        const pairs = rebuildCooccurrences(auth.user_id);
        return json({ rebuilt_pairs: pairs });
      } catch (e: any) {
        return safeError("Cooccurrence rebuild", e);
      }
    }

    // ========================================================================
    // COMMUNITY DETECTION — label propagation clustering on memory graph
    // ========================================================================
    if (url.pathname === "/admin/detect-communities" && method === "POST") {
      if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
      try {
        const { detectCommunities } = await import("../graph/communities.ts");
        const result = detectCommunities(auth.user_id);
        return json(result);
      } catch (e: any) {
        return safeError("Community detection", e);
      }
    }

    // ========================================================================
    // COMMUNITY STATS + MEMBERS — query detected communities
    // ========================================================================
    if (url.pathname === "/communities" && method === "GET") {
      try {
        const { getCommunityStats } = await import("../graph/communities.ts");
        const stats = getCommunityStats(auth.user_id);
        return json({ communities: stats, count: stats.length });
      } catch (e: any) {
        return safeError("Community stats", e);
      }
    }

    if (url.pathname.match(/^\/communities\/(\d+)$/) && method === "GET") {
      try {
        const communityId = parseInt(url.pathname.split("/")[2]);
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
        const { getCommunityMembers } = await import("../graph/communities.ts");
        const members = getCommunityMembers(communityId, auth.user_id, limit);
        return json({ community_id: communityId, members, count: members.length });
      } catch (e: any) {
        return safeError("Community members", e);
      }
    }

    // ========================================================================
    // CURRENT STATE — query tracked key-value state
    // ========================================================================
    if (url.pathname === "/state" && method === "GET") {
      try {
        const key = url.searchParams.get("key");
        let rows;
        if (key) {
          rows = db.prepare(
            "SELECT * FROM current_state WHERE user_id = ? AND key LIKE ? ORDER BY updated_at DESC"
          ).all(auth.user_id, `%${key}%`);
        } else {
          rows = db.prepare(
            "SELECT * FROM current_state WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100"
          ).all(auth.user_id);
        }
        return json({ state: rows, count: (rows as any[]).length });
      } catch (e: any) {
        return safeError("State query", e);
      }
    }

    // ========================================================================
    // USER PREFERENCES — query extracted preferences
    // ========================================================================
    if (url.pathname === "/preferences" && method === "GET") {
      try {
        const domain = url.searchParams.get("domain");
        let rows;
        if (domain) {
          rows = db.prepare(
            "SELECT * FROM user_preferences WHERE user_id = ? AND domain = ? ORDER BY strength DESC"
          ).all(auth.user_id, domain);
        } else {
          rows = db.prepare(
            "SELECT * FROM user_preferences WHERE user_id = ? ORDER BY strength DESC LIMIT 100"
          ).all(auth.user_id);
        }
        return json({ preferences: rows, count: (rows as any[]).length });
      } catch (e: any) {
        return safeError("Preferences query", e);
      }
    }

        if (url.pathname === "/stats" && method === "GET") {
      const memCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ?").get(auth.user_id) as { count: number };
      const embCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND embedding IS NOT NULL").get(auth.user_id) as { count: number };
      const linkCount = db.prepare(
        `SELECT COUNT(*) as count FROM memory_links ml
         JOIN memories ms ON ms.id = ml.source_id
         JOIN memories mt ON mt.id = ml.target_id
         WHERE ms.user_id = ? AND mt.user_id = ?`
      ).get(auth.user_id, auth.user_id) as { count: number };
      const convCount = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE user_id = ?").get(auth.user_id) as { count: number };
      const msgCount = db.prepare(
        `SELECT COUNT(*) as count FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_id = ?`
      ).get(auth.user_id) as { count: number };
      const forgottenCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_forgotten = 1").get(auth.user_id) as { count: number };
      const staticCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_static = 1 AND is_forgotten = 0").get(auth.user_id) as { count: number };
      const dynamicCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_static = 0 AND is_forgotten = 0").get(auth.user_id) as { count: number };
      const versionedCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND version > 1").get(auth.user_id) as { count: number };
      const archivedCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_archived = 1 AND is_forgotten = 0").get(auth.user_id) as { count: number };
      const pendingCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND status = 'pending' AND is_forgotten = 0").get(auth.user_id) as { count: number };
      const rejectedCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND status = 'rejected'").get(auth.user_id) as { count: number };
      const inferenceCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND is_inference = 1").get(auth.user_id) as { count: number };

      const linkTypes = db.prepare(
        `SELECT ml.type, COUNT(*) as count FROM memory_links ml
         JOIN memories ms ON ms.id = ml.source_id
         JOIN memories mt ON mt.id = ml.target_id
         WHERE ms.user_id = ? AND mt.user_id = ?
         GROUP BY ml.type ORDER BY count DESC`
      ).all(auth.user_id, auth.user_id);

      const categories = db.prepare(
        `SELECT category, COUNT(*) as count FROM memories WHERE user_id = ? AND is_forgotten = 0 GROUP BY category ORDER BY count DESC`
      ).all(auth.user_id);

      const agents = db.prepare(
        `SELECT c.agent, COUNT(*) as conversations,
          (SELECT COUNT(*) FROM messages m JOIN conversations c2 ON m.conversation_id = c2.id WHERE c2.agent = c.agent AND c2.user_id = ?) as total_messages
         FROM conversations c WHERE c.user_id = ? GROUP BY c.agent ORDER BY total_messages DESC`
      ).all(auth.user_id, auth.user_id);

      const dbSize = statSync(DB_PATH).size;
      return json({
        memories: {
          total: memCount.count,
          embedded: embCount.count,
          forgotten: forgottenCount.count,
          archived: archivedCount.count,
          pending: pendingCount.count,
          rejected: rejectedCount.count,
          static: staticCount.count,
          dynamic: dynamicCount.count,
          versioned: versionedCount.count,
          inferences: inferenceCount.count,
          categories,
        },
        links: {
          total: linkCount.count,
          by_type: linkTypes,
        },
        conversations: convCount.count,
        messages: msgCount.count,
        agents,
        embedding_model: EMBEDDING_MODEL,
        llm_model: LLM_MODEL,
        llm_providers: LLM_PROVIDERS.filter(isProviderAvailable).map(p => p.name),
        llm_configured: isLLMAvailable(),
        db_size_mb: Math.round(dbSize / 1048576 * 100) / 100,
      });
    }

    // ========================================================================
    // INBOX / REVIEW QUEUE — v5.1
    // ========================================================================

    // List pending memories
    if (url.pathname === "/inbox" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      const offset = Number(url.searchParams.get("offset") || 0);
      const pending = listPending.all(auth.user_id, limit, offset) as any[];
      const total = (countPending.get(auth.user_id) as { count: number }).count;
      for (const p of pending) {
        try { if (p.tags) p.tags = JSON.parse(p.tags); } catch { p.tags = []; }
      }
      return json({ pending, count: pending.length, total, offset, limit });
    }

    // Approve a pending memory
    if (url.pathname.match(/^\/inbox\/\d+\/approve$/) && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const id = Number(url.pathname.split("/")[2]);
      const mem = getMemoryWithoutEmbedding.get(id) as any;
      if (!mem) return errorResponse("Not found", 404);
      if (!canAccessOwnedRow(mem, auth)) return errorResponse("Forbidden", 403);
      if (mem.status !== "pending") return errorResponse(`Memory is already ${mem.status}`, 400);
      approveMemory.run(id, auth.user_id);
      audit(auth.user_id, "inbox.approve", "memory", id, null, clientIp, requestId);
      emitWebhookEvent("memory.approved", { id }, auth.user_id);
      return json({ approved: true, id });
    }

    // Reject a pending memory
    if (url.pathname.match(/^\/inbox\/\d+\/reject$/) && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      const id = Number(url.pathname.split("/")[2]);
      const mem = getMemoryWithoutEmbedding.get(id) as any;
      if (!mem) return errorResponse("Not found", 404);
      if (!canAccessOwnedRow(mem, auth)) return errorResponse("Forbidden", 403);
      if (mem.status !== "pending") return errorResponse(`Memory is already ${mem.status}`, 400);
      const body = await req.json().catch(() => ({})) as any;
      rejectMemory.run(id, auth.user_id);
      audit(auth.user_id, "inbox.reject", "memory", id, body.reason || null, clientIp, requestId);
      if (body.reason) {
        db.prepare("UPDATE memories SET forget_reason = ? WHERE id = ?").run(body.reason, id);
      }
      emitWebhookEvent("memory.rejected", { id, reason: body.reason || null }, auth.user_id);
      return json({ rejected: true, id });
    }

    // Edit + approve in one shot
    if (url.pathname.match(/^\/inbox\/\d+\/edit$/) && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const id = Number(url.pathname.split("/")[2]);
        const mem = getMemoryWithoutEmbedding.get(id) as any;
        if (!mem) return errorResponse("Not found", 404);
        if (!canAccessOwnedRow(mem, auth)) return errorResponse("Forbidden", 403);
        const body = await req.json() as any;

        const sets: string[] = ["status = 'approved'", "updated_at = datetime('now')"];
        const vals: any[] = [];
        if (body.content?.trim()) { sets.push("content = ?"); vals.push(body.content.trim()); }
        if (body.category) { sets.push("category = ?"); vals.push(body.category); }
        if (body.importance) { sets.push("importance = ?"); vals.push(Math.max(1, Math.min(10, Number(body.importance)))); }
        if (body.tags) {
          const tags = Array.isArray(body.tags) ? body.tags : body.tags.split(",");
          sets.push("tags = ?");
          vals.push(JSON.stringify(tags.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean)));
        }
        vals.push(id);
        db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

        // Re-embed if content changed
        if (body.content?.trim()) {
          try {
            const emb = await embed(body.content.trim());
            updateMemoryEmbedding.run(embeddingToBuffer(emb), id);
            try { updateMemoryVec.run(embeddingToVectorJSON(emb), id); } catch {}
          } catch {}
        }

        emitWebhookEvent("memory.approved", { id, edited: true }, auth.user_id);
        return json({ approved: true, edited: true, id });
      } catch (e: any) {
        return safeError("Edit", e);
      }
    }

    // Bulk approve/reject
    if (url.pathname === "/inbox/bulk" && method === "POST") {
      if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
      try {
        const body = await req.json() as any;
        const ids = body.ids;
        const action = body.action; // "approve" or "reject"
        if (!Array.isArray(ids) || !ids.length) return errorResponse("ids array required");
        if (action !== "approve" && action !== "reject") return errorResponse("action must be 'approve' or 'reject'");

        let count = 0;
        const stmt = action === "approve" ? approveMemory : rejectMemory;
        for (const id of ids) {
          stmt.run(id, auth.user_id);
          count++;
        }
        emitWebhookEvent(`memory.bulk_${action}`, { ids, count }, auth.user_id);
        return json({ action, count, ids });
      } catch (e: any) {
        return safeError("Bulk action", e);
      }
    }

    // ========================================================================
    // AUDIT LOG ENDPOINT
    // ========================================================================
    if (url.pathname === "/audit" && method === "GET") {
      if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
      const offset = Number(url.searchParams.get("offset")) || 0;
      const action = url.searchParams.get("action");
      let sql = "SELECT * FROM audit_log WHERE 1=1";
      const params: any[] = [];
      if (action) { sql += " AND action = ?"; params.push(action); }
      sql += " ORDER BY id DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);
      const entries = db.prepare(sql).all(...params);
      const total = (db.prepare("SELECT COUNT(*) as count FROM audit_log").get() as any).count;
      return json({ entries, total, limit, offset }, 200, { "X-Request-Id": requestId });
    }

    // ========================================================================
    // WAL CHECKPOINT ENDPOINT
    // ========================================================================
    if (url.pathname === "/checkpoint" && method === "POST") {
      if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
      const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as any;
      audit(auth.user_id, "checkpoint", null, null, JSON.stringify(result), clientIp, requestId);
      log.info({ msg: "wal_checkpoint_manual", result, rid: requestId });
      return json({ checkpointed: true, ...result }, 200, { "X-Request-Id": requestId });
    }

    // ========================================================================
    // BACKUP ENDPOINT — download SQLite DB (consistent snapshot)
    // ========================================================================
    if (url.pathname === "/backup" && method === "GET") {
      if (!auth.is_admin) return errorResponse("Admin required", 403, requestId);
      try {
        const backupPath = resolve(DATA_DIR, `backup-${Date.now()}.db`);
        db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
        const fileStat = statSync(backupPath);
        const fileBuffer = readFileSync(backupPath);
        audit(auth.user_id, "backup", null, null, `${fileStat.size} bytes`, clientIp, requestId);
        log.info({ msg: "backup_created", size: fileStat.size, method: "VACUUM_INTO", rid: requestId });
        const resp = new Response(fileBuffer, {
          headers: securityHeaders({
            "Content-Type": "application/x-sqlite3",
            "Content-Disposition": `attachment; filename="engram-${new Date().toISOString().slice(0,10)}.db"`,
          }),
        });
        setTimeout(() => { try { unlinkSync(backupPath); } catch {} }, 30_000);
        return resp;
      } catch (e: any) {
        return safeError("Backup", e, 500, requestId);
      }
    }

    // ========================================================================
    // CATCH-ALL 404 with request log
    // ========================================================================
    {
      const elapsed = (performance.now() - requestStart).toFixed(1);
      log.info({ msg: "req", method, path: url.pathname, status: 404, ms: elapsed, ip: clientIp, user: auth.user_id, rid: requestId });
    }
        return errorResponse("Not found", 404, requestId);
}

export { fetchHandler };
