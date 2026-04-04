// ============================================================================
// GROUNDING ROUTES - HTTP endpoints for tool execution framework
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { getGroundingClient } from "./client.ts";
import { getToolQualityManager } from "./quality.ts";
import type { SessionConfig } from "./types.ts";

export function registerGroundingRoutes(router: Router): void {
  const qualityManager = getToolQualityManager();
  const client = getGroundingClient(qualityManager);

  // POST /grounding/sessions - Create execution session
  router.post("/grounding/sessions", async (req) => {
    const { requestId, body: rawBody } = getContext(req);
    try {
      const body = (rawBody || {}) as any;
      const config: SessionConfig = {
        name: String(body?.name || `session-${Date.now()}`),
        backend: body?.backend || "shell",
        timeout_ms: body?.timeout_ms,
        max_retries: body?.max_retries,
        metadata: body?.metadata,
      };
      const session = await client.createSession(config);
      return json(session, 201);
    } catch (e: any) {
      return safeError("grounding session create", e, 500, requestId);
    }
  });

  // GET /grounding/sessions - List active sessions
  router.get("/grounding/sessions", () => {
    const sessions = client.listSessions();
    return Promise.resolve(json({ sessions, count: sessions.length }));
  });

  // GET /grounding/sessions/:id - Session detail
  router.get("/grounding/sessions/:id", (req, params) => {
    const { requestId } = getContext(req);
    const session = client.getSession(params.id);
    if (!session) return Promise.resolve(errorResponse("Session not found", 404, requestId));
    return Promise.resolve(json(session));
  });

  // DELETE /grounding/sessions/:id - Destroy session
  router.delete("/grounding/sessions/:id", async (req, params) => {
    const { requestId } = getContext(req);
    try {
      await client.destroySession(params.id);
      return json({ destroyed: true, id: params.id });
    } catch (e: any) {
      return safeError("grounding session destroy", e, 500, requestId);
    }
  });

  // GET /grounding/tools - List all available tools
  router.get("/grounding/tools", async (req) => {
    const { requestId, url } = getContext(req);
    try {
      const refresh = url.searchParams.get("refresh") === "true";
      const tools = await client.getAllTools(refresh);
      return json({ tools, count: tools.length });
    } catch (e: any) {
      return safeError("grounding tools list", e, 500, requestId);
    }
  });

  // POST /grounding/execute - Execute tool
  router.post("/grounding/execute", async (req) => {
    const { requestId, body: rawBody } = getContext(req);
    try {
      const body = (rawBody || {}) as any;
      const toolName = String(body?.tool || "").trim();
      if (!toolName) return errorResponse("tool is required", 400, requestId);

      const args = body?.args || {};
      const sessionId = body?.session_id;
      const timeoutMs = body?.timeout_ms;

      const result = await client.executeTool(toolName, args, sessionId, timeoutMs);
      return json(result);
    } catch (e: any) {
      return safeError("grounding execute", e, 500, requestId);
    }
  });

  // GET /grounding/quality - Tool quality metrics
  router.get("/grounding/quality", (req) => {
    const { url } = getContext(req);
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    const degradedOnly = url.searchParams.get("degraded") === "true";

    const records = degradedOnly
      ? qualityManager.getDegradedTools()
      : qualityManager.getAllRecords(limit);

    return Promise.resolve(json({ records, count: records.length }));
  });

  // GET /grounding/providers - List registered providers
  router.get("/grounding/providers", () => {
    const providers = client.listProviders();
    return Promise.resolve(json({ providers, count: providers.length }));
  });
}
