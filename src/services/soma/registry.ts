// ============================================================================
// Soma registry - agent CRUD, heartbeat, groups, logs, stats
// Ported from standalone Soma service (soma/src/registry.ts)
// ============================================================================

import { db } from "../../db/index.ts";
import { parseJsonFields, parseJsonFieldsAll } from "../helpers.ts";
import { publish } from "../axon/bus.ts";
import {
  insertAgent, getAgentById, deleteAgentStmt,
  insertGroupStmt, getGroupById, listGroupsStmt, deleteGroupStmt,
  addToGroupStmt, removeFromGroupStmt, deleteGroupMemberships, deleteAgentMemberships, deleteAgentLogs,
  insertLog, getLogById,
  agentCount, onlineCount, groupCount,
  updateAgentQuality as updateAgentQualityStmt,
} from "./db.ts";

// - Agents --

export function registerAgent(userId: number, data: {
  name: string; type: string; description?: string | null;
  capabilities?: unknown[]; config?: Record<string, unknown>;
}) {
  const info = insertAgent.run(
    data.name, data.type, data.description ?? null,
    JSON.stringify(data.capabilities ?? []),
    JSON.stringify(data.config ?? {}),
    userId,
  );
  const agent = getAgent(Number(info.lastInsertRowid), userId)!;
  publish(userId, "system", "soma", "agent.registered", { agent_id: agent.id, name: data.name, type: data.type });
  return agent;
}

export function getAgent(id: number, userId: number) {
  const row = getAgentById.get(id, userId) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "capabilities", "config");
}

export function getAgentByName(name: string, userId: number) {
  const row = db.prepare("SELECT * FROM soma_agents WHERE name = ? AND user_id = ?").get(name, userId) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "capabilities", "config");
}

export function listAgents(userId: number, opts?: { type?: string; status?: string; capability?: string; limit?: number }) {
  const clauses: string[] = ["user_id = ?"];
  const params: unknown[] = [userId];

  if (opts?.type) { clauses.push("type = ?"); params.push(opts.type); }
  if (opts?.status) { clauses.push("status = ?"); params.push(opts.status); }
  if (opts?.capability) { clauses.push("capabilities LIKE ?"); params.push(`%${opts.capability}%`); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts?.limit ?? 100;
  const rows = db.prepare(
    `SELECT * FROM soma_agents ${where} ORDER BY id DESC LIMIT ?`
  ).all(...params, limit) as Record<string, unknown>[];

  let results = parseJsonFieldsAll(rows, "capabilities", "config");
  if (opts?.capability) {
    results = results.filter((r: any) =>
      Array.isArray(r.capabilities) && r.capabilities.includes(opts.capability),
    );
  }
  return results;
}

export function updateAgent(
  id: number,
  userId: number,
  data: { name?: string; type?: string; description?: string | null; capabilities?: unknown[]; config?: Record<string, unknown>; status?: string },
) {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (data.name !== undefined) { fields.push("name = ?"); params.push(data.name); }
  if (data.type !== undefined) { fields.push("type = ?"); params.push(data.type); }
  if (data.description !== undefined) { fields.push("description = ?"); params.push(data.description); }
  if (data.capabilities !== undefined) { fields.push("capabilities = ?"); params.push(JSON.stringify(data.capabilities)); }
  if (data.config !== undefined) { fields.push("config = ?"); params.push(JSON.stringify(data.config)); }
  if (data.status !== undefined) { fields.push("status = ?"); params.push(data.status); }

  if (fields.length === 0) return getAgent(id, userId);

  fields.push("updated_at = datetime('now')");
  params.push(id, userId);

  db.prepare(`UPDATE soma_agents SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
  return getAgent(id, userId);
}

export function deregisterAgent(id: number, userId: number): boolean {
  const agent = getAgent(id, userId);
  const runDelete = db.transaction(() => {
    deleteAgentLogs.run(id);
    deleteAgentMemberships.run(id);
    return deleteAgentStmt.run(id, userId);
  });
  const info = runDelete();
  if (info.changes > 0 && agent) {
    publish(userId, "system", "soma", "agent.deregistered", { agent_id: id, name: (agent as any).name });
  }
  return info.changes > 0;
}

// - Heartbeat --

export function heartbeat(agentId: number, userId: number, status?: string) {
  const fields = ["heartbeat_at = datetime('now')", "updated_at = datetime('now')"];
  const params: unknown[] = [];
  if (status) {
    fields.push("status = ?");
    params.push(status);
  } else {
    fields.push("status = 'online'");
  }
  params.push(agentId, userId);
  const info = db.prepare(`UPDATE soma_agents SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
  if (info.changes === 0) return undefined;
  return getAgent(agentId, userId);
}

export function getStaleAgents(userId: number, minutes: number) {
  const rows = db.prepare(
    `SELECT * FROM soma_agents WHERE user_id = ? AND heartbeat_at < datetime('now', '-' || ? || ' minutes') AND status = 'online'`,
  ).all(userId, minutes) as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "capabilities", "config");
}

// - Groups --

export function createGroup(userId: number, data: { name: string; description?: string | null }) {
  const info = insertGroupStmt.run(data.name, data.description ?? null, userId);
  return getGroupFn(Number(info.lastInsertRowid), userId)!;
}

export function listGroups(userId: number) {
  return listGroupsStmt.all(userId);
}

export function getGroupFn(id: number, userId: number) {
  return getGroupById.get(id, userId);
}

export function deleteGroup(id: number, userId: number): boolean {
  deleteGroupMemberships.run(id);
  const info = deleteGroupStmt.run(id, userId);
  return info.changes > 0;
}

// - Agent-Group membership --

export function addToGroup(agentId: number, groupId: number) {
  addToGroupStmt.run(agentId, groupId);
  return { agent_id: agentId, group_id: groupId };
}

export function removeFromGroup(agentId: number, groupId: number): boolean {
  const info = removeFromGroupStmt.run(agentId, groupId);
  return info.changes > 0;
}

export function getGroupMembers(groupId: number, userId: number) {
  const rows = db.prepare(
    `SELECT a.* FROM soma_agents a JOIN soma_agent_groups ag ON a.id = ag.agent_id WHERE ag.group_id = ? AND a.user_id = ? ORDER BY a.name`,
  ).all(groupId, userId) as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "capabilities", "config");
}

// - Capability search --

export function findByCapability(userId: number, cap: string) {
  const rows = db.prepare(
    "SELECT * FROM soma_agents WHERE user_id = ? AND capabilities LIKE ?"
  ).all(userId, `%${cap}%`) as Record<string, unknown>[];
  const parsed = parseJsonFieldsAll(rows, "capabilities", "config");
  return parsed.filter((r: any) => Array.isArray(r.capabilities) && r.capabilities.includes(cap));
}

// - Logs --

export function addLog(agentId: number, data: { level?: string; message: string; data?: Record<string, unknown> }) {
  const info = insertLog.run(agentId, data.level ?? "info", data.message, JSON.stringify(data.data ?? {}));
  const row = getLogById.get(Number(info.lastInsertRowid)) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "data");
}

export function getLogs(agentId: number, opts?: { level?: string; limit?: number }) {
  const clauses = ["agent_id = ?"];
  const params: unknown[] = [agentId];

  if (opts?.level) { clauses.push("level = ?"); params.push(opts.level); }

  const limit = opts?.limit ?? 100;
  const rows = db.prepare(
    `SELECT * FROM soma_agent_logs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params, limit) as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "data");
}

// - Quality / Drift --

export function updateAgentQuality(agentId: string, userId: number, qualityScore: number, driftFlags: string[]): any {
  const result = updateAgentQualityStmt.run(qualityScore, JSON.stringify(driftFlags), agentId, userId);
  if (result.changes === 0) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return { agentId, qualityScore, driftFlags };
}

// - Stats --

export function getStats(userId?: number) {
  if (userId !== undefined) {
    const agents = (db.prepare("SELECT COUNT(*) as count FROM soma_agents WHERE user_id = ?").get(userId) as any).count;
    const online = (db.prepare("SELECT COUNT(*) as count FROM soma_agents WHERE status = 'online' AND user_id = ?").get(userId) as any).count;
    const groups = (db.prepare("SELECT COUNT(*) as count FROM soma_groups WHERE user_id = ?").get(userId) as any).count;
    const by_type = db.prepare("SELECT type, COUNT(*) as count FROM soma_agents WHERE user_id = ? GROUP BY type ORDER BY count DESC").all(userId);
    const by_status = db.prepare("SELECT status, COUNT(*) as count FROM soma_agents WHERE user_id = ? GROUP BY status ORDER BY count DESC").all(userId);
    return { agents, online, groups, by_type, by_status };
  }
  const agents = (agentCount.get() as any).count;
  const online = (onlineCount.get() as any).count;
  const groups = (groupCount.get() as any).count;
  const by_type = db.prepare("SELECT type, COUNT(*) as count FROM soma_agents GROUP BY type ORDER BY count DESC").all();
  const by_status = db.prepare("SELECT status, COUNT(*) as count FROM soma_agents GROUP BY status ORDER BY count DESC").all();
  return { agents, online, groups, by_type, by_status };
}
