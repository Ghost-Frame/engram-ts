// src/middleware/auth.ts
import { randomUUID } from "crypto";
import { MAX_BODY_SIZE, ALLOWED_IPS, maintenanceMode, maintenanceReason } from "../config/index.ts";
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
  if (!ctx) throw new Error("Request context not initialized -- auth middleware not applied");
  return ctx;
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "127.0.0.1";
}

export async function parseBody(req: Request): Promise<unknown> {
  if (req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS") return {};
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_SIZE) return {};
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
  const PRE_AUTH_PATHS = new Set(["/live", "/ready", "/health", "/metrics"]);

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

    // Pre-auth routes: skip authentication, attach minimal context
    if (PRE_AUTH_PATHS.has(url.pathname)) {
      contextMap.set(req, {
        auth: { user_id: 0, space_id: null, key_id: null, agent_id: null, scopes: ["read"], is_admin: false },
        body: {},
        url, method, clientIp, requestId, requestStart,
      });
      return next();
    }

    // Parse body
    const body = await parseBody(req);

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
