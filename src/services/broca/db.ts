// ============================================================================
// Broca DB -- Schema + prepared statements
// Migrations run at module scope so tables exist before statements compile.
// ============================================================================

import { db } from "../../db/index.ts";
import { log } from "../../config/logger.ts";

// -- Schema (module-scope migration) --

function migrate(sql: string) {
  try { db.exec(sql); } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.warn({ msg: "broca_migrate_error", error: msg });
  }
}

migrate(`
  CREATE TABLE IF NOT EXISTS broca_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    service TEXT NOT NULL,
    action TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    narrative TEXT,
    axon_event_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`CREATE INDEX IF NOT EXISTS idx_broca_actions_agent ON broca_actions(agent, created_at DESC)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_broca_actions_service ON broca_actions(service, created_at DESC)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_broca_actions_action ON broca_actions(action, created_at DESC)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_broca_actions_created ON broca_actions(created_at DESC)`);

// -- Prepared statements --

export const insertAction = db.prepare(
  "INSERT INTO broca_actions (agent, service, action, payload, narrative, axon_event_id) VALUES (?, ?, ?, ?, ?, ?)"
);

export const getActionById = db.prepare("SELECT * FROM broca_actions WHERE id = ?");

export const actionCount = db.prepare("SELECT COUNT(*) as count FROM broca_actions");

export const narratedCount = db.prepare(
  "SELECT COUNT(*) as count FROM broca_actions WHERE narrative IS NOT NULL"
);
