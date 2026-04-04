// ============================================================================
// AGENTS DOMAIN - Database prepared statements
// ============================================================================

import { db } from "../db/connection.ts";

export const insertAgent = db.prepare(
  `INSERT INTO agents (user_id, name, category, description, code_hash) VALUES (?, ?, ?, ?, ?) RETURNING id, trust_score, created_at`
);

export const getAgentById = db.prepare(
  `SELECT * FROM agents WHERE id = ? AND user_id = ?`
);

export const getAgentByName = db.prepare(
  `SELECT * FROM agents WHERE name = ? AND user_id = ?`
);

export const listAgents = db.prepare(
  `SELECT id, name, category, description, trust_score, total_ops, successful_ops, failed_ops, guard_allows, guard_warns, guard_blocks, is_active, last_seen_at, created_at FROM agents WHERE user_id = ? ORDER BY created_at DESC`
);

export const revokeAgent = db.prepare(
  `UPDATE agents SET is_active = 0, revoked_at = datetime('now'), revoke_reason = ?, trust_score = 0 WHERE id = ? AND user_id = ?`
);

export const linkKeyToAgent = db.prepare(
  `UPDATE api_keys SET agent_id = ? WHERE id = ? AND user_id = ?`
);

export const getAgentExecutions = db.prepare(
  `SELECT id, action, target_type, target_id, details, execution_hash, signature, created_at FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`
);
