// ============================================================================
// Soma DB - Schema + prepared statements for agent registry
// Migrations run at module scope so tables exist before statements compile.
// ============================================================================

import { db } from "../../db/index.ts";
import { log } from "../../config/logger.ts";

// - Schema (module-scope migration) --

function migrate(sql: string) {
  try { db.exec(sql); } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.warn({ msg: "soma_migrate_error", error: msg });
  }
}

migrate(`
  CREATE TABLE IF NOT EXISTS soma_agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    capabilities TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','online','offline','error')),
    config TEXT NOT NULL DEFAULT '{}',
    heartbeat_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS soma_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS soma_agent_groups (
    agent_id INTEGER NOT NULL REFERENCES soma_agents(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES soma_groups(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(agent_id, group_id)
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS soma_agent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES soma_agents(id) ON DELETE CASCADE,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`CREATE INDEX IF NOT EXISTS idx_soma_agents_type ON soma_agents(type)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_soma_agents_status ON soma_agents(status)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_soma_agent_logs_agent_created ON soma_agent_logs(agent_id, created_at)`);

// Add drift tracking columns to soma_agents
try { db.exec(`ALTER TABLE soma_agents ADD COLUMN quality_score REAL`); } catch {}
try { db.exec(`ALTER TABLE soma_agents ADD COLUMN drift_flags TEXT DEFAULT '[]'`); } catch {}

migrate(`ALTER TABLE soma_agents ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
migrate(`ALTER TABLE soma_groups ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
// Recreate soma_agents to drop global UNIQUE(name) -- now (user_id, name) is unique
try {
  const hasGlobalUnique = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='soma_agents'"
  ).get() as { sql: string } | undefined;
  if (hasGlobalUnique?.sql?.includes("name TEXT NOT NULL UNIQUE")) {
    db.exec(`
      CREATE TABLE soma_agents_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','online','offline','error')),
        config TEXT NOT NULL DEFAULT '{}',
        heartbeat_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        quality_score REAL,
        drift_flags TEXT DEFAULT '[]',
        user_id INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO soma_agents_new SELECT id, name, type, description, capabilities, status, config, heartbeat_at, created_at, updated_at, quality_score, drift_flags, user_id FROM soma_agents;
      DROP TABLE soma_agents;
      ALTER TABLE soma_agents_new RENAME TO soma_agents;
    `);
    log.info({ msg: "soma_agents_recreated", reason: "dropped global UNIQUE(name), now per-tenant" });
  }
} catch (e: any) {
  log.warn({ msg: "soma_agents_recreate_error", error: String(e) });
}
migrate(`CREATE INDEX IF NOT EXISTS idx_soma_agents_user ON soma_agents(user_id)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_soma_groups_user ON soma_groups(user_id)`);
migrate(`CREATE UNIQUE INDEX IF NOT EXISTS idx_soma_agents_user_name ON soma_agents(user_id, name)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_soma_agents_type ON soma_agents(type)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_soma_agents_status ON soma_agents(status)`);

// - Prepared statements --

export const insertAgent = db.prepare(
  "INSERT INTO soma_agents (name, type, description, capabilities, config, user_id) VALUES (?, ?, ?, ?, ?, ?)"
);
export const getAgentById = db.prepare("SELECT * FROM soma_agents WHERE id = ? AND user_id = ?");
export const getAgentByNameStmt = db.prepare("SELECT * FROM soma_agents WHERE name = ? AND user_id = ?");
export const deleteAgentStmt = db.prepare("DELETE FROM soma_agents WHERE id = ? AND user_id = ?");

export const insertGroupStmt = db.prepare("INSERT INTO soma_groups (name, description, user_id) VALUES (?, ?, ?)");
export const getGroupById = db.prepare("SELECT * FROM soma_groups WHERE id = ? AND user_id = ?");
export const listGroupsStmt = db.prepare("SELECT * FROM soma_groups WHERE user_id = ? ORDER BY id DESC");
export const deleteGroupStmt = db.prepare("DELETE FROM soma_groups WHERE id = ? AND user_id = ?");

export const addToGroupStmt = db.prepare(
  "INSERT OR IGNORE INTO soma_agent_groups (agent_id, group_id) VALUES (?, ?)"
);
export const removeFromGroupStmt = db.prepare(
  "DELETE FROM soma_agent_groups WHERE agent_id = ? AND group_id = ?"
);
export const deleteGroupMemberships = db.prepare("DELETE FROM soma_agent_groups WHERE group_id = ?");
export const deleteAgentMemberships = db.prepare("DELETE FROM soma_agent_groups WHERE agent_id = ?");
export const deleteAgentLogs = db.prepare("DELETE FROM soma_agent_logs WHERE agent_id = ?");

export const insertLog = db.prepare(
  "INSERT INTO soma_agent_logs (agent_id, level, message, data) VALUES (?, ?, ?, ?)"
);
export const getLogById = db.prepare("SELECT * FROM soma_agent_logs WHERE id = ?");

export const agentCount = db.prepare("SELECT COUNT(*) as count FROM soma_agents");
export const onlineCount = db.prepare("SELECT COUNT(*) as count FROM soma_agents WHERE status = 'online'");
export const groupCount = db.prepare("SELECT COUNT(*) as count FROM soma_groups");

export const updateAgentQuality = db.prepare(`
  UPDATE soma_agents SET quality_score = ?, drift_flags = ? WHERE id = ? AND user_id = ?
`);
