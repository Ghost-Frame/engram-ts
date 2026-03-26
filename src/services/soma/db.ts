// ============================================================================
// Soma DB -- Schema + prepared statements for agent registry
// Migrations run at module scope so tables exist before statements compile.
// ============================================================================

import { db } from "../../db/index.ts";
import { log } from "../../config/logger.ts";

// -- Schema (module-scope migration) --

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
    name TEXT NOT NULL UNIQUE,
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
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS soma_agent_groups (
    agent_id INTEGER NOT NULL REFERENCES soma_agents(id),
    group_id INTEGER NOT NULL REFERENCES soma_groups(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(agent_id, group_id)
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS soma_agent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES soma_agents(id),
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`CREATE INDEX IF NOT EXISTS idx_soma_agents_type ON soma_agents(type)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_soma_agents_status ON soma_agents(status)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_soma_agent_logs_agent_created ON soma_agent_logs(agent_id, created_at)`);

// -- Prepared statements --

export const insertAgent = db.prepare(
  "INSERT INTO soma_agents (name, type, description, capabilities, config) VALUES (?, ?, ?, ?, ?)"
);
export const getAgentById = db.prepare("SELECT * FROM soma_agents WHERE id = ?");
export const getAgentByNameStmt = db.prepare("SELECT * FROM soma_agents WHERE name = ?");
export const deleteAgentStmt = db.prepare("DELETE FROM soma_agents WHERE id = ?");

export const insertGroupStmt = db.prepare("INSERT INTO soma_groups (name, description) VALUES (?, ?)");
export const getGroupById = db.prepare("SELECT * FROM soma_groups WHERE id = ?");
export const listGroupsStmt = db.prepare("SELECT * FROM soma_groups ORDER BY id DESC");
export const deleteGroupStmt = db.prepare("DELETE FROM soma_groups WHERE id = ?");

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
