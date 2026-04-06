import Database from 'libsql';

type DB = InstanceType<typeof Database>;
import { log } from '../../config/logger.ts';
import { EMBEDDING_DIM } from '../../config/index.ts';

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
  const VECTOR_COL = `embedding_vec_${EMBEDDING_DIM}`;

  // v5.8 - Agent Identity & Trust
  migrate(db, `
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT,
    description TEXT,
    code_hash TEXT,
    trust_score REAL NOT NULL DEFAULT 50,
    total_ops INTEGER NOT NULL DEFAULT 0,
    successful_ops INTEGER NOT NULL DEFAULT 0,
    failed_ops INTEGER NOT NULL DEFAULT 0,
    guard_allows INTEGER NOT NULL DEFAULT 0,
    guard_warns INTEGER NOT NULL DEFAULT 0,
    guard_blocks INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    revoked_at TEXT,
    revoke_reason TEXT,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
  CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(is_active);
`);

  // Webhooks table
  migrate(db, `
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '["*"]',
      secret TEXT,
      user_id INTEGER DEFAULT 1,
      active BOOLEAN NOT NULL DEFAULT 1,
      last_triggered_at TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);
  `);

  // Rate limits
  migrate(db, `
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL DEFAULT (datetime('now')),
    window_seconds INTEGER NOT NULL DEFAULT 60
  );
  CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
`);

  // Tenant quotas
  migrate(db, `
  CREATE TABLE IF NOT EXISTS tenant_quotas (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_memories INTEGER DEFAULT 10000,
    max_conversations INTEGER DEFAULT 1000,
    max_api_keys INTEGER DEFAULT 10,
    max_spaces INTEGER DEFAULT 5,
    max_memory_size_bytes INTEGER DEFAULT 102400,
    rate_limit_override INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

  // Usage events
  migrate(db, `
  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_usage_user_type ON usage_events(user_id, event_type, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
`);

  // v6.0 - Skills registry
  migrate(db, `
  CREATE TABLE IF NOT EXISTS skill_records (
    skill_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'workflow',
    origin TEXT NOT NULL DEFAULT 'imported',
    generation INTEGER NOT NULL DEFAULT 0,
    lineage_change_summary TEXT,
    creator_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    total_selections INTEGER NOT NULL DEFAULT 0,
    total_applied INTEGER NOT NULL DEFAULT 0,
    total_completions INTEGER NOT NULL DEFAULT 0,
    embedding BLOB,
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_updated TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

  migrate(db, `ALTER TABLE skill_records ADD COLUMN ${VECTOR_COL} FLOAT32(${EMBEDDING_DIM})`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_skill_records_vec ON skill_records(libsql_vector_idx(${VECTOR_COL}))`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_skill_records_name ON skill_records(name)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_skill_records_category ON skill_records(category)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_skill_records_active ON skill_records(is_active) WHERE is_active = 1`);

  migrate(db, `
  CREATE TABLE IF NOT EXISTS skill_lineage_parents (
    skill_id TEXT NOT NULL REFERENCES skill_records(skill_id) ON DELETE CASCADE,
    parent_skill_id TEXT NOT NULL,
    PRIMARY KEY (skill_id, parent_skill_id)
  )
`);

  migrate(db, `
  CREATE TABLE IF NOT EXISTS skill_tags (
    skill_id TEXT NOT NULL REFERENCES skill_records(skill_id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (skill_id, tag)
  )
`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_skill_tags_tag ON skill_tags(tag)`);

  // skills FTS (skill_records table now exists)
  migrate(db, `
  CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
    name, description, content,
    content='skill_records',
    content_rowid='rowid',
    tokenize='porter unicode61'
  )
`);
  migrate(db, `CREATE TRIGGER IF NOT EXISTS skills_fts_ai AFTER INSERT ON skill_records BEGIN
  INSERT INTO skills_fts(rowid, name, description, content)
  VALUES (new.rowid, new.name, new.description, new.content);
END`);
  migrate(db, `CREATE TRIGGER IF NOT EXISTS skills_fts_ad AFTER DELETE ON skill_records BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, content)
  VALUES ('delete', old.rowid, old.name, old.description, old.content);
END`);
  migrate(db, `CREATE TRIGGER IF NOT EXISTS skills_fts_au AFTER UPDATE ON skill_records BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, content)
  VALUES ('delete', old.rowid, old.name, old.description, old.content);
  INSERT INTO skills_fts(rowid, name, description, content)
  VALUES (new.rowid, new.name, new.description, new.content);
END`);

  // v6.1 - Execution analyses
  migrate(db, `
  CREATE TABLE IF NOT EXISTS execution_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL UNIQUE,
    timestamp TEXT NOT NULL,
    task_completed INTEGER NOT NULL DEFAULT 0,
    execution_note TEXT NOT NULL DEFAULT '',
    tool_issues TEXT NOT NULL DEFAULT '[]',
    candidate_for_evolution INTEGER NOT NULL DEFAULT 0,
    evolution_suggestions TEXT NOT NULL DEFAULT '[]',
    analyzed_by TEXT NOT NULL DEFAULT '',
    analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_exec_analyses_task ON execution_analyses(task_id)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_exec_analyses_candidate ON execution_analyses(candidate_for_evolution) WHERE candidate_for_evolution = 1`);

  // v6.1 - Per-skill judgments
  migrate(db, `
  CREATE TABLE IF NOT EXISTS skill_judgments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id INTEGER NOT NULL REFERENCES execution_analyses(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL,
    skill_applied INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    UNIQUE(analysis_id, skill_id)
  )
`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_skill_judgments_skill ON skill_judgments(skill_id)`);

  // v6.1 - Tool dependencies per skill
  migrate(db, `
  CREATE TABLE IF NOT EXISTS skill_tool_deps (
    skill_id TEXT NOT NULL REFERENCES skill_records(skill_id) ON DELETE CASCADE,
    tool_key TEXT NOT NULL,
    critical INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (skill_id, tool_key)
  )
`);

  // v6.1 - Tool quality tracking
  migrate(db, `
  CREATE TABLE IF NOT EXISTS tool_quality_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_key TEXT NOT NULL UNIQUE,
    backend TEXT NOT NULL DEFAULT '',
    server TEXT NOT NULL DEFAULT 'default',
    tool_name TEXT NOT NULL DEFAULT '',
    description_hash TEXT NOT NULL DEFAULT '',
    total_calls INTEGER NOT NULL DEFAULT 0,
    total_successes INTEGER NOT NULL DEFAULT 0,
    total_failures INTEGER NOT NULL DEFAULT 0,
    avg_execution_ms REAL NOT NULL DEFAULT 0,
    llm_flagged_count INTEGER NOT NULL DEFAULT 0,
    quality_score REAL NOT NULL DEFAULT 1.0,
    last_execution_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_tool_quality_score ON tool_quality_records(quality_score)`);

  // v5.12 - Artifact storage
  migrate(db, `CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_mode TEXT NOT NULL DEFAULT 'inline',
  data BLOB,
  disk_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_artifacts_memory ON artifacts(memory_id)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(sha256)`);

  // artifacts FTS (artifacts table now exists)
  migrate(db, `CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  content,
  tokenize='porter unicode61'
)`);
}


