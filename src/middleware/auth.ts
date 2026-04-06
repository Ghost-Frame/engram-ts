// src/middleware/auth.ts
import { randomUUID } from "crypto";
import { MAX_BODY_SIZE, MAX_ARTIFACT_SIZE, ALLOWED_IPS, TRUSTED_PROXIES, maintenanceMode, maintenanceReason } from "../config/index.ts";
import { getAuthOrDefault, isAuthError, type AuthContext, type AuthError } from "../auth/index.ts";
import { json, errorResponse, securityHeaders } from "../helpers/index.ts";
import { opsCounters } from "../config/logger.ts";
import type { Middleware, Params } from "../router/types.ts";

// WeakMap to attach parsed context to requests without modifying the Request object
export interface RequestContext {
  auth: AuthContext;
  body: unknown;
  url: URL;
  method: string;
  clientIp: string;
  requestId: string;
  requestStart: number;
}

const contextMap = new WeakMap<Request, RequestContext>();

export function getContext(req: Request): RequestContext {
  const ctx = contextMap.get(req);
  if (!ctx) throw new Error("Request context not initialized - auth middleware not applied");
  return ctx;
}

export function getClientIp(req: Request): string {
  const socketIp = req.headers.get("x-socket-ip") || "";
  // Only trust proxy headers if the direct connection is from a trusted proxy
  if (TRUSTED_PROXIES.length > 0 && TRUSTED_PROXIES.includes(socketIp)) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
  }
  return socketIp || "unknown";
}

export async function parseBody(req: Request, maxSize?: number): Promise<unknown> {
  if (req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS") return {};
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  const limit = maxSize ?? MAX_BODY_SIZE;
  try {
    const text = await req.text();
    if (text.length > limit) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function hasScope(auth: AuthContext, scope: string): boolean {
  return auth.scopes.includes("all") || auth.scopes.includes(scope) || auth.scopes.includes("admin");
}

export function canAccessOwnedRow(row: { user_id?: number } | null | undefined, auth: AuthContext): boolean {
  return !!row && (row.user_id === auth.user_id || auth.is_admin);
}

export function createAuthMiddleware(
  guiAuthed: (req: Request) => boolean,
): Middleware {
  // Pre-auth paths: these bypass authentication entirely
  const PRE_AUTH_PATHS = new Set(["/live", "/ready", "/health", "/gui/auth", "/gui/logout", "/bootstrap"]);

  // GUI SPA routes have their own auth logic in the route handler (serves login page or GUI)
  const GUI_SPA_PATHS = new Set(["/", "/gui", "/graph", "/search", "/inbox", "/timeline", "/entities", "/projects"]);

  return async (req: Request, _params: Params, next: () => Promise<Response>): Promise<Response> => {
    const requestStart = Date.now();
    opsCounters.request_count++;

    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const clientIp = getClientIp(req);
    const requestId = req.headers.get("x-request-id") || randomUUID();

    // IP allowlist check
    if (ALLOWED_IPS.length > 0 && !ALLOWED_IPS.includes(clientIp)) {
      return errorResponse("Forbidden", 403, requestId);
    }

    // Maintenance mode
    if (maintenanceMode && url.pathname !== "/health" && url.pathname !== "/live") {
      return json({ error: "Service in maintenance", reason: maintenanceReason }, 503);
    }

    // Pre-auth routes + GUI SPA GET routes: skip auth, attach minimal context
    if (PRE_AUTH_PATHS.has(url.pathname) || (GUI_SPA_PATHS.has(url.pathname) && method === "GET" && (req.headers.get("accept") || "").includes("text/html"))) {
      contextMap.set(req, {
        auth: { user_id: 0, space_id: null, key_id: null, agent_id: null, scopes: ["read"], is_admin: false },
        body: {},
        url, method, clientIp, requestId, requestStart,
      });
      return next();
    }

    // Parse body -- allow larger bodies on memory store endpoints (artifact uploads)
    const LARGE_BODY_PATHS = new Set(["/store", "/memory", "/memories"]);
    const bodyLimit = (LARGE_BODY_PATHS.has(url.pathname) && method === "POST")
      ? MAX_ARTIFACT_SIZE + MAX_BODY_SIZE
      : undefined;
    const body = await parseBody(req, bodyLimit);

    // Authenticate
    const authResult = getAuthOrDefault(req, guiAuthed);
    if (isAuthError(authResult)) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if ((authResult as AuthError).headers) Object.assign(headers, (authResult as AuthError).headers);
      return new Response(JSON.stringify({ error: authResult.error }), {
        status: authResult.status,
        headers: securityHeaders(headers),
      });
    }
    if (!authResult) {
      return errorResponse("Unauthorized", 401, requestId);
    }

    // Attach context
    contextMap.set(req, {
      auth: authResult,
      body,
      url,
      method,
      clientIp,
      requestId,
      requestStart,
    });

    const response = await next();

    // Track latency
    const duration = Date.now() - requestStart;
    opsCounters.request_latency_sum_ms += duration;

    return response;
  };
}
