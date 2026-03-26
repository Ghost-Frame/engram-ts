import Database from "../node_modules/libsql/index.js";
import { execSync } from "child_process";

const DB_PATH = process.argv[2] || "/opt/engram/data/memory.db";
console.log("Fixing:", DB_PATH);

// Backup
const ts = new Date().toISOString().replace(/[:.]/g, "-");
execSync(`cp "${DB_PATH}" "${DB_PATH}.bak-pre-vtab-fix-${ts}"`);
console.log("Backup created");

const db = new Database(DB_PATH);

// 1. Drop all vector indexes
for (const idx of ["memories_vec_idx", "memories_vec_1024_idx", "episodes_vec_1024_idx"]) {
  try { db.exec("DROP INDEX IF EXISTS " + idx); console.log("Dropped index:", idx); }
  catch(e) { console.log("Drop " + idx + ":", e.message); }
}

// 2. Drop the FLOAT32 columns (these hold the corrupt vtab data)
for (const tbl of ["memories", "episodes"]) {
  for (const col of ["embedding_vec", "embedding_vec_1024"]) {
    try { db.exec(`ALTER TABLE ${tbl} DROP COLUMN ${col}`); console.log(`Dropped ${tbl}.${col}`); }
    catch(e) { console.log(`Drop ${tbl}.${col}: ${e.message}`); }
  }
}

// 3. Test batch update (the operation that was crashing)
try {
  const rows = db.prepare("SELECT id FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1").all();
  const upd = db.prepare("UPDATE memories SET decay_score = ? WHERE id = ?");
  const batch = db.transaction(() => { let n = 0; for (const r of rows) { upd.run(5.0, r.id); n++; } return n; });
  console.log("Batch UPDATE after drop:", batch(), "rows - OK");
} catch(e) { console.log("Batch UPDATE FAILED:", e.message, e.code); }

// 4. Recreate the columns fresh (empty, no corrupt data)
try { db.exec("ALTER TABLE memories ADD COLUMN embedding_vec FLOAT32(384)"); console.log("Recreated memories.embedding_vec"); }
catch(e) { console.log("Recreate 384:", e.message); }

try { db.exec("ALTER TABLE memories ADD COLUMN embedding_vec_1024 FLOAT32(1024)"); console.log("Recreated memories.embedding_vec_1024"); }
catch(e) { console.log("Recreate 1024:", e.message); }

try { db.exec("ALTER TABLE episodes ADD COLUMN embedding_vec_1024 FLOAT32(1024)"); console.log("Recreated episodes.embedding_vec_1024"); }
catch(e) { console.log("Recreate ep 1024:", e.message); }

// 5. Recreate ONLY the 1024 index (384 is unused)
try { db.exec("CREATE INDEX IF NOT EXISTS memories_vec_1024_idx ON memories(libsql_vector_idx(embedding_vec_1024))"); console.log("Recreated memories_vec_1024_idx"); }
catch(e) { console.log("Recreate 1024 idx:", e.message); }

try { db.exec("CREATE INDEX IF NOT EXISTS episodes_vec_1024_idx ON episodes(libsql_vector_idx(embedding_vec_1024))"); console.log("Recreated episodes_vec_1024_idx"); }
catch(e) { console.log("Recreate ep 1024 idx:", e.message); }

// 6. Final test
try {
  const rows = db.prepare("SELECT id FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1").all();
  const upd = db.prepare("UPDATE memories SET decay_score = ? WHERE id = ?");
  const batch = db.transaction(() => { let n = 0; for (const r of rows) { upd.run(5.0, r.id); n++; } return n; });
  console.log("Final batch UPDATE:", batch(), "rows - SUCCESS");
} catch(e) { console.log("Final batch UPDATE:", e.message, e.code); }

// 7. Integrity check
try {
  const result = db.pragma("integrity_check(10)");
  console.log("Integrity:", JSON.stringify(result));
} catch(e) { console.log("Integrity:", e.message); }

// 8. WAL checkpoint
try { db.pragma("wal_checkpoint(TRUNCATE)"); console.log("WAL checkpoint OK"); }
catch(e) { console.log("WAL checkpoint:", e.message); }

db.close();
console.log("Done. Restart Engram - it will repopulate vector columns on next embed.");
