import Database from 'libsql';

type DB = InstanceType<typeof Database>;
import { log } from '../../config/logger.ts';

function migrate(db: DB, sql: string): void {
  try {
    db.exec(sql);
  } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.warn({ msg: "migration_error", sql: sql.slice(0, 120), error: msg });
  }
}

export function register(db: DB): void {
  // Causal chains
  migrate(db, `
  CREATE TABLE IF NOT EXISTS causal_chains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    user_id INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cc_user ON causal_chains(user_id);
`);

  migrate(db, `
  CREATE TABLE IF NOT EXISTS causal_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id INTEGER NOT NULL REFERENCES causal_chains(id) ON DELETE CASCADE,
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'event',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(chain_id, memory_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cl_chain ON causal_links(chain_id);
  CREATE INDEX IF NOT EXISTS idx_cl_memory ON causal_links(memory_id);
`);

  // Reconsolidation tracking
  migrate(db, `
  CREATE TABLE IF NOT EXISTS reconsolidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    old_importance INTEGER,
    new_importance INTEGER,
    old_confidence REAL,
    new_confidence REAL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_recon_memory ON reconsolidations(memory_id);
`);

  // Temporal patterns
  migrate(db, `
  CREATE TABLE IF NOT EXISTS temporal_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    day_of_week INTEGER NOT NULL,
    hour_of_day INTEGER NOT NULL,
    category TEXT,
    project_id INTEGER,
    access_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(user_id, day_of_week, hour_of_day, category, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tp_user ON temporal_patterns(user_id, day_of_week, hour_of_day);
`);
}
