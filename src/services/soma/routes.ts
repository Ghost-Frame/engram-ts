// ============================================================================
// Soma routes - agent registry, heartbeat, groups, logs
// Prefix: /soma/*
// ============================================================================

import { json, errorResponse } from "../../helpers/index.ts";
import { getContext } from "../../middleware/auth.ts";
import { bounded } from "../types.ts";
import {
  registerAgent, getAgent, listAgents, updateAgent, deregisterAgent,
  heartbeat, getStaleAgents,
  createGroup, listGroups, getGroupFn, deleteGroup,
  addToGroup, removeFromGroup, getGroupMembers,
  findByCapability,
  addLog, getLogs,
  getStats,
  updateAgentQuality,
} from "./registry.ts";

const VALID_AGENT_STATUSES = new Set(["pending", "online", "offline", "error"]);

export async function handleSomaRoutes(
  method: string,
  url: URL,
  req: Request,
  requestId: string,
): Promise<Response | null> {
  const path = url.pathname;

  if (!path.startsWith("/soma/") && path !== "/soma") return null;

  const sub = path.slice("/soma".length); // e.g. "/agents" or "/agents/5"

  // - Agents (fixed routes FIRST, before parameterized) --

  if (sub === "/agents" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const { name, type, description, capabilities, config } = body;
    if (!name || typeof name !== "string") return errorResponse("name required", 400, requestId);
    if (!type || typeof type !== "string") return errorResponse("type required", 400, requestId);
    try {
      return json(registerAgent(auth.user_id, { name, type, description, capabilities, config }), 201);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return errorResponse("Agent already exists", 409, requestId);
      throw e;
    }
  }

  if (sub === "/agents" && method === "GET") {
    const { auth } = getContext(req);
    return json(listAgents(auth.user_id, {
      type: url.searchParams.get("type") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      capability: url.searchParams.get("capability") ?? undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 500, 100),
    }));
  }

  // GET /soma/agents/stale - MUST come before /soma/agents/:id
  if (sub === "/agents/stale" && method === "GET") {
    const { auth } = getContext(req);
    const minutes = bounded(url.searchParams.get("minutes"), 1, 1440, 5);
    return json(getStaleAgents(auth.user_id, minutes));
  }

  // GET /soma/agents/capability/:name - MUST come before /soma/agents/:id
  const capMatch = sub.match(/^\/agents\/capability\/(.+)$/);
  if (capMatch && method === "GET") {
    const { auth } = getContext(req);
    return json(findByCapability(auth.user_id, decodeURIComponent(capMatch[1])));
  }

  // /soma/agents/:id routes
  const agentMatch = sub.match(/^\/agents\/(\d+)$/);

  if (agentMatch && method === "GET") {
    const { auth } = getContext(req);
    const agent = getAgent(parseInt(agentMatch[1], 10), auth.user_id);
    if (!agent) return errorResponse("Agent not found", 404, requestId);
    return json(agent);
  }

  if (agentMatch && method === "PATCH") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    if (body.status !== undefined && !VALID_AGENT_STATUSES.has(body.status)) {
      return errorResponse(`Invalid status. Must be one of: ${[...VALID_AGENT_STATUSES].join(", ")}`, 400, requestId);
    }
    const agent = updateAgent(parseInt(agentMatch[1], 10), auth.user_id, body);
    if (!agent) return errorResponse("Agent not found", 404, requestId);
    return json(agent);
  }

  if (agentMatch && method === "DELETE") {
    const { auth } = getContext(req);
    const ok = deregisterAgent(parseInt(agentMatch[1], 10), auth.user_id);
    if (!ok) return errorResponse("Agent not found", 404, requestId);
    return json({ ok: true });
  }

  // POST /soma/agents/:id/heartbeat
  const hbMatch = sub.match(/^\/agents\/(\d+)\/heartbeat$/);
  if (hbMatch && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    if (body.status !== undefined && !VALID_AGENT_STATUSES.has(body.status)) {
      return errorResponse(`Invalid status. Must be one of: ${[...VALID_AGENT_STATUSES].join(", ")}`, 400, requestId);
    }
    const agent = heartbeat(parseInt(hbMatch[1], 10), auth.user_id, body.status);
    if (!agent) return errorResponse("Agent not found", 404, requestId);
    return json(agent);
  }

  // PATCH /soma/agents/:id/quality
  const qualityMatch = sub.match(/^\/agents\/([^/]+)\/quality$/);
  if (qualityMatch && method === "PATCH") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    if (body.quality_score === undefined) return errorResponse("quality_score is required", 400, requestId);
    try {
      const result = updateAgentQuality(qualityMatch[1], auth.user_id, body.quality_score, body.drift_flags ?? []);
      return json(result);
    } catch (e: any) {
      return errorResponse(e.message, e.message.includes("not found") ? 404 : 400, requestId);
    }
  }

  // POST /soma/agents/:id/logs
  const logMatch = sub.match(/^\/agents\/(\d+)\/logs$/);
  if (logMatch && method === "POST") {
    const { auth } = getContext(req);
    const agentId = parseInt(logMatch[1], 10);
    if (!getAgent(agentId, auth.user_id)) return errorResponse("Agent not found", 404, requestId);
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    if (!body.message || typeof body.message !== "string") return errorResponse("message required", 400, requestId);
    const entry = addLog(agentId, body);
    return json(entry, 201);
  }

  // GET /soma/agents/:id/logs
  if (logMatch && method === "GET") {
    const { auth } = getContext(req);
    const agentId = parseInt(logMatch[1], 10);
    if (!getAgent(agentId, auth.user_id)) return errorResponse("Agent not found", 404, requestId);
    const logs = getLogs(agentId, {
      level: url.searchParams.get("level") ?? undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 1000, 100),
    });
    return json(logs);
  }

  // - Groups --

  if (sub === "/groups" && method === "GET") {
    const { auth } = getContext(req);
    return json(listGroups(auth.user_id));
  }

  if (sub === "/groups" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const { name, description } = body;
    if (!name || typeof name !== "string") return errorResponse("name required", 400, requestId);
    try {
      return json(createGroup(auth.user_id, { name, description }), 201);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return errorResponse("Group already exists", 409, requestId);
      throw e;
    }
  }

  // DELETE /soma/groups/:id
  const groupMatch = sub.match(/^\/groups\/(\d+)$/);
  if (groupMatch && method === "DELETE") {
    const { auth } = getContext(req);
    const ok = deleteGroup(parseInt(groupMatch[1], 10), auth.user_id);
    if (!ok) return errorResponse("Group not found", 404, requestId);
    return json({ ok: true });
  }

  // GET /soma/groups/:id/members
  const membersMatch = sub.match(/^\/groups\/(\d+)\/members$/);
  if (membersMatch && method === "GET") {
    const { auth } = getContext(req);
    const group = getGroupFn(parseInt(membersMatch[1], 10), auth.user_id);
    if (!group) return errorResponse("Group not found", 404, requestId);
    return json(getGroupMembers(parseInt(membersMatch[1], 10), auth.user_id));
  }

  // POST /soma/groups/:id/members
  if (membersMatch && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const agentId = body.agent_id;
    if (!agentId || typeof agentId !== "number") return errorResponse("agent_id required", 400, requestId);
    const group = getGroupFn(parseInt(membersMatch[1], 10), auth.user_id);
    if (!group) return errorResponse("Group not found", 404, requestId);
    const agent = getAgent(agentId, auth.user_id);
    if (!agent) return errorResponse("Agent not found", 404, requestId);
    return json(addToGroup(agentId, parseInt(membersMatch[1], 10)), 201);
  }

  // DELETE /soma/groups/:id/members/:agentId
  const rmMemberMatch = sub.match(/^\/groups\/(\d+)\/members\/(\d+)$/);
  if (rmMemberMatch && method === "DELETE") {
    const { auth } = getContext(req);
    const ok = removeFromGroup(parseInt(rmMemberMatch[2], 10), parseInt(rmMemberMatch[1], 10));
    if (!ok) return errorResponse("Membership not found", 404, requestId);
    return json({ ok: true });
  }

  // - Stats --

  if (sub === "/stats" && method === "GET") {
    return json(getStats());
  }

  return null; // Not a soma route match
}
