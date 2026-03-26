// ============================================================================
// Chiasm engine -- task CRUD, activity feed, pruning
// Ported from standalone Chiasm service (chiasm/src/db/queries.ts)
// ============================================================================

import { db } from "../../db/index.ts";
import { publish } from "../axon-stub.ts";
import { getTaskById, deleteTaskStmt } from "./db.ts";

// -- Types --

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

// -- Tasks --

export function listTasks(filters: TaskFilters = {}): Task[] {
  let query = "SELECT * FROM chiasm_tasks WHERE 1=1";
  const params: Array<string | number> = [];

  if (filters.agent) { query += " AND agent = ?"; params.push(filters.agent); }
  if (filters.project) { query += " AND project = ?"; params.push(filters.project); }
  if (filters.status) { query += " AND status = ?"; params.push(filters.status); }

  query += " ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?";
  params.push(filters.limit ?? 500, filters.offset ?? 0);

  return db.prepare(query).all(...params) as Task[];
}

export function getTask(id: number): Task | undefined {
  return getTaskById.get(id) as Task | undefined;
}

export function createTask(data: { agent: string; project: string; title: string; summary?: string }): Task {
  const run = db.transaction(() => {
    const result = db.prepare(
      "INSERT INTO chiasm_tasks (agent, project, title, summary) VALUES (?, ?, ?, ?) RETURNING *"
    ).get(data.agent, data.project, data.title, data.summary ?? null) as Task;

    db.prepare(
      "INSERT INTO chiasm_task_updates (task_id, agent, status, summary) VALUES (?, ?, 'active', ?)"
    ).run(result.id, data.agent, data.summary ?? null);

    publish("system", "chiasm", "task.created", {
      task_id: result.id, agent: data.agent, project: data.project, title: data.title,
    });

    return result;
  });

  return run();
}

export function updateTask(id: number, data: { status?: string; summary?: string }): Task | undefined {
  const existing = getTask(id);
  if (!existing) return undefined;

  const status = data.status ?? existing.status;
  const summary = data.summary ?? existing.summary;

  const run = db.transaction(() => {
    const result = db.prepare(
      "UPDATE chiasm_tasks SET status = ?, summary = ?, updated_at = datetime('now') WHERE id = ? RETURNING *"
    ).get(status, summary, id) as Task;

    db.prepare(
      "INSERT INTO chiasm_task_updates (task_id, agent, status, summary) VALUES (?, ?, ?, ?)"
    ).run(id, existing.agent, status, summary);

    publish("system", "chiasm", "task.updated", {
      task_id: id, agent: existing.agent, status, previous_status: existing.status,
    });

    return result;
  });

  return run();
}

export function deleteTask(id: number): boolean {
  const info = deleteTaskStmt.run(id);
  return info.changes > 0;
}

// -- Feed --

export function getFeed(limit: number = 50, offset: number = 0): (TaskUpdate & { project: string; title: string })[] {
  return db.prepare(`
    SELECT tu.*, COALESCE(t.project, 'deleted') as project, COALESCE(t.title, 'deleted') as title
    FROM chiasm_task_updates tu
    LEFT JOIN chiasm_tasks t ON tu.task_id = t.id
    ORDER BY tu.created_at DESC, tu.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as (TaskUpdate & { project: string; title: string })[];
}

// -- Pruning --

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

// -- Stats --

export function getChiasmStats() {
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
