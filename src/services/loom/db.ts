// ============================================================================
// Loom DB - Schema + prepared statements
// Migrations run at module scope so tables exist before statements compile.
// ============================================================================

import { db } from "../../db/index.ts";
import { log } from "../../config/logger.ts";

// - Schema (module-scope migration) --

function migrate(sql: string) {
  try { db.exec(sql); } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.warn({ msg: "loom_migrate_error", error: msg });
  }
}

migrate(`
  CREATE TABLE IF NOT EXISTS loom_workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    steps TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS loom_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER NOT NULL REFERENCES loom_workflows(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','paused','completed','failed','cancelled')),
    input TEXT NOT NULL DEFAULT '{}',
    output TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS loom_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES loom_runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('action','decision','parallel','wait','webhook','llm','transform')),
    config TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped')),
    input TEXT NOT NULL DEFAULT '{}',
    output TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    depends_on TEXT NOT NULL DEFAULT '[]',
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS loom_run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES loom_runs(id) ON DELETE CASCADE,
    step_id INTEGER REFERENCES loom_steps(id) ON DELETE SET NULL,
    level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug','info','warn','error')),
    message TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`CREATE INDEX IF NOT EXISTS idx_loom_runs_workflow ON loom_runs(workflow_id)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_loom_runs_status ON loom_runs(status)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_loom_steps_run ON loom_steps(run_id)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_loom_steps_status ON loom_steps(status)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_loom_run_logs_run ON loom_run_logs(run_id)`);
migrate(`ALTER TABLE loom_workflows ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
migrate(`ALTER TABLE loom_runs ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
migrate(`CREATE INDEX IF NOT EXISTS idx_loom_workflows_user ON loom_workflows(user_id)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_loom_runs_user ON loom_runs(user_id)`);

// - Prepared statements --

export const insertWorkflow = db.prepare(
  "INSERT INTO loom_workflows (name, description, steps, user_id) VALUES (?, ?, ?, ?)"
);

export const getWorkflowById = db.prepare("SELECT * FROM loom_workflows WHERE id = ? AND user_id = ?");

export const getWorkflowByNameStmt = db.prepare("SELECT * FROM loom_workflows WHERE name = ? AND user_id = ?");

export const listWorkflowsStmt = db.prepare("SELECT * FROM loom_workflows WHERE user_id = ? ORDER BY created_at DESC");

export const deleteWorkflowStmt = db.prepare("DELETE FROM loom_workflows WHERE id = ? AND user_id = ?");

export const insertRun = db.prepare(
  "INSERT INTO loom_runs (workflow_id, status, input, user_id) VALUES (?, ?, ?, ?)"
);

export const getRunById = db.prepare("SELECT * FROM loom_runs WHERE id = ? AND user_id = ?");

export const insertStep = db.prepare(
  `INSERT INTO loom_steps (run_id, name, type, config, depends_on, max_retries, timeout_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

export const getStepById = db.prepare("SELECT * FROM loom_steps WHERE id = ?");

export const insertRunLog = db.prepare(
  "INSERT INTO loom_run_logs (run_id, step_id, level, message, data) VALUES (?, ?, ?, ?, ?)"
);

export const workflowCount = db.prepare("SELECT COUNT(*) as count FROM loom_workflows");
export const runCount = db.prepare("SELECT COUNT(*) as count FROM loom_runs");
export const activeRunCount = db.prepare(
  "SELECT COUNT(*) as count FROM loom_runs WHERE status IN ('pending','running','paused')"
);
export const stepCount = db.prepare("SELECT COUNT(*) as count FROM loom_steps");
