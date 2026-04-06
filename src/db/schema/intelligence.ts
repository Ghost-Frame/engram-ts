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
  // Consolidation tracking
  migrate(db, `
    CREATE TABLE IF NOT EXISTS consolidations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      summary_memory_id INTEGER NOT NULL REFERENCES memories(id),
      source_memory_ids TEXT NOT NULL,
      cluster_label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // v4.3 - Entities, Projects
  migrate(db, `
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

  // v5.5 - Structured Intelligence Tables
  migrate(db, `
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

  migrate(db, `
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

  migrate(db, `
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

  // v5.8 - Entity cooccurrence tracking
  migrate(db, `
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

  // v4.5 - Digests, Reflections
  migrate(db, `
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

  // Personality engine
  migrate(db, `
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

  // Scratchpad - short-term working memory with TTL
  migrate(db, `
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
}

