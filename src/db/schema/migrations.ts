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
    migrate(db, `ALTER TABLE memories ADD COLUMN ${col} ${def}`);
  }
  migrate(db, `ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 5`);
  migrate(db, `ALTER TABLE memories ADD COLUMN model TEXT`);
  migrate(db, `ALTER TABLE memories ADD COLUMN embedding BLOB`);

  // Columns referenced by prepared statements - must run before they're compiled
  migrate(db, `ALTER TABLE memories ADD COLUMN recall_hits INTEGER NOT NULL DEFAULT 0`);
  migrate(db, `ALTER TABLE memories ADD COLUMN recall_misses INTEGER NOT NULL DEFAULT 0`);
  migrate(db, `ALTER TABLE memories ADD COLUMN adaptive_score REAL`);
  migrate(db, `ALTER TABLE memories ADD COLUMN pagerank_score REAL DEFAULT 0`);

  // v3.1 indexes
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(is_archived) WHERE is_archived = 1`);

  // v3 indexes
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_root ON memories(root_memory_id)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_parent ON memories(parent_memory_id)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_latest ON memories(is_latest) WHERE is_latest = 1`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_forgotten ON memories(is_forgotten)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_forget_after ON memories(forget_after) WHERE forget_after IS NOT NULL`);

  // v4.1 - Access tracking, tags, episodes
  const v41Columns: [string, string][] = [
    ["last_accessed_at", "TEXT"],
    ["access_count", "INTEGER NOT NULL DEFAULT 0"],
    ["tags", "TEXT"],  // JSON array: ["tag1", "tag2"]
    ["episode_id", "INTEGER"],
    ["decay_score", "REAL"],  // cached effective score
  ];
  for (const [col, def] of v41Columns) {
    migrate(db, `ALTER TABLE memories ADD COLUMN ${col} ${def}`);
  }
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags) WHERE tags IS NOT NULL`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_episode ON memories(episode_id) WHERE episode_id IS NOT NULL`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_access ON memories(access_count DESC)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_decay ON memories(decay_score DESC)`);

  // v5.7 - Episode embeddings, FSRS, FTS
  migrate(db, `ALTER TABLE episodes ADD COLUMN embedding BLOB`);
  migrate(db, `ALTER TABLE episodes ADD COLUMN embedding_vec_1024 FLOAT32(1024)`);
  migrate(db, `ALTER TABLE episodes ADD COLUMN duration_seconds INTEGER`);
  migrate(db, `ALTER TABLE episodes ADD COLUMN fsrs_stability REAL`);
  migrate(db, `ALTER TABLE episodes ADD COLUMN fsrs_difficulty REAL`);
  migrate(db, `ALTER TABLE episodes ADD COLUMN fsrs_last_review_at TEXT`);
  migrate(db, `ALTER TABLE episodes ADD COLUMN fsrs_reps INTEGER DEFAULT 0`);
  migrate(db, `ALTER TABLE episodes ADD COLUMN decay_score REAL DEFAULT 1.0`);

  migrate(db, `CREATE INDEX IF NOT EXISTS episodes_vec_1024_idx ON episodes(libsql_vector_idx(embedding_vec_1024))`);

  // Consolidation migrations
  migrate(db, `ALTER TABLE consolidations ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_consolidations_user ON consolidations(user_id)`);

  // v4.2 - Confidence, sync, webhooks
  const v42Columns: [string, string][] = [
    ["confidence", "REAL NOT NULL DEFAULT 1.0"],
    ["sync_id", "TEXT"],  // UUID for cross-instance sync
  ];
  for (const [col, def] of v42Columns) {
    migrate(db, `ALTER TABLE memories ADD COLUMN ${col} ${def}`);
  }
  migrate(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_sync_id ON memories(sync_id) WHERE sync_id IS NOT NULL`);

  // v5.1 - Review queue: status column (pending/approved/rejected)
  migrate(db, `ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)`);

  // v5.0 - FSRS-6 spaced repetition columns
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
    migrate(db, `ALTER TABLE memories ADD COLUMN ${col} ${def}`);
  }
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_fsrs_stability ON memories(fsrs_stability) WHERE fsrs_stability IS NOT NULL`);

  // v5.7 - BGE-large 1024-dim vector column
  migrate(db, `ALTER TABLE memories ADD COLUMN embedding_vec_1024 FLOAT32(1024)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS memories_vec_1024_idx ON memories(libsql_vector_idx(embedding_vec_1024))`);

  // v5.9 - Dynamic vector column matching configured EMBEDDING_DIM
  if (EMBEDDING_DIM !== 384 && EMBEDDING_DIM !== 1024) {
    migrate(db, `ALTER TABLE memories ADD COLUMN ${VECTOR_COL} FLOAT32(${EMBEDDING_DIM})`);
    migrate(db, `CREATE INDEX IF NOT EXISTS memories_vec_${EMBEDDING_DIM}_idx ON memories(libsql_vector_idx(${VECTOR_COL}))`);
    migrate(db, `ALTER TABLE episodes ADD COLUMN ${VECTOR_COL} FLOAT32(${EMBEDDING_DIM})`);
    migrate(db, `CREATE INDEX IF NOT EXISTS episodes_vec_${EMBEDDING_DIM}_idx ON episodes(libsql_vector_idx(${VECTOR_COL}))`);
  }

  // Deferred: link API keys to agent identities (api_keys now exists)
  migrate(db, `ALTER TABLE api_keys ADD COLUMN agent_id INTEGER REFERENCES agents(id)`);

  // Add agent_id + execution signing columns to audit_log
  migrate(db, `ALTER TABLE audit_log ADD COLUMN agent_id INTEGER`);
  migrate(db, `ALTER TABLE audit_log ADD COLUMN execution_hash TEXT`);
  migrate(db, `ALTER TABLE audit_log ADD COLUMN signature TEXT`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id)`);

  // audit_log indexes
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id)`);

  // v4 migrations - add user_id and space_id columns to memories
  for (const [tbl, col, def] of [
    ["memories", "user_id", "INTEGER NOT NULL DEFAULT 1"],
    ["memories", "space_id", "INTEGER"],
  ] as const) {
    migrate(db, `ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`);
  }
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_id)`);

  // RBAC: add role column (admin/writer/reader)
  migrate(db, `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);

  // v3 migration: add type column to memory_links
  migrate(db, `ALTER TABLE memory_links ADD COLUMN type TEXT NOT NULL DEFAULT 'similarity'`);

  // v4 migration (deferred) - add user_id to conversations now that the table exists
  migrate(db, `ALTER TABLE conversations ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id)`);

  // v5.8 - Fact decomposition dimensions
  migrate(db, `ALTER TABLE structured_facts ADD COLUMN location TEXT DEFAULT NULL`);
  migrate(db, `ALTER TABLE structured_facts ADD COLUMN context TEXT DEFAULT NULL`);
  migrate(db, `ALTER TABLE structured_facts ADD COLUMN episode_id INTEGER DEFAULT NULL`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_sf_episode ON structured_facts(episode_id) WHERE episode_id IS NOT NULL`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_sf_location ON structured_facts(location COLLATE NOCASE) WHERE location IS NOT NULL`);

  // v5.8 - Bi-temporal fact tracking
  migrate(db, `ALTER TABLE structured_facts ADD COLUMN valid_at TEXT DEFAULT NULL`);
  migrate(db, `ALTER TABLE structured_facts ADD COLUMN invalid_at TEXT DEFAULT NULL`);
  migrate(db, `ALTER TABLE structured_facts ADD COLUMN invalidated_by INTEGER DEFAULT NULL`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_sf_valid ON structured_facts(valid_at) WHERE valid_at IS NOT NULL`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_sf_invalid ON structured_facts(invalid_at) WHERE invalid_at IS NOT NULL`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_sf_subject_verb ON structured_facts(subject COLLATE NOCASE, verb, user_id)`);

  // Emotional valence columns on memories
  migrate(db, `ALTER TABLE memories ADD COLUMN valence REAL`);
  migrate(db, `ALTER TABLE memories ADD COLUMN arousal REAL`);
  migrate(db, `ALTER TABLE memories ADD COLUMN dominant_emotion TEXT`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_valence ON memories(valence) WHERE valence IS NOT NULL`);

  // API key expiration
  migrate(db, `ALTER TABLE api_keys ADD COLUMN expires_at TEXT`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at) WHERE expires_at IS NOT NULL`);

  // Digests migration
  migrate(db, `ALTER TABLE digests ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0`);

  // v6.1 - OpenSpace full schema: new skill_records columns
  migrate(db, `ALTER TABLE skill_records ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`);
  migrate(db, `ALTER TABLE skill_records ADD COLUMN lineage_source_task_id TEXT`);
  migrate(db, `ALTER TABLE skill_records ADD COLUMN lineage_content_diff TEXT NOT NULL DEFAULT ''`);
  migrate(db, `ALTER TABLE skill_records ADD COLUMN lineage_content_snapshot TEXT NOT NULL DEFAULT '{}'`);
  migrate(db, `ALTER TABLE skill_records ADD COLUMN total_fallbacks INTEGER NOT NULL DEFAULT 0`);

  // v6.1 - Artifact columns
  migrate(db, `ALTER TABLE artifacts ADD COLUMN is_indexed INTEGER NOT NULL DEFAULT 0`);
  migrate(db, `ALTER TABLE artifacts ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0`);

  // v6.2 - Atomic fact decomposition columns
  migrate(db, `ALTER TABLE memories ADD COLUMN is_fact INTEGER DEFAULT 0`);
  migrate(db, `ALTER TABLE memories ADD COLUMN is_decomposed INTEGER DEFAULT 0`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_is_fact ON memories(is_fact) WHERE is_fact = 1`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_parent_fact ON memories(parent_memory_id) WHERE is_fact = 1`);
  migrate(db, `CREATE INDEX IF NOT EXISTS idx_memories_not_decomposed ON memories(is_decomposed) WHERE is_decomposed = 0 AND is_fact = 0`);
}

