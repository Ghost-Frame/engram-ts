// ============================================================================
// WEBHOOKS DOMAIN - Database prepared statements
// ============================================================================

import { db } from "../db/connection.ts";

export const insertWebhook = db.prepare(
  `INSERT INTO webhooks (url, events, secret, user_id) VALUES (?, ?, ?, ?) RETURNING id, created_at`
);

export const listWebhooks = db.prepare(
  `SELECT id, url, events, active, last_triggered_at, failure_count, created_at
   FROM webhooks WHERE user_id = ? ORDER BY created_at DESC`
);

export const deleteWebhook = db.prepare(
  `DELETE FROM webhooks WHERE id = ? AND user_id = ?`
);

export const getChangesSince = db.prepare(
  `SELECT id, content, category, source, session_id, importance, tags, confidence,
     sync_id, is_static, is_forgotten, is_archived, version, created_at, updated_at
   FROM memories WHERE updated_at > ? AND user_id = ?
   ORDER BY updated_at ASC LIMIT ?`
);

export const getMemoryBySyncId = db.prepare(
  `SELECT id, updated_at FROM memories WHERE sync_id = ? AND user_id = ?`
);
