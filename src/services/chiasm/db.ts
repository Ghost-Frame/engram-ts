// ============================================================================
// Chiasm DB -- Schema + prepared statements for task tracking
// Migrations run at module scope so tables exist before statements compile.
// ============================================================================

import { db } from "../../db/index.ts";
import { log } from "../../config/logger.ts";

// -- Schema (module-scope migration) --

function migrate(sql: string) {
  try { db.exec(sql); } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.warn({ msg: "chiasm_migrate_error", error: msg });
  }
}

migrate(`
  CREATE TABLE IF NOT EXISTS chiasm_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    project TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS chiasm_task_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES chiasm_tasks(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`CREATE INDEX IF NOT EXISTS idx_chiasm_tasks_status ON chiasm_tasks(status)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_chiasm_tasks_agent ON chiasm_tasks(agent)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_chiasm_tasks_project ON chiasm_tasks(project)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_chiasm_task_updates_task_id ON chiasm_task_updates(task_id)`);

// -- Prepared statements --

export const getTaskById = db.prepare("SELECT * FROM chiasm_tasks WHERE id = ?");
export const deleteTaskStmt = db.prepare("DELETE FROM chiasm_tasks WHERE id = ?");
