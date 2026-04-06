// ============================================================================
// Chiasm engine - task CRUD, activity feed, pruning
// Ported from standalone Chiasm service (chiasm/src/db/queries.ts)
// ============================================================================

import { db } from "../../db/index.ts";
import { publish } from "../axon/bus.ts";
import { getTaskById, deleteTaskStmt } from "./db.ts";

// - Types --

export interface Task {
  id: number;
  agent: string;
  project: string;
  title: string;
  status: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskUpdate {
  id: number;
  task_id: number;
  agent: string;
  status: string;
  summary: string | null;
  created_at: string;
}

export interface TaskFilters {
  agent?: string;
  project?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export const VALID_STATUSES = new Set(["active", "paused", "blocked", "completed"]);

// - Tasks --

export function listTasks(userId: number, filters: TaskFilters = {}): Task[] {
  let query = "SELECT * FROM chiasm_tasks WHERE user_id = ?";
  const params: Array<string | number> = [userId];

  if (filters.agent) { query += " AND agent = ?"; params.push(filters.agent); }
  if (filters.project) { query += " AND project = ?"; params.push(filters.project); }
  if (filters.status) { query += " AND status = ?"; params.push(filters.status); }

  query += " ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?";
  params.push(filters.limit ?? 500, filters.offset ?? 0);

  return db.prepare(query).all(...params) as Task[];
}

export function getTask(id: number, userId: number): Task | undefined {
  return getTaskById.get(id, userId) as Task | undefined;
}

// Transaction-safe inserts (no RETURNING - avoids libsql "statements in progress" bug)
const insertTaskTx = db.prepare(
  "INSERT INTO chiasm_tasks (agent, project, title, summary, user_id) VALUES (?, ?, ?, ?, ?)"
);
const insertTaskUpdateTx = db.prepare(
  "INSERT INTO chiasm_task_updates (task_id, agent, status, summary, user_id) VALUES (?, ?, ?, ?, ?)"
);
const updateTaskTx = db.prepare(
  "UPDATE chiasm_tasks SET status = ?, summary = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
);
const getLastRowId = db.prepare("SELECT last_insert_rowid() as id");

export function createTask(userId: number, data: { agent: string; project: string; title: string; summary?: string }): Task {
  const run = db.transaction(() => {
    insertTaskTx.run(data.agent, data.project, data.title, data.summary ?? null, userId);
    const { id } = getLastRowId.get() as { id: number };

    insertTaskUpdateTx.run(id, data.agent, "active", data.summary ?? null, userId);

    return id;
  });

  const id = run();

  publish(userId, "system", "chiasm", "task.created", {
    task_id: id, agent: data.agent, project: data.project, title: data.title,
  });

  return getTask(id, userId)!;
}

export function updateTask(id: number, userId: number, data: { status?: string; summary?: string }): Task | undefined {
  const existing = getTask(id, userId);
  if (!existing) return undefined;

  const status = data.status ?? existing.status;
  const summary = data.summary ?? existing.summary;

  const run = db.transaction(() => {
    updateTaskTx.run(status, summary, id, userId);
    insertTaskUpdateTx.run(id, existing.agent, status, summary, userId);
  });

  run();

  publish(userId, "system", "chiasm", "task.updated", {
    task_id: id, agent: existing.agent, status, previous_status: existing.status,
  });

  return getTask(id, userId);
}

export function deleteTask(id: number, userId: number): boolean {
  const info = deleteTaskStmt.run(id, userId);
  return info.changes > 0;
}

// - Feed --

export function getFeed(userId: number, limit: number = 50, offset: number = 0): (TaskUpdate & { project: string; title: string })[] {
  return db.prepare(`
    SELECT tu.*, COALESCE(t.project, 'deleted') as project, COALESCE(t.title, 'deleted') as title
    FROM chiasm_task_updates tu
    LEFT JOIN chiasm_tasks t ON tu.task_id = t.id
    WHERE tu.user_id = ?
    ORDER BY tu.created_at DESC, tu.id DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as (TaskUpdate & { project: string; title: string })[];
}

// - Pruning --

export function pruneTaskUpdates(maxRows: number, maxAgeDays: number) {
  if (maxAgeDays > 0) {
    db.prepare("DELETE FROM chiasm_task_updates WHERE created_at < datetime('now', ?)").run(`-${maxAgeDays} days`);
  }

  if (maxRows > 0) {
    db.prepare(`
      DELETE FROM chiasm_task_updates
      WHERE id IN (
        SELECT id FROM (
          SELECT id FROM chiasm_task_updates
          ORDER BY created_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      )
    `).run(maxRows);
  }
}

// - Stats --

export function getChiasmStats(userId?: number) {
  if (userId !== undefined) {
    const total = (db.prepare("SELECT COUNT(*) as count FROM chiasm_tasks WHERE user_id = ?").get(userId) as any).count;
    const active = (db.prepare("SELECT COUNT(*) as count FROM chiasm_tasks WHERE status = 'active' AND user_id = ?").get(userId) as any).count;
    const by_agent = db.prepare(
      "SELECT agent, COUNT(*) as count FROM chiasm_tasks WHERE status = 'active' AND user_id = ? GROUP BY agent ORDER BY count DESC"
    ).all(userId);
    const by_project = db.prepare(
      "SELECT project, COUNT(*) as count FROM chiasm_tasks WHERE status = 'active' AND user_id = ? GROUP BY project ORDER BY count DESC"
    ).all(userId);
    return { total, active, by_agent, by_project };
  }
  const total = (db.prepare("SELECT COUNT(*) as count FROM chiasm_tasks").get() as any).count;
  const active = (db.prepare("SELECT COUNT(*) as count FROM chiasm_tasks WHERE status = 'active'").get() as any).count;
  const by_agent = db.prepare(
    "SELECT agent, COUNT(*) as count FROM chiasm_tasks WHERE status = 'active' GROUP BY agent ORDER BY count DESC"
  ).all();
  const by_project = db.prepare(
    "SELECT project, COUNT(*) as count FROM chiasm_tasks WHERE status = 'active' GROUP BY project ORDER BY count DESC"
  ).all();
  return { total, active, by_agent, by_project };
}
