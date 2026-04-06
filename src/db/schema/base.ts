import Database from 'libsql';
import { DEFAULT_RATE_LIMIT } from '../../config/index.ts';
import { log } from '../../config/logger.ts';

type DB = InstanceType<typeof Database>;

export function register(db: DB): void {
  // memories table (original schema)
  db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    source TEXT NOT NULL DEFAULT 'unknown',
    session_id TEXT,
    importance INTEGER NOT NULL DEFAULT 5,
    embedding BLOB,
    version INTEGER NOT NULL DEFAULT 1,
    is_latest BOOLEAN NOT NULL DEFAULT 1,
    parent_memory_id INTEGER REFERENCES memories(id),
    root_memory_id INTEGER REFERENCES memories(id),
    source_count INTEGER NOT NULL DEFAULT 1,
    is_static BOOLEAN NOT NULL DEFAULT 0,
    is_forgotten BOOLEAN NOT NULL DEFAULT 0,
    forget_after TEXT,
    forget_reason TEXT,
    is_inference BOOLEAN NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

  // users, api_keys, spaces (v4 multi-tenant)
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'admin',
    is_admin BOOLEAN NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'default',
    scopes TEXT NOT NULL DEFAULT 'read,write',
    rate_limit INTEGER NOT NULL DEFAULT ${DEFAULT_RATE_LIMIT},
    is_active BOOLEAN NOT NULL DEFAULT 1,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
  CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

  CREATE TABLE IF NOT EXISTS spaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_spaces_user ON spaces(user_id);
`);

  // memory_links table
  db.exec(`
  CREATE TABLE IF NOT EXISTS memory_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    similarity REAL NOT NULL,
    type TEXT NOT NULL DEFAULT 'similarity',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, target_id, type)
  );
  CREATE INDEX IF NOT EXISTS idx_links_source ON memory_links(source_id);
  CREATE INDEX IF NOT EXISTS idx_links_target ON memory_links(target_id);
`);

  // audit_log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      details TEXT,
      ip TEXT,
      request_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Default user and space (backwards compat)
  const defaultUser = db.prepare("SELECT id FROM users WHERE id = 1").get();
  if (!defaultUser) {
    db.exec("INSERT INTO users (id, username, is_admin) VALUES (1, 'owner', 1)");
    log.info({ msg: "created_default_user", id: 1 });
  }

  const defaultSpace = db.prepare("SELECT id FROM spaces WHERE user_id = 1 AND name = 'default'").get();
  if (!defaultSpace) {
    db.exec("INSERT INTO spaces (user_id, name, description) VALUES (1, 'default', 'Default memory space')");
    log.info({ msg: "created_default_space" });
  }
}
