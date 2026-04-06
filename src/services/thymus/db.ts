// ============================================================================
// Thymus DB - Schema + prepared statements
// Migrations run at module scope so tables exist before statements compile.
// ============================================================================

import { db } from "../../db/index.ts";
import { log } from "../../config/logger.ts";

// - Schema (module-scope migration) --

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

migrate(`ALTER TABLE rubrics ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
migrate(`ALTER TABLE evaluations ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
migrate(`ALTER TABLE quality_metrics ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
migrate(`CREATE INDEX IF NOT EXISTS idx_rubrics_user ON rubrics(user_id)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_evaluations_user ON evaluations(user_id)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_quality_metrics_user ON quality_metrics(user_id)`);
migrate(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rubrics_user_name ON rubrics(user_id, name)`);

// Session quality snapshots
migrate(`CREATE TABLE IF NOT EXISTS session_quality (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  turn_count INTEGER DEFAULT 0,
  rules_followed TEXT DEFAULT '[]',
  rules_drifted TEXT DEFAULT '[]',
  personality_score REAL,
  rule_compliance_rate REAL,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// Behavioral drift events
migrate(`CREATE TABLE IF NOT EXISTS behavioral_drift_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  session_id TEXT,
  drift_type TEXT NOT NULL,
  severity TEXT DEFAULT 'low',
  signal TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// - Prepared statements --

export const insertRubric = db.prepare(
  "INSERT INTO rubrics (name, description, criteria, user_id) VALUES (?, ?, ?, ?)"
);

export const getRubricById = db.prepare("SELECT * FROM rubrics WHERE id = ?");
export const getRubricByName = db.prepare("SELECT * FROM rubrics WHERE name = ?");
export const listRubricsStmt = db.prepare("SELECT * FROM rubrics WHERE user_id = ? ORDER BY id DESC");

export const deleteRubricStmt = db.prepare("DELETE FROM rubrics WHERE id = ? AND user_id = ?");

export const insertEvaluation = db.prepare(
  "INSERT INTO evaluations (rubric_id, agent, subject, input, output, scores, overall_score, notes, evaluator, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);

export const getEvaluationById = db.prepare("SELECT * FROM evaluations WHERE id = ?");

export const insertMetric = db.prepare(
  "INSERT INTO quality_metrics (agent, metric, value, tags, user_id) VALUES (?, ?, ?, ?, ?)"
);

export const getMetricById = db.prepare("SELECT * FROM quality_metrics WHERE id = ?");

export const rubricCount = db.prepare("SELECT COUNT(*) as count FROM rubrics");
export const evaluationCount = db.prepare("SELECT COUNT(*) as count FROM evaluations");
export const metricCount = db.prepare("SELECT COUNT(*) as count FROM quality_metrics");

// Session quality statements
export const insertSessionQuality = db.prepare(`
  INSERT INTO session_quality (session_id, agent, turn_count, rules_followed, rules_drifted, personality_score, rule_compliance_rate)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export const getSessionQualityByAgent = db.prepare(`
  SELECT * FROM session_quality WHERE agent = ? ORDER BY created_at DESC LIMIT ?
`);

export const getSessionQualitySince = db.prepare(`
  SELECT * FROM session_quality WHERE agent = ? AND created_at >= ? ORDER BY created_at DESC
`);

// Drift event statements
export const insertDriftEvent = db.prepare(`
  INSERT INTO behavioral_drift_events (agent, session_id, drift_type, severity, signal)
  VALUES (?, ?, ?, ?, ?)
`);

export const getDriftEventsByAgent = db.prepare(`
  SELECT * FROM behavioral_drift_events WHERE agent = ? ORDER BY created_at DESC LIMIT ?
`);

export const getDriftSummary = db.prepare(`
  SELECT drift_type, severity, COUNT(*) as count
  FROM behavioral_drift_events
  WHERE agent = ?
  GROUP BY drift_type, severity
  ORDER BY count DESC
`);
