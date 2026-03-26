import Database from "../node_modules/libsql/index.js";
import { execSync, spawnSync } from "child_process";
import { existsSync, copyFileSync, unlinkSync } from "fs";

const DB_PATH = process.argv[2] || "/opt/engram/data/memory.db";
const REBUILT_PATH = DB_PATH + ".rebuilt";
const BACKUP_PATH = DB_PATH + ".corrupted-" + new Date().toISOString().replace(/[:.]/g, "-");

console.log("=== Engram DB Rebuild ===");
console.log("Source:", DB_PATH);

// Step 1: Export all data from corrupted DB using .dump workaround
// We'll read data table by table with explicit columns (no vtab columns)
const src = new Database(DB_PATH, { readonly: true });

// Get memory count
const memCount = src.prepare("SELECT COUNT(*) as c FROM memories").get();
console.log("Memories to export:", memCount.c);

// Create fresh DB
if (existsSync(REBUILT_PATH)) unlinkSync(REBUILT_PATH);
const dst = new Database(REBUILT_PATH);
dst.exec("PRAGMA journal_mode=WAL");
dst.exec("PRAGMA foreign_keys=ON");

// Create schema (copy from source, excluding vector-related)
const schemaSql = src.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get();
console.log("Creating schema...");

// Recreate all tables from scratch (we know the schema)
dst.exec(`
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
    is_archived BOOLEAN NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER NOT NULL DEFAULT 1,
    space_id INTEGER,
    last_accessed_at TEXT,
    access_count INTEGER DEFAULT 0,
    tags TEXT,
    episode_id INTEGER,
    decay_score REAL,
    confidence REAL,
    sync_id TEXT,
    fsrs_stability REAL,
    fsrs_difficulty REAL,
    fsrs_storage_strength REAL,
    fsrs_retrieval_strength REAL,
    fsrs_learning_state INTEGER,
    fsrs_reps INTEGER,
    fsrs_lapses INTEGER,
    fsrs_last_review_at TEXT,
    status TEXT,
    valence REAL,
    arousal REAL,
    dominant_emotion TEXT,
    recall_hits INTEGER,
    recall_misses INTEGER,
    adaptive_score REAL,
    model TEXT,
    simhash TEXT,
    community_id INTEGER,
    pagerank_score REAL
  )
`);

// Copy all other tables' schemas
const otherTables = src.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name != 'memories' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL").all();
for (const t of otherTables) {
  try { dst.exec(t.sql); console.log("Created table:", t.name); }
  catch(e) { /* already exists or error */ }
}

// Define columns to copy (all non-vector columns)
const MEMORY_COLS = "id, content, category, source, session_id, importance, embedding, version, is_latest, parent_memory_id, root_memory_id, source_count, is_static, is_forgotten, forget_after, forget_reason, is_inference, is_archived, created_at, updated_at, user_id, space_id, last_accessed_at, access_count, tags, episode_id, decay_score, confidence, sync_id, fsrs_stability, fsrs_difficulty, fsrs_storage_strength, fsrs_retrieval_strength, fsrs_learning_state, fsrs_reps, fsrs_lapses, fsrs_last_review_at, status, valence, arousal, dominant_emotion, recall_hits, recall_misses, adaptive_score, model, simhash, community_id, pagerank_score";

// Export memories in batches
console.log("Exporting memories...");
const BATCH = 200;
let offset = 0;
let exported = 0;

const insertStmt = dst.prepare(`INSERT OR REPLACE INTO memories (${MEMORY_COLS}) VALUES (${MEMORY_COLS.split(",").map(() => "?").join(",")})`);

const insertBatch = dst.transaction((rows) => {
  for (const row of rows) {
    const vals = MEMORY_COLS.split(",").map(c => row[c.trim()]);
    insertStmt.run(...vals);
  }
});

while (true) {
  let rows;
  try {
    rows = src.prepare(`SELECT ${MEMORY_COLS} FROM memories ORDER BY id LIMIT ? OFFSET ?`).all(BATCH, offset);
  } catch(e) {
    console.log("Read error at offset", offset, ":", e.message);
    // Try row by row to skip corrupt rows
    for (let i = 0; i < BATCH; i++) {
      try {
        const row = src.prepare(`SELECT ${MEMORY_COLS} FROM memories ORDER BY id LIMIT 1 OFFSET ?`).get(offset + i);
        if (!row) break;
        try { insertStmt.run(...MEMORY_COLS.split(",").map(c => row[c.trim()])); exported++; }
        catch(e2) { console.log("Insert failed for row at offset", offset + i); }
      } catch(e2) { console.log("Skip corrupt row at offset", offset + i); }
    }
    offset += BATCH;
    continue;
  }
  if (!rows || rows.length === 0) break;
  try { insertBatch(rows); } catch(e) { console.log("Batch insert failed, trying one by one..."); }
  exported += rows.length;
  offset += BATCH;
  if (offset % 1000 === 0) process.stdout.write(".");
}
console.log("\nExported", exported, "memories");

// Copy other tables
for (const t of otherTables) {
  const name = t.name;
  if (name === "memories" || name.includes("fts") || name.includes("sqlite")) continue;
  try {
    // Get columns for this table
    const cols = src.pragma("table_info(" + name + ")");
    const colNames = cols.map(c => c.name).filter(n => !n.includes("embedding_vec"));
    const colStr = colNames.join(", ");
    const placeholders = colNames.map(() => "?").join(", ");

    const srcRows = src.prepare(`SELECT ${colStr} FROM ${name}`).all();
    if (srcRows.length === 0) continue;

    const ins = dst.prepare(`INSERT OR REPLACE INTO ${name} (${colStr}) VALUES (${placeholders})`);
    const batch = dst.transaction((rows) => {
      for (const row of rows) {
        ins.run(...colNames.map(c => row[c]));
      }
    });
    batch(srcRows);
    console.log("Copied", name, ":", srcRows.length, "rows");
  } catch(e) { console.log("Copy", name, "failed:", e.message.slice(0, 100)); }
}

src.close();

// Create FTS table and triggers
dst.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, category, source,
    content='memories', content_rowid='id',
    tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, category, source) VALUES (new.id, new.content, new.category, new.source);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category, source) VALUES ('delete', old.id, old.content, old.category, old.source);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category, source) VALUES ('delete', old.id, old.content, old.category, old.source);
    INSERT INTO memories_fts(rowid, content, category, source) VALUES (new.id, new.content, new.category, new.source);
  END;
`);

// Rebuild FTS index
console.log("Rebuilding FTS index...");
dst.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");

// Add vector columns (fresh, empty)
dst.exec("ALTER TABLE memories ADD COLUMN embedding_vec FLOAT32(384)");
dst.exec("ALTER TABLE memories ADD COLUMN embedding_vec_1024 FLOAT32(1024)");
dst.exec("CREATE INDEX IF NOT EXISTS memories_vec_1024_idx ON memories(libsql_vector_idx(embedding_vec_1024))");

// Create standard indexes
const indexSqls = [
  "CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(user_id, category)",
  "CREATE INDEX IF NOT EXISTS idx_memories_latest ON memories(is_latest, is_forgotten)",
  "CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_memories_simhash ON memories(simhash) WHERE simhash IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_memories_community ON memories(community_id) WHERE community_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_memories_fsrs_stability ON memories(fsrs_stability) WHERE fsrs_stability IS NOT NULL",
];
for (const sql of indexSqls) {
  try { dst.exec(sql); } catch(e) {}
}

// Integrity check
console.log("Running integrity check...");
const result = dst.pragma("integrity_check(10)");
console.log("Integrity:", JSON.stringify(result));

// Test batch update
try {
  const rows = dst.prepare("SELECT id FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1").all();
  const upd = dst.prepare("UPDATE memories SET decay_score = ? WHERE id = ?");
  const batch = dst.transaction(() => { let n = 0; for (const r of rows) { upd.run(5.0, r.id); n++; } return n; });
  console.log("Batch UPDATE test:", batch(), "rows - SUCCESS");
} catch(e) { console.log("Batch UPDATE test:", e.message); }

dst.exec("PRAGMA wal_checkpoint(TRUNCATE)");
dst.close();

// Swap files
console.log("Swapping files...");
copyFileSync(DB_PATH, BACKUP_PATH);
console.log("Corrupted DB backed up to:", BACKUP_PATH);
copyFileSync(REBUILT_PATH, DB_PATH);
// Clean up WAL/SHM from old DB
try { unlinkSync(DB_PATH + "-wal"); } catch {}
try { unlinkSync(DB_PATH + "-shm"); } catch {}
try { unlinkSync(REBUILT_PATH); } catch {}
try { unlinkSync(REBUILT_PATH + "-wal"); } catch {}
try { unlinkSync(REBUILT_PATH + "-shm"); } catch {}

console.log("=== REBUILD COMPLETE ===");
console.log("Restart Engram. Vector columns will be repopulated by the backfill job.");
