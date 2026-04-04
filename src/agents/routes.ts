// ============================================================================
// AGENTS DOMAIN - Route handlers
// ============================================================================

import { readFileSync, writeFileSync } from "fs";
import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { audit } from "../db/index.ts";
import { SIGNING_SECRET_FILE } from "../config/index.ts";
import {
  createPassport, verifyPassport, verifyExecution,
  generateSigningSecret, verifyMessage, NonceTracker, verifyToolManifest,
} from "../../sign/index.ts";
import {
  insertAgent, getAgentById, getAgentByName, listAgents,
  revokeAgent, linkKeyToAgent, getAgentExecutions,
} from "./db.ts";

// Load or generate signing secret
let signingSecret: string;
try {
  signingSecret = readFileSync(SIGNING_SECRET_FILE, "utf8").trim();
} catch {
  signingSecret = generateSigningSecret();
  writeFileSync(SIGNING_SECRET_FILE, signingSecret, "utf8");
}

// Nonce tracker for replay protection (5-min window)
const nonceTracker = new NonceTracker();

export function registerAgentRoutes(router: Router): void {

  // POST /agents - register agent
  router.post("/agents", async (req) => {
    const { auth, clientIp, requestId, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = (rawBody || {}) as any;
      const { name, category, description, code_hash } = body;
      if (!name || typeof name !== "string") return errorResponse("name (string) required");

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
  });

  // GET /agents - list agents
  router.get("/agents", async (req) => {
    const { auth } = getContext(req);
    try {
      const agents = listAgents.all(auth.user_id) as any[];
      return json({ agents });
    } catch (e: any) {
      return safeError("list agents", e);
    }
  });

  // GET /agents/:id - get agent
  router.get("/agents/:id", async (req, params) => {
    const { auth } = getContext(req);
    const agentId = Number(params.id);
    if (isNaN(agentId)) return errorResponse("Invalid id");
    const agent = getAgentById.get(agentId, auth.user_id) as any;
    if (!agent) return errorResponse("Agent not found", 404);
    const { code_hash, ...safe } = agent;
    return json(safe);
  });

  // POST /agents/:id/revoke - revoke agent
  router.post("/agents/:id/revoke", async (req, params) => {
    const { auth, clientIp, requestId, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const agentId = Number(params.id);
    if (isNaN(agentId)) return errorResponse("Invalid id");
    const body = (rawBody || {}) as any;
    const reason = body.reason || "revoked";
    revokeAgent.run(reason, agentId, auth.user_id);
    audit(auth.user_id, "agent.revoke", "agent", agentId, reason, clientIp, requestId, agentId);
    return json({ revoked: true, agent_id: agentId });
  });

  // GET /agents/:agent/passport - get agent passport
  router.get("/agents/:agent/passport", async (req, params) => {
    const { auth } = getContext(req);
    const agentId = Number(params.agent);
    if (isNaN(agentId)) return errorResponse("Invalid id");
    const agent = getAgentById.get(agentId, auth.user_id) as any;
    if (!agent) return errorResponse("Agent not found", 404);
    if (!agent.is_active) return errorResponse("Agent is revoked", 403);
    const passport = createPassport(signingSecret, agent, auth.user_id);
    return json(passport);
  });

  // POST /agents/:agent/link-key - link an API key to this agent
  router.post("/agents/:agent/link-key", async (req, params) => {
    const { auth, body: rawBody } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const agentId = Number(params.agent);
    if (isNaN(agentId)) return errorResponse("Invalid id");
    const body = (rawBody || {}) as any;
    const keyId = body.key_id;
    if (!keyId) return errorResponse("key_id required");
    const agent = getAgentById.get(agentId, auth.user_id) as any;
    if (!agent) return errorResponse("Agent not found", 404);
    linkKeyToAgent.run(agentId, keyId, auth.user_id);
    return json({ linked: true, agent_id: agentId, key_id: keyId });
  });

  // GET /agents/:id/executions - get signed execution history
  router.get("/agents/:id/executions", async (req, params) => {
    const { auth, url } = getContext(req);
    const agentId = Number(params.id);
    if (isNaN(agentId)) return errorResponse("Invalid id");
    const agent = getAgentById.get(agentId, auth.user_id) as any;
    if (!agent) return errorResponse("Agent not found", 404);
    const limit = Number(url.searchParams.get("limit") || 50);
    const executions = getAgentExecutions.all(agentId, limit) as any[];
    return json({ agent_id: agentId, executions });
  });

  // POST /verify - verify a signed execution or passport
  router.post("/verify", async (req) => {
    const { body: rawBody } = getContext(req);
    try {
      const body = (rawBody || {}) as any;
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
  });
}
