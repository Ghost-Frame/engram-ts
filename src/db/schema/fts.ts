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
  // memories FTS (created with db.exec in original -- part of initial schema block)
  db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    category,
    source,
    content='memories',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, category, source)
    VALUES (new.id, new.content, new.category, new.source);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category, source)
    VALUES ('delete', old.id, old.content, old.category, old.source);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category, source)
    VALUES ('delete', old.id, old.content, old.category, old.source);
    INSERT INTO memories_fts(rowid, content, category, source)
    VALUES (new.id, new.content, new.category, new.source);
  END;
`);

  // Cross-tenant link trigger (memory_links is created in base.ts before fts.ts runs)
  migrate(db, `
  CREATE TRIGGER IF NOT EXISTS prevent_cross_tenant_links
  BEFORE INSERT ON memory_links
  BEGIN
    SELECT CASE
      WHEN (SELECT user_id FROM memories WHERE id = NEW.source_id) !=
           (SELECT user_id FROM memories WHERE id = NEW.target_id)
      THEN RAISE(ABORT, 'Cross-tenant memory link rejected')
    END;
  END;
`);
}
