// ============================================================================
// Soma registry - agent CRUD, heartbeat, groups, logs, stats
// Ported from standalone Soma service (soma/src/registry.ts)
// ============================================================================

import { db } from "../../db/index.ts";
import { parseJsonFields, parseJsonFieldsAll } from "../helpers.ts";
import { publish } from "../axon/bus.ts";
import {
  insertAgent, getAgentById, getAgentByNameStmt, deleteAgentStmt,
  insertGroupStmt, getGroupById, listGroupsStmt, deleteGroupStmt,
  addToGroupStmt, removeFromGroupStmt, deleteGroupMemberships, deleteAgentMemberships, deleteAgentLogs,
  insertLog, getLogById,
  agentCount, onlineCount, groupCount,
} from "./db.ts";

// - Agents --

export function registerAgent(data: {
  name: string; type: string; description?: string | null;
  capabilities?: unknown[]; config?: Record<string, unknown>;
}) {
  const info = insertAgent.run(
    data.name, data.type, data.description ?? null,
    JSON.stringify(data.capabilities ?? []),
    JSON.stringify(data.config ?? {}),
  );
  const agent = getAgent(Number(info.lastInsertRowid))!;
  publish("system", "soma", "agent.registered", { agent_id: agent.id, name: data.name, type: data.type });
  return agent;
}

export function getAgent(id: number) {
  const row = getAgentById.get(id) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "capabilities", "config");
}

export function getAgentByName(name: string) {
  const row = getAgentByNameStmt.get(name) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "capabilities", "config");
}

export function listAgents(opts?: { type?: string; status?: string; capability?: string; limit?: number }) {
  const clauses: string[] = [];
  const params: unknown[] = [];

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

  if (fields.length === 0) return getAgent(id);

  fields.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE soma_agents SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  return getAgent(id);
}

export function deregisterAgent(id: number): boolean {
  const agent = getAgent(id);
  const runDelete = db.transaction(() => {
    deleteAgentLogs.run(id);
    deleteAgentMemberships.run(id);
    return deleteAgentStmt.run(id);
  });
  const info = runDelete();
  if (info.changes > 0 && agent) {
    publish("system", "soma", "agent.deregistered", { agent_id: id, name: (agent as any).name });
  }
  return info.changes > 0;
}

// - Heartbeat --

export function heartbeat(agentId: number, status?: string) {
  const fields = ["heartbeat_at = datetime('now')", "updated_at = datetime('now')"];
  const params: unknown[] = [];
  if (status) {
    fields.push("status = ?");
    params.push(status);
  } else {
    fields.push("status = 'online'");
  }
  params.push(agentId);
  const info = db.prepare(`UPDATE soma_agents SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  if (info.changes === 0) return undefined;
  return getAgent(agentId);
}

export function getStaleAgents(minutes: number) {
  const rows = db.prepare(
    `SELECT * FROM soma_agents WHERE heartbeat_at < datetime('now', '-' || ? || ' minutes') AND status = 'online'`,
  ).all(minutes) as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "capabilities", "config");
}

// - Groups --

export function createGroup(data: { name: string; description?: string | null }) {
  const info = insertGroupStmt.run(data.name, data.description ?? null);
  return getGroupFn(Number(info.lastInsertRowid))!;
}

export function listGroups() {
  return listGroupsStmt.all();
}

export function getGroupFn(id: number) {
  return getGroupById.get(id);
}

export function deleteGroup(id: number): boolean {
  deleteGroupMemberships.run(id);
  const info = deleteGroupStmt.run(id);
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

export function getGroupMembers(groupId: number) {
  const rows = db.prepare(
    `SELECT a.* FROM soma_agents a JOIN soma_agent_groups ag ON a.id = ag.agent_id WHERE ag.group_id = ? ORDER BY a.name`,
  ).all(groupId) as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "capabilities", "config");
}

// - Capability search --

export function findByCapability(cap: string) {
  const rows = db.prepare(
    "SELECT * FROM soma_agents WHERE capabilities LIKE ?"
  ).all(`%${cap}%`) as Record<string, unknown>[];
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

// - Stats --

export function getStats() {
  const agents = (agentCount.get() as any).count;
  const online = (onlineCount.get() as any).count;
  const groups = (groupCount.get() as any).count;
  const by_type = db.prepare("SELECT type, COUNT(*) as count FROM soma_agents GROUP BY type ORDER BY count DESC").all();
  const by_status = db.prepare("SELECT status, COUNT(*) as count FROM soma_agents GROUP BY status ORDER BY count DESC").all();
  return { agents, online, groups, by_type, by_status };
}
