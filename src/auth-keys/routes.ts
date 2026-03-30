// ============================================================================
// AUTH-KEYS DOMAIN -- Route handlers for auth, users, keys, and spaces
// ============================================================================
// NOTE: GUI auth and bootstrap run before API key auth. Handlers for those
// routes do NOT call getContext() -- they access request data directly.
// All other handlers require auth (registered on an auth-wrapped router).

import { timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError, securityHeaders } from "../helpers/index.ts";
import { auditLog } from "../middleware/audit.ts";
import { generateApiKey } from "../auth/index.ts";
import { DATA_DIR, DEFAULT_RATE_LIMIT, GUI_AUTH_MAX_ATTEMPTS, GUI_AUTH_WINDOW_MS, GUI_AUTH_LOCKOUT_MS } from "../config/index.ts";
import {
  GUI_PASSWORD, GUI_AUTH_CONFIGURED, guiCookieAttributes, GUI_COOKIE_MAX_AGE,
  guiSignCookie, getLoginHtml,
} from "../gui/index.ts";
import {
  countActiveKeys,
  insertUser, insertDefaultSpace, listUsers,
  insertApiKey, insertBootstrapAdminKey, listKeysForUser, getKeyOwner, revokeKey,
  getKeyForUser, insertRotatedKey, setKeyExpiry,
  insertSpace, listSpacesForUser, getSpaceOwner, deleteSpace,
} from "./db.ts";

// In-memory rate limit state for GUI auth (per-IP)
const guiAuthAttempts = new Map<string, { count: number; first: number; locked_until: number }>();

const GUI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "form-action 'self'",
].join("; ");

export function registerAuthKeysRoutes(router: Router): void {

  // ========================================================================
  // GUI AUTH -- These run before API key auth; no getContext() usage
  // ========================================================================

  // POST /gui/auth -- GUI login (no API key required)
  router.post("/gui/auth", async (req) => {
    if (!GUI_AUTH_CONFIGURED || !GUI_PASSWORD) {
      return json({ error: "GUI password is not configured" }, 503);
    }
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";
    const now = Date.now();
    const ga = guiAuthAttempts.get(clientIp);
    if (ga && now < ga.locked_until) {
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
            "Set-Cookie": `engram_auth=${cookie}; ${guiCookieAttributes(req)}; Max-Age=${GUI_COOKIE_MAX_AGE}`,
          })
        });
      }
      const att = guiAuthAttempts.get(clientIp) || { count: 0, first: Date.now(), locked_until: 0 };
      att.count++;
      if (att.count >= GUI_AUTH_MAX_ATTEMPTS) att.locked_until = Date.now() + GUI_AUTH_LOCKOUT_MS;
      guiAuthAttempts.set(clientIp, att);
      return json({ error: "Invalid password" }, 401);
    } catch {
      return json({ error: "Bad request" }, 400);
    }
  });

  // GET /gui/logout -- clear cookie (no API key required)
  router.get("/gui/logout", async (req) => {
    return new Response(await getLoginHtml(), {
      headers: securityHeaders({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": GUI_CONTENT_SECURITY_POLICY,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "Set-Cookie": `engram_auth=; ${guiCookieAttributes(req)}; Max-Age=0`,
      })
    });
  });

  // ========================================================================
  // BOOTSTRAP -- create first admin key when no keys exist (no API key required)
  // ========================================================================

  // POST /bootstrap
  router.post("/bootstrap", async (req) => {
    const keyCount = countActiveKeys();
    if (keyCount > 0) {
      return json({ error: "Bootstrap unavailable. API keys already exist." }, 403);
    }
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";
    const isLocal = clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "localhost";
    const tokenFile = resolve(DATA_DIR, ".bootstrap_token");
    let bootstrapToken: string | null = null;
    try { bootstrapToken = readFileSync(tokenFile, "utf-8").trim(); } catch {}
    if (!bootstrapToken) {
      bootstrapToken = randomUUID();
      try {
        writeFileSync(tokenFile, bootstrapToken, { mode: 0o600 });
      } catch {}
    }
    const body = await req.json().catch(() => ({})) as any;
    if (!isLocal) {
      const providedToken = body.token || req.headers.get("X-Bootstrap-Token") || "";
      if (!bootstrapToken || providedToken !== bootstrapToken) {
        return json({ error: "Bootstrap from remote requires valid token. Check DATA_DIR/.bootstrap_token on the server." }, 403);
      }
    }
    try {
      const { key, prefix, hash } = generateApiKey();
      const name = body.name || "bootstrap-admin";
      insertBootstrapAdminKey(prefix, hash, name);
      auditLog(1, "bootstrap", null, null, "first_admin_key_created", clientIp);
      try { unlinkSync(tokenFile); } catch {}
      return json({ key, name, scopes: "read,write,admin", user_id: 1, message: "First admin API key created. Save this key -- it cannot be retrieved again." }, 201);
    } catch (e: any) {
      return safeError("Bootstrap", e, 500);
    }
  });

  // ========================================================================
  // USER MANAGEMENT (admin only -- requires auth via getContext)
  // ========================================================================

  // POST /users
  router.post("/users", async (req) => {
    const { auth, body } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403);
    try {
      const b = body as any;
      if (!b.username) return errorResponse("username is required");
      const validRoles = ["admin", "writer", "reader"];
      const role = validRoles.includes(b.role) ? b.role : "writer";
      const isAdmin = role === "admin" ? 1 : 0;
      const result = insertUser(b.username.trim(), b.email || null, role, isAdmin);
      insertDefaultSpace(result.id);
      return json({ id: result.id, username: b.username.trim(), created_at: result.created_at });
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return errorResponse("Username already exists", 409);
      return safeError("Operation", e);
    }
  });

  // GET /users
  router.get("/users", async (req) => {
    const { auth } = getContext(req);
    if (!auth.is_admin) return errorResponse("Admin required", 403);
    const users = listUsers();
    return json({ users });
  });

  // ========================================================================
  // API KEY MANAGEMENT (requires auth)
  // ========================================================================

  // POST /keys
  router.post("/keys", async (req) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "admin")) return errorResponse("Admin scope required", 403);
    try {
      const b = body as any;
      const targetUserId = b.user_id || auth.user_id;
      if (targetUserId !== auth.user_id && !auth.is_admin) return errorResponse("Cannot create keys for other users", 403);
      const { key, prefix, hash } = generateApiKey();
      const name = b.name || "default";
      const scopes = b.scopes || "read,write";
      const rateLimit = Math.min(Math.max(Number(b.rate_limit) || DEFAULT_RATE_LIMIT, 10), 10000);
      const expiresAt = b.expires_at ? String(b.expires_at) : null;
      const keyResult = insertApiKey(targetUserId, prefix, hash, name, scopes, rateLimit, expiresAt);
      return json({ key, id: keyResult.id, name, scopes, rate_limit: rateLimit, user_id: targetUserId, expires_at: expiresAt, message: "Save this key -- it cannot be retrieved again." });
    } catch (e: any) {
      return safeError("Operation", e);
    }
  });

  // GET /keys
  router.get("/keys", async (req) => {
    const { auth } = getContext(req);
    const keys = listKeysForUser(auth.user_id);
    return json({ keys });
  });

  // DELETE /keys/:id
  router.delete("/keys/:id", async (req, params) => {
    const { auth } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const key = getKeyOwner(id);
    if (!key) return errorResponse("Not found", 404);
    if (key.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
    revokeKey(id);
    return json({ revoked: true, id });
  });

  // POST /keys/rotate
  router.post("/keys/rotate", async (req) => {
    const { auth, body, requestId } = getContext(req);
    if (!hasScope(auth, "admin")) return errorResponse("Admin required", 403, requestId);
    const b = body as any;
    const oldKeyId = Number(b.key_id);
    if (!oldKeyId) return errorResponse("key_id is required", 400, requestId);
    const oldKey = getKeyForUser(oldKeyId, auth.user_id);
    if (!oldKey) return errorResponse("Key not found", 404, requestId);
    const { key, prefix, hash } = generateApiKey();
    const newKeyResult = insertRotatedKey(
      auth.user_id, prefix, hash,
      `${oldKey.name} (rotated)`, oldKey.scopes, oldKey.rate_limit,
      oldKey.agent_id ?? null, b.expires_at || null,
    );
    const graceExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    setKeyExpiry(oldKeyId, graceExpiry);
    auditLog(auth.user_id, "key.rotated", "api_key", oldKeyId, `new_key_id=${newKeyResult.id}`, getContext(req).clientIp);
    return json({
      new_key: key,
      new_key_id: newKeyResult.id,
      old_key_id: oldKeyId,
      old_key_expires: graceExpiry,
      message: "Old key will expire in 24 hours. Update your clients to use the new key.",
    });
  });

  // ========================================================================
  // SPACE MANAGEMENT (requires auth)
  // ========================================================================

  // POST /spaces
  router.post("/spaces", async (req) => {
    const { auth, body } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const b = body as any;
      if (!b.name) return errorResponse("name is required");
      const result = insertSpace(auth.user_id, b.name.trim(), b.description || null);
      return json({ id: result.id, name: b.name.trim(), created_at: result.created_at });
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return errorResponse("Space name already exists", 409);
      return safeError("Operation", e);
    }
  });

  // GET /spaces
  router.get("/spaces", async (req) => {
    const { auth } = getContext(req);
    const spaces = listSpacesForUser(auth.user_id);
    return json({ spaces });
  });

  // DELETE /spaces/:id
  router.delete("/spaces/:id", async (req, params) => {
    const { auth } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const space = getSpaceOwner(id);
    if (!space) return errorResponse("Not found", 404);
    if (space.user_id !== auth.user_id && !auth.is_admin) return errorResponse("Forbidden", 403);
    if (space.name === "default") return errorResponse("Cannot delete default space", 400);
    deleteSpace(id);
    return json({ deleted: true, id });
  });

}
