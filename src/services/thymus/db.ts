// ============================================================================
// Thymus DB — Schema + prepared statements
// Migrations run at module scope so tables exist before statements compile.
// ============================================================================

import { db } from "../../db/index.ts";
import { log } from "../../config/logger.ts";

// -- Schema (module-scope migration) --

function migrate(sql: string) {
  try { db.exec(sql); } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.warn({ msg: "thymus_migrate_error", error: msg });
  }
}

migrate(`
  CREATE TABLE IF NOT EXISTS rubrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    criteria TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rubric_id INTEGER NOT NULL REFERENCES rubrics(id),
    agent TEXT NOT NULL,
    subject TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    output TEXT NOT NULL DEFAULT '{}',
    scores TEXT NOT NULL DEFAULT '{}',
    overall_score REAL NOT NULL,
    notes TEXT,
    evaluator TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS quality_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    tags TEXT NOT NULL DEFAULT '{}',
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`CREATE INDEX IF NOT EXISTS idx_evaluations_agent_created ON evaluations(agent, created_at DESC)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_evaluations_rubric_created ON evaluations(rubric_id, created_at DESC)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_quality_metrics_agent_metric ON quality_metrics(agent, metric, recorded_at DESC)`);

// -- Prepared statements --

export const insertRubric = db.prepare(
  "INSERT INTO rubrics (name, description, criteria) VALUES (?, ?, ?)"
);

export const getRubricById = db.prepare("SELECT * FROM rubrics WHERE id = ?");
export const getRubricByName = db.prepare("SELECT * FROM rubrics WHERE name = ?");
export const listRubricsStmt = db.prepare("SELECT * FROM rubrics ORDER BY id DESC");

export const deleteRubricStmt = db.prepare("DELETE FROM rubrics WHERE id = ?");

export const insertEvaluation = db.prepare(
  "INSERT INTO evaluations (rubric_id, agent, subject, input, output, scores, overall_score, notes, evaluator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
);

export const getEvaluationById = db.prepare("SELECT * FROM evaluations WHERE id = ?");

export const insertMetric = db.prepare(
  "INSERT INTO quality_metrics (agent, metric, value, tags) VALUES (?, ?, ?, ?)"
);

export const getMetricById = db.prepare("SELECT * FROM quality_metrics WHERE id = ?");

export const rubricCount = db.prepare("SELECT COUNT(*) as count FROM rubrics");
export const evaluationCount = db.prepare("SELECT COUNT(*) as count FROM evaluations");
export const metricCount = db.prepare("SELECT COUNT(*) as count FROM quality_metrics");
