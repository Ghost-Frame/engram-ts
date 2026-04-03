// ============================================================================
// DATABASE CONNECTION — Schema, migrations, write lock
// ============================================================================

import Database from 'libsql';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { log, opsCounters } from '../config/logger.ts';
import { DB_PATH, DATA_DIR, DEFAULT_RATE_LIMIT, DEFAULT_IMPORTANCE, EMBEDDING_DIM } from '../config/index.ts';

export function embeddingToVectorJSON(emb: Float32Array): string {
  if (emb.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding length ${emb.length} !== expected ${EMBEDDING_DIM}`);
  }
  for (let i = 0; i < emb.length; i++) {
    if (!Number.isFinite(emb[i])) {
      throw new Error(`Invalid embedding value at index ${i}: ${emb[i]}`);
    }
  }
  return "[" + Array.from(emb).join(",") + "]";
}

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous=NORMAL');    // NORMAL is safe for WAL mode (fsync on checkpoint)
db.exec('PRAGMA foreign_keys=ON');
db.exec('PRAGMA busy_timeout=5000');
db.exec('PRAGMA wal_autocheckpoint=1000'); // Auto-checkpoint every 1000 pages (~4MB)

// Startup integrity check (quick_check is fast, catches most corruption)
try {
  const result = db.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
  if (result && result.quick_check !== 'ok') {
    log.error({ msg: "db_integrity_check_failed", result: result.quick_check });
  }
} catch (e: any) {
  log.error({ msg: "db_integrity_check_error", error: e.message });
}


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

// Migration helper - logs unexpected errors instead of swallowing them silently
// Schema version tracking
db.exec("CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')), description TEXT)");

function _getSchemaVersion(): number {
  try {
    const row = db.prepare("SELECT MAX(version) as v FROM schema_versions").get() as { v: number | null };
    return row?.v || 0;
  } catch { return 0; }
}

function setSchemaVersion(version: number, description: string): void {
  db.prepare("INSERT OR IGNORE INTO schema_versions (version, description) VALUES (?, ?)").run(version, description);
}

export function migrate(sql: string) {
  try {
    db.exec(sql);
  } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.warn({ msg: "migration_error", sql: sql.slice(0, 120), error: msg });
  }
}

// Critical migrations that must succeed or block startup
function migrateCritical(sql: string, description: string) {
  try {
    db.exec(sql);
  } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.error({ msg: "critical_migration_failed", description, sql: sql.slice(0, 120), error: msg });
    throw new Error(`Critical migration failed: ${description} -- ${msg}`);
  }
}

// v2 -> v3 migrations (safe to re-run)
const v3Columns: [string, string][] = [
  ["version", "INTEGER NOT NULL DEFAULT 1"],
  ["is_latest", "BOOLEAN NOT NULL DEFAULT 1"],
  ["parent_memory_id", "INTEGER"],
  ["root_memory_id", "INTEGER"],
  ["source_count", "INTEGER NOT NULL DEFAULT 1"],
  ["is_static", "BOOLEAN NOT NULL DEFAULT 0"],
  ["is_forgotten", "BOOLEAN NOT NULL DEFAULT 0"],
  ["forget_after", "TEXT"],
  ["forget_reason", "TEXT"],
  ["is_inference", "BOOLEAN NOT NULL DEFAULT 0"],
  ["is_archived", "BOOLEAN NOT NULL DEFAULT 0"],
];
for (const [col, def] of v3Columns) {
  migrate(`ALTER TABLE memories ADD COLUMN ${col} ${def}`);
}
migrate("ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 5");
migrate("ALTER TABLE memories ADD COLUMN model TEXT");
migrate("ALTER TABLE memories ADD COLUMN embedding BLOB");

// Columns referenced by prepared statements -- must run before they're compiled
migrate("ALTER TABLE memories ADD COLUMN recall_hits INTEGER NOT NULL DEFAULT 0");
migrate("ALTER TABLE memories ADD COLUMN recall_misses INTEGER NOT NULL DEFAULT 0");
migrate("ALTER TABLE memories ADD COLUMN adaptive_score REAL");
migrate("ALTER TABLE memories ADD COLUMN pagerank_score REAL DEFAULT 0");

// v3.1 indexes
migrate("CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(is_archived) WHERE is_archived = 1");

// v3 indexes
migrate("CREATE INDEX IF NOT EXISTS idx_memories_root ON memories(root_memory_id)");
migrate("CREATE INDEX IF NOT EXISTS idx_memories_parent ON memories(parent_memory_id)");
migrate("CREATE INDEX IF NOT EXISTS idx_memories_latest ON memories(is_latest) WHERE is_latest = 1");
migrate("CREATE INDEX IF NOT EXISTS idx_memories_forgotten ON memories(is_forgotten)");
migrate("CREATE INDEX IF NOT EXISTS idx_memories_forget_after ON memories(forget_after) WHERE forget_after IS NOT NULL");

// v4.1 — Access tracking, tags, episodes
const v41Columns: [string, string][] = [
  ["last_accessed_at", "TEXT"],
  ["access_count", "INTEGER NOT NULL DEFAULT 0"],
  ["tags", "TEXT"],  // JSON array: ["tag1", "tag2"]
  ["episode_id", "INTEGER"],
  ["decay_score", "REAL"],  // cached effective score
];
for (const [col, def] of v41Columns) {
  migrate(`ALTER TABLE memories ADD COLUMN ${col} ${def}`);
}
migrate("CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags) WHERE tags IS NOT NULL");
migrate("CREATE INDEX IF NOT EXISTS idx_memories_episode ON memories(episode_id) WHERE episode_id IS NOT NULL");
migrate("CREATE INDEX IF NOT EXISTS idx_memories_access ON memories(access_count DESC)");
migrate("CREATE INDEX IF NOT EXISTS idx_memories_decay ON memories(decay_score DESC)");

// Episodes table
migrate(`
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


// v5.7 — Episode embeddings, FSRS, FTS
migrate("ALTER TABLE episodes ADD COLUMN embedding BLOB");
migrate("ALTER TABLE episodes ADD COLUMN embedding_vec_1024 FLOAT32(1024)");
migrate("ALTER TABLE episodes ADD COLUMN duration_seconds INTEGER");
migrate("ALTER TABLE episodes ADD COLUMN fsrs_stability REAL");
migrate("ALTER TABLE episodes ADD COLUMN fsrs_difficulty REAL");
migrate("ALTER TABLE episodes ADD COLUMN fsrs_last_review_at TEXT");
migrate("ALTER TABLE episodes ADD COLUMN fsrs_reps INTEGER DEFAULT 0");
migrate("ALTER TABLE episodes ADD COLUMN decay_score REAL DEFAULT 1.0");

migrate(`CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  title, summary, content='episodes', content_rowid='id',
  tokenize='porter unicode61'
)`);

migrate(`CREATE TRIGGER IF NOT EXISTS episodes_fts_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END`);
migrate(`CREATE TRIGGER IF NOT EXISTS episodes_fts_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
END`);
migrate(`CREATE TRIGGER IF NOT EXISTS episodes_fts_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
  INSERT INTO episodes_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END`);

migrate("CREATE INDEX IF NOT EXISTS episodes_vec_1024_idx ON episodes(libsql_vector_idx(embedding_vec_1024))");

// Consolidation tracking
migrate(`
    CREATE TABLE IF NOT EXISTS consolidations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      summary_memory_id INTEGER NOT NULL REFERENCES memories(id),
      source_memory_ids TEXT NOT NULL,
      cluster_label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
migrate("ALTER TABLE consolidations ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
migrate("CREATE INDEX IF NOT EXISTS idx_consolidations_user ON consolidations(user_id)");


// v4.2 — Confidence, sync, webhooks
const v42Columns: [string, string][] = [
  ["confidence", "REAL NOT NULL DEFAULT 1.0"],
  ["sync_id", "TEXT"],  // UUID for cross-instance sync
];
for (const [col, def] of v42Columns) {
  migrate(`ALTER TABLE memories ADD COLUMN ${col} ${def}`);
}
migrate("CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_sync_id ON memories(sync_id) WHERE sync_id IS NOT NULL");

// v5.1 — Review queue: status column (pending/approved/rejected)
migrate("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
migrate("CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)");

// v5.0 — FSRS-6 spaced repetition columns
const v50Columns: [string, string][] = [
  ["fsrs_stability", "REAL"],
  ["fsrs_difficulty", "REAL"],
  ["fsrs_storage_strength", "REAL DEFAULT 1.0"],
  ["fsrs_retrieval_strength", "REAL DEFAULT 1.0"],
  ["fsrs_learning_state", "INTEGER DEFAULT 0"],
  ["fsrs_reps", "INTEGER DEFAULT 0"],
  ["fsrs_lapses", "INTEGER DEFAULT 0"],
  ["fsrs_last_review_at", "TEXT"],
];
for (const [col, def] of v50Columns) {
  migrate(`ALTER TABLE memories ADD COLUMN ${col} ${def}`);
}
migrate("CREATE INDEX IF NOT EXISTS idx_memories_fsrs_stability ON memories(fsrs_stability) WHERE fsrs_stability IS NOT NULL");

// v5.0 — Native vector column (libsql FLOAT32) — SKIP if already dropped by v60 migration
if (_getSchemaVersion() < 60) {
  migrate("ALTER TABLE memories ADD COLUMN embedding_vec FLOAT32(384)");
  migrate("CREATE INDEX IF NOT EXISTS memories_vec_idx ON memories(libsql_vector_idx(embedding_vec))");
}

// v5.7 — BGE-large 1024-dim vector column
migrate("ALTER TABLE memories ADD COLUMN embedding_vec_1024 FLOAT32(1024)");
migrate("CREATE INDEX IF NOT EXISTS memories_vec_1024_idx ON memories(libsql_vector_idx(embedding_vec_1024))");

// v5.9 — Dynamic vector column matching configured EMBEDDING_DIM
// When provider changes (e.g., local=1024, google/vertex=768), create the right column
export const VECTOR_COL = `embedding_vec_${EMBEDDING_DIM}`;
const EP_VECTOR_COL = `ep_embedding_vec_${EMBEDDING_DIM}`;
if (EMBEDDING_DIM !== 384 && EMBEDDING_DIM !== 1024) {
  migrate(`ALTER TABLE memories ADD COLUMN ${VECTOR_COL} FLOAT32(${EMBEDDING_DIM})`);
  migrate(`CREATE INDEX IF NOT EXISTS memories_vec_${EMBEDDING_DIM}_idx ON memories(libsql_vector_idx(${VECTOR_COL}))`);
  migrate(`ALTER TABLE episodes ADD COLUMN ${VECTOR_COL} FLOAT32(${EMBEDDING_DIM})`);
  migrate(`CREATE INDEX IF NOT EXISTS episodes_vec_${EMBEDDING_DIM}_idx ON episodes(libsql_vector_idx(${VECTOR_COL}))`);
}

// v5.9.1 — Drop unused 384-dim ghost vector column (0 rows populated, contributes to vtab corruption)
if (_getSchemaVersion() < 60) {
  migrate("DROP INDEX IF EXISTS memories_vec_idx");
  try { db.exec("ALTER TABLE memories DROP COLUMN embedding_vec"); } catch {}
  setSchemaVersion(60, "Drop unused 384-dim ghost vector column");
  log.info({ msg: "dropped_384_ghost_column" });
}

// Webhooks table
migrate(`
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


// Audit log table
migrate(`
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
migrate("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)");
migrate("CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)");
migrate("CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id)");

// v5.8 — Agent Identity & Trust
migrate(`
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

// Link API keys to agent identities
// NOTE: api_keys.agent_id ALTER deferred until AFTER api_keys CREATE TABLE (v4 schema below)

// Add agent_id + execution signing columns to audit_log
migrate("ALTER TABLE audit_log ADD COLUMN agent_id INTEGER");
migrate("ALTER TABLE audit_log ADD COLUMN execution_hash TEXT");
migrate("ALTER TABLE audit_log ADD COLUMN signature TEXT");
migrate("CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id)");

// v4.3 — Entities, Projects
migrate(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'generic',
      description TEXT,
      aka TEXT,
      metadata TEXT,
      user_id INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id);

    CREATE TABLE IF NOT EXISTS entity_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relationship TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_entity_id, target_entity_id, relationship)
    );
    CREATE INDEX IF NOT EXISTS idx_entrel_source ON entity_relationships(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_entrel_target ON entity_relationships(target_entity_id);

    CREATE TABLE IF NOT EXISTS memory_entities (
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      PRIMARY KEY (memory_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_me_entity ON memory_entities(entity_id);

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      metadata TEXT,
      user_id INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

    CREATE TABLE IF NOT EXISTS memory_projects (
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      PRIMARY KEY (memory_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mp_project ON memory_projects(project_id);
  `);

// v5.5 — Structured Intelligence Tables (bench-driven improvements)
migrate(`
    CREATE TABLE IF NOT EXISTS structured_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      verb TEXT NOT NULL,
      object TEXT,
      quantity REAL,
      unit TEXT,
      date_ref TEXT,
      date_approx TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      user_id INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sf_memory ON structured_facts(memory_id);
    CREATE INDEX IF NOT EXISTS idx_sf_subject ON structured_facts(subject COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_sf_verb ON structured_facts(verb);
    CREATE INDEX IF NOT EXISTS idx_sf_date ON structured_facts(date_approx);
    CREATE INDEX IF NOT EXISTS idx_sf_user ON structured_facts(user_id);
`);

// v5.8 — Fact decomposition dimensions (from Hindsight WHAT/WHEN/WHERE/WHO/WHY pattern)
migrate("ALTER TABLE structured_facts ADD COLUMN location TEXT DEFAULT NULL");
migrate("ALTER TABLE structured_facts ADD COLUMN context TEXT DEFAULT NULL");
migrate("ALTER TABLE structured_facts ADD COLUMN episode_id INTEGER DEFAULT NULL");
migrate("CREATE INDEX IF NOT EXISTS idx_sf_episode ON structured_facts(episode_id) WHERE episode_id IS NOT NULL");
migrate("CREATE INDEX IF NOT EXISTS idx_sf_location ON structured_facts(location COLLATE NOCASE) WHERE location IS NOT NULL");

// v5.8 — Bi-temporal fact tracking (from Graphiti/Zep pattern)
// valid_at = when fact became true, invalid_at = when superseded/contradicted
migrate("ALTER TABLE structured_facts ADD COLUMN valid_at TEXT DEFAULT NULL");
migrate("ALTER TABLE structured_facts ADD COLUMN invalid_at TEXT DEFAULT NULL");
migrate("ALTER TABLE structured_facts ADD COLUMN invalidated_by INTEGER DEFAULT NULL");
migrate("CREATE INDEX IF NOT EXISTS idx_sf_valid ON structured_facts(valid_at) WHERE valid_at IS NOT NULL");
migrate("CREATE INDEX IF NOT EXISTS idx_sf_invalid ON structured_facts(invalid_at) WHERE invalid_at IS NOT NULL");
migrate("CREATE INDEX IF NOT EXISTS idx_sf_subject_verb ON structured_facts(subject COLLATE NOCASE, verb, user_id)");

migrate(`
    CREATE TABLE IF NOT EXISTS current_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
      previous_value TEXT,
      previous_memory_id INTEGER,
      updated_count INTEGER NOT NULL DEFAULT 1,
      user_id INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(key, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cs_key ON current_state(key COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_cs_user ON current_state(user_id);
`);

migrate(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      preference TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 1.0,
      evidence_memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
      user_id INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(domain, preference, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_up_domain ON user_preferences(domain COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_up_user ON user_preferences(user_id);
`);



// v5.8 — Entity cooccurrence tracking (from Hindsight pattern)
migrate(`
    CREATE TABLE IF NOT EXISTS entity_cooccurrences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_a_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      entity_b_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      cooccurrence_count INTEGER NOT NULL DEFAULT 1,
      score REAL NOT NULL DEFAULT 0.0,
      last_memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
      user_id INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entity_a_id, entity_b_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ec_entity_a ON entity_cooccurrences(entity_a_id);
    CREATE INDEX IF NOT EXISTS idx_ec_entity_b ON entity_cooccurrences(entity_b_id);
    CREATE INDEX IF NOT EXISTS idx_ec_score ON entity_cooccurrences(score DESC);
    CREATE INDEX IF NOT EXISTS idx_ec_user ON entity_cooccurrences(user_id);
`);

// v4.5 — Digests, Reflections, Contradiction tracking
migrate(`
    CREATE TABLE IF NOT EXISTS digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      schedule TEXT NOT NULL DEFAULT 'daily',
      webhook_url TEXT NOT NULL,
      webhook_secret TEXT,
      include_stats BOOLEAN NOT NULL DEFAULT 1,
      include_new_memories BOOLEAN NOT NULL DEFAULT 1,
      include_contradictions BOOLEAN NOT NULL DEFAULT 1,
      include_reflections BOOLEAN NOT NULL DEFAULT 1,
      last_sent_at TEXT,
      next_send_at TEXT,
      active BOOLEAN NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_digests_next ON digests(next_send_at) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS idx_digests_user ON digests(user_id);

    CREATE TABLE IF NOT EXISTS reflections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL,
      themes TEXT,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      memory_count INTEGER NOT NULL DEFAULT 0,
      source_memory_ids TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reflections_user ON reflections(user_id);
    CREATE INDEX IF NOT EXISTS idx_reflections_period ON reflections(period_end DESC);
  `);

migrate("ALTER TABLE digests ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0");


// ============================================================================
// SCHEMA v4 — Multi-tenant: users, API keys, spaces
// ============================================================================

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

// Deferred from agents section: link API keys to agent identities (api_keys now exists)
migrate("ALTER TABLE api_keys ADD COLUMN agent_id INTEGER REFERENCES agents(id)");

// Scratchpad — short-term working memory with TTL
migrate(`
  CREATE TABLE IF NOT EXISTS scratchpad (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
    session TEXT NOT NULL,
    agent TEXT NOT NULL,
    model TEXT NOT NULL,
    entry_key TEXT NOT NULL,
    value TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL DEFAULT (datetime('now', '+30 minutes')),
    UNIQUE(user_id, session, entry_key)
  );
  CREATE INDEX IF NOT EXISTS idx_scratchpad_user_expires ON scratchpad(user_id, expires_at);
  CREATE INDEX IF NOT EXISTS idx_scratchpad_session ON scratchpad(user_id, session);
  CREATE INDEX IF NOT EXISTS idx_scratchpad_agent ON scratchpad(user_id, agent);
`);

// v4 migrations — add user_id and space_id columns to memories
// NOTE: conversations ALTER is deferred until AFTER conversations CREATE TABLE (below)
for (const [tbl, col, def] of [
  ["memories", "user_id", "INTEGER NOT NULL DEFAULT 1"],
  ["memories", "space_id", "INTEGER"],
] as const) {
  migrate(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`);
}
migrate("CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)");
migrate("CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_id)");

// RBAC: add role column (admin/writer/reader)
migrate("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");

// Ensure default user exists (backwards compat — all existing data is user_id=1)
const defaultUser = db.prepare("SELECT id FROM users WHERE id = 1").get();
if (!defaultUser) {
  db.exec("INSERT INTO users (id, username, is_admin) VALUES (1, 'owner', 1)");
  log.info({ msg: "created_default_user", id: 1 });
}

// Ensure default space for owner
const defaultSpace = db.prepare("SELECT id FROM spaces WHERE user_id = 1 AND name = 'default'").get();
if (!defaultSpace) {
  db.exec("INSERT INTO spaces (user_id, name, description) VALUES (1, 'default', 'Default memory space')");
  log.info({ msg: "created_default_space" });
}

// ============================================================================
// MEMORY LINKS TABLE — v3 with typed relationships
// ============================================================================

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

// v3 migration: add type column
migrate("ALTER TABLE memory_links ADD COLUMN type TEXT NOT NULL DEFAULT 'similarity'");

// ============================================================================
// CONVERSATIONS TABLE (unchanged from v2)
// ============================================================================

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

// v4 migration (deferred) — add user_id to conversations now that the table exists
migrate("ALTER TABLE conversations ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
migrate("CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id)");

// ============================================================================
// TIER 4 SCHEMA — Novel features
// ============================================================================

// Causal chains — temporal cause-effect relationships between memories
migrate(`
  CREATE TABLE IF NOT EXISTS causal_chains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    user_id INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cc_user ON causal_chains(user_id);
`);

migrate(`
  CREATE TABLE IF NOT EXISTS causal_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id INTEGER NOT NULL REFERENCES causal_chains(id) ON DELETE CASCADE,
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'event',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(chain_id, memory_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cl_chain ON causal_links(chain_id);
  CREATE INDEX IF NOT EXISTS idx_cl_memory ON causal_links(memory_id);
`);

// Emotional valence — sentiment/affect tracking per memory
migrate("ALTER TABLE memories ADD COLUMN valence REAL");
migrate("ALTER TABLE memories ADD COLUMN arousal REAL");
migrate("ALTER TABLE memories ADD COLUMN dominant_emotion TEXT");
migrate("CREATE INDEX IF NOT EXISTS idx_memories_valence ON memories(valence) WHERE valence IS NOT NULL");

// Reconsolidation tracking
migrate(`
  CREATE TABLE IF NOT EXISTS reconsolidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    old_importance INTEGER,
    new_importance INTEGER,
    old_confidence REAL,
    new_confidence REAL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_recon_memory ON reconsolidations(memory_id);
`);

// Temporal patterns
migrate(`
  CREATE TABLE IF NOT EXISTS temporal_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    day_of_week INTEGER NOT NULL,
    hour_of_day INTEGER NOT NULL,
    category TEXT,
    project_id INTEGER,
    access_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(user_id, day_of_week, hour_of_day, category, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tp_user ON temporal_patterns(user_id, day_of_week, hour_of_day);
`);

// ============================================================================
// PERSONALITY ENGINE — signals + cached profiles
// ============================================================================

migrate(`
  CREATE TABLE IF NOT EXISTS personality_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL DEFAULT 1,
    signal_type TEXT NOT NULL,
    subject TEXT NOT NULL,
    valence TEXT NOT NULL,
    intensity REAL DEFAULT 0.5,
    reasoning TEXT,
    source_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_personality_signals_user ON personality_signals(user_id);
  CREATE INDEX IF NOT EXISTS idx_personality_signals_type ON personality_signals(signal_type);
  CREATE INDEX IF NOT EXISTS idx_personality_signals_memory ON personality_signals(memory_id);

  CREATE TABLE IF NOT EXISTS personality_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    profile TEXT NOT NULL,
    signal_count INTEGER NOT NULL DEFAULT 0,
    is_stale BOOLEAN NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_personality_profiles_user ON personality_profiles(user_id);
`);

// ============================================================================
// RATE LIMITS TABLE (Phase 1.2)
// ============================================================================

migrate(`
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL DEFAULT (datetime('now')),
    window_seconds INTEGER NOT NULL DEFAULT 60
  );
  CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
`);

// ============================================================================
// API KEY EXPIRATION (Phase 1.4)
// ============================================================================

migrate(`ALTER TABLE api_keys ADD COLUMN expires_at TEXT`);
migrate(`CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at) WHERE expires_at IS NOT NULL`);

// ============================================================================
// TENANT QUOTAS (Phase 4.2)
// ============================================================================

migrate(`
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

// ============================================================================
// USAGE EVENTS (Phase 11.1)
// ============================================================================

migrate(`
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

// ============================================================================
// v6.0 -- Skills registry (OpenSpace native integration)
// ============================================================================

migrate(`
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

migrate(`ALTER TABLE skill_records ADD COLUMN ${VECTOR_COL} FLOAT32(${EMBEDDING_DIM})`);
migrate(`CREATE INDEX IF NOT EXISTS idx_skill_records_vec ON skill_records(libsql_vector_idx(${VECTOR_COL}))`);
migrate(`CREATE INDEX IF NOT EXISTS idx_skill_records_name ON skill_records(name)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_skill_records_category ON skill_records(category)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_skill_records_active ON skill_records(is_active) WHERE is_active = 1`);

migrate(`
  CREATE TABLE IF NOT EXISTS skill_lineage_parents (
    skill_id TEXT NOT NULL REFERENCES skill_records(skill_id) ON DELETE CASCADE,
    parent_skill_id TEXT NOT NULL,
    PRIMARY KEY (skill_id, parent_skill_id)
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS skill_tags (
    skill_id TEXT NOT NULL REFERENCES skill_records(skill_id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (skill_id, tag)
  )
`);
migrate(`CREATE INDEX IF NOT EXISTS idx_skill_tags_tag ON skill_tags(tag)`);

migrate(`
  CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
    name, description, content,
    content='skill_records',
    content_rowid='rowid',
    tokenize='porter unicode61'
  )
`);

migrate(`CREATE TRIGGER IF NOT EXISTS skills_fts_ai AFTER INSERT ON skill_records BEGIN
  INSERT INTO skills_fts(rowid, name, description, content)
  VALUES (new.rowid, new.name, new.description, new.content);
END`);

migrate(`CREATE TRIGGER IF NOT EXISTS skills_fts_ad AFTER DELETE ON skill_records BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, content)
  VALUES ('delete', old.rowid, old.name, old.description, old.content);
END`);

migrate(`CREATE TRIGGER IF NOT EXISTS skills_fts_au AFTER UPDATE ON skill_records BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, content)
  VALUES ('delete', old.rowid, old.name, old.description, old.content);
  INSERT INTO skills_fts(rowid, name, description, content)
  VALUES (new.rowid, new.name, new.description, new.content);
END`);

// ============================================================================
// CROSS-TENANT LINK TRIGGER (Phase 1.3)
// ============================================================================

migrate(`
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

// Record current schema version
setSchemaVersion(1, "initial schema with all tables and indexes");
setSchemaVersion(2, "insertMemory accepts user_id and space_id atomically");

// v5.12: Artifact storage
migrate(`CREATE TABLE IF NOT EXISTS artifacts (
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
migrate("CREATE INDEX IF NOT EXISTS idx_artifacts_memory ON artifacts(memory_id)");
migrate("CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(sha256)");
setSchemaVersion(512, "artifact storage table");

log.info({ msg: "schema_version", version: _getSchemaVersion() });

// ============================================================================
// SCHEMA UTILITIES
// ============================================================================

export function getSchemaVersion(): number {
  try {
    const row = db.prepare("SELECT MAX(version) as v FROM schema_versions").get() as any;
    return row?.v || 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// WRITE LOCK HELPER (Phase 2.1)
// ============================================================================

let activeWrites = 0;

export function withWriteLock<T>(label: string, fn: () => T): T {
  activeWrites++;
  opsCounters.db_write_queue_depth = Math.max(opsCounters.db_write_queue_depth, activeWrites);
  if (activeWrites > 1) {
    opsCounters.db_lock_waits++;
    log.debug({ msg: "db_write_contention", label, depth: activeWrites });
  }
  try {
    return fn();
  } catch (e: any) {
    if (String(e).includes("database is locked") || String(e).includes("SQLITE_BUSY")) {
      opsCounters.db_lock_timeouts++;
      log.error({ msg: "db_lock_timeout", label, depth: activeWrites });
    }
    throw e;
  } finally {
    activeWrites--;
  }
}
