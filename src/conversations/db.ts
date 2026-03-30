// ============================================================================
// CONVERSATIONS DOMAIN -- Prepared statements
// ============================================================================

import { db } from "../db/connection.ts";

// --- Conversations ---

export const insertConversation = db.prepare(
  `INSERT INTO conversations (agent, session_id, title, metadata, user_id) VALUES (?, ?, ?, ?, ?) RETURNING id, started_at`
);

export const updateConversation = db.prepare(
  `UPDATE conversations SET title = COALESCE(?, title), metadata = COALESCE(?, metadata), updated_at = datetime('now') WHERE id = ? AND user_id = ?`
);

export const getConversation = db.prepare(
  `SELECT * FROM conversations WHERE id = ?`
);

export const getConversationForUser = db.prepare(
  `SELECT * FROM conversations WHERE id = ? AND user_id = ?`
);

export const getConversationBySession = db.prepare(
  `SELECT * FROM conversations WHERE agent = ? AND session_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT 1`
);

export const listConversations = db.prepare(
  `SELECT c.id, c.agent, c.session_id, c.title, c.metadata, c.started_at, c.updated_at,
     (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
   FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC LIMIT ?`
);

export const listConversationsByAgent = db.prepare(
  `SELECT c.id, c.agent, c.session_id, c.title, c.metadata, c.started_at, c.updated_at,
     (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
   FROM conversations c WHERE c.user_id = ? AND c.agent = ? ORDER BY c.updated_at DESC LIMIT ?`
);

export const deleteConversation = db.prepare(
  `DELETE FROM conversations WHERE id = ? AND user_id = ?`
);

export const touchConversation = db.prepare(
  `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
);

// --- Messages ---

export const insertMessage = db.prepare(
  `INSERT INTO messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?) RETURNING id, created_at`
);

export const getMessages = db.prepare(
  `SELECT id, role, content, metadata, created_at FROM messages
   WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`
);

export const searchMessages = db.prepare(
  `SELECT m.id, m.conversation_id, m.role, m.content, m.metadata, m.created_at,
     c.agent, c.title as conv_title
   FROM messages_fts f
   JOIN messages m ON f.rowid = m.id
   JOIN conversations c ON m.conversation_id = c.id
   WHERE messages_fts MATCH ? AND c.user_id = ?
   ORDER BY m.created_at DESC
   LIMIT ?`
);

// --- Transaction helpers (not exported -- internal to bulkInsertConvo) ---

const insertConversationTx = db.prepare(
  `INSERT INTO conversations (agent, session_id, title, metadata, user_id) VALUES (?, ?, ?, ?, ?)`
);

const insertMessageTx = db.prepare(
  `INSERT INTO messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?)`
);

const getLastRowId = db.prepare(`SELECT last_insert_rowid() as id`);

// --- Bulk insert transaction ---

export const bulkInsertConvo = db.transaction(
  (agent: string, sessionId: string | null, title: string | null, metadata: string | null, userId: number,
   msgs: Array<{ role: string; content: string; metadata?: string | null }>) => {
    insertConversationTx.run(agent, sessionId, title, metadata, userId);
    const { id } = getLastRowId.get() as { id: number };
    for (const msg of msgs) {
      insertMessageTx.run(id, msg.role, msg.content, msg.metadata || null);
    }
    const conv = getConversation.get(id) as { id: number; started_at: string };
    return conv;
  }
);
