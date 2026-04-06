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
  // Episodes table
  migrate(db, `
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      session_id TEXT,
      agent TEXT,
      summary TEXT,
      user_id INTEGER DEFAULT 1,
      memory_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
    CREATE INDEX IF NOT EXISTS idx_episodes_user ON episodes(user_id);
    CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agent);
  `);

  // episodes FTS (episodes table now exists)
  migrate(db, `CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  title, summary, content='episodes', content_rowid='id',
  tokenize='porter unicode61'
)`);
  migrate(db, `CREATE TRIGGER IF NOT EXISTS episodes_fts_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END`);
  migrate(db, `CREATE TRIGGER IF NOT EXISTS episodes_fts_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
END`);
  migrate(db, `CREATE TRIGGER IF NOT EXISTS episodes_fts_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
  INSERT INTO episodes_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END`);

  // Conversations and messages tables
  db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    session_id TEXT,
    title TEXT,
    metadata TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent);
  CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id);
  CREATE INDEX IF NOT EXISTS idx_conv_started ON conversations(started_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
`);

  // messages FTS (messages table now exists)
  db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    role,
    content='messages',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, role)
    VALUES (new.id, new.content, new.role);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, role)
    VALUES ('delete', old.id, old.content, old.role);
  END;
`);
}
