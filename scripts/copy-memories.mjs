import Database from "../node_modules/libsql/index.js";

const CORRUPT = process.argv[2];
const TARGET = process.argv[3];
console.log("From:", CORRUPT);
console.log("To:", TARGET);

const src = new Database(CORRUPT, { readonly: true });
const dst = new Database(TARGET);
dst.exec("PRAGMA foreign_keys=OFF");

const COLS = "id, content, category, source, session_id, importance, embedding, version, is_latest, parent_memory_id, root_memory_id, source_count, is_static, is_forgotten, forget_after, forget_reason, is_inference, is_archived, created_at, updated_at, user_id, space_id, last_accessed_at, access_count, tags, episode_id, decay_score, confidence, sync_id, fsrs_stability, fsrs_difficulty, fsrs_storage_strength, fsrs_retrieval_strength, fsrs_learning_state, fsrs_reps, fsrs_lapses, fsrs_last_review_at, status, valence, arousal, dominant_emotion, recall_hits, recall_misses, adaptive_score, model, simhash, community_id, pagerank_score";
const colArr = COLS.split(",").map(c => c.trim());
const placeholders = colArr.map(() => "?").join(", ");

const ins = dst.prepare(`INSERT OR REPLACE INTO memories (${COLS}) VALUES (${placeholders})`);

let total = 0;
let failed = 0;
const BATCH = 100;
let offset = 0;

while (true) {
  let rows;
  try {
    rows = src.prepare(`SELECT ${COLS} FROM memories ORDER BY id LIMIT ${BATCH} OFFSET ${offset}`).all();
  } catch(e) {
    console.log("Read batch failed at offset", offset, "- trying row by row");
    for (let i = 0; i < BATCH; i++) {
      try {
        const row = src.prepare(`SELECT ${COLS} FROM memories WHERE id = (SELECT id FROM memories ORDER BY id LIMIT 1 OFFSET ${offset + i})`).get();
        if (!row) break;
        try { ins.run(...colArr.map(c => row[c])); total++; }
        catch(e2) { failed++; }
      } catch(e2) { /* skip corrupt */ }
    }
    offset += BATCH;
    continue;
  }
  if (!rows || rows.length === 0) break;

  for (const row of rows) {
    try { ins.run(...colArr.map(c => row[c])); total++; }
    catch(e) { failed++; console.log("Insert failed id=" + row.id + ":", e.message.slice(0, 80)); }
  }
  offset += BATCH;
  if (offset % 500 === 0) process.stdout.write(offset + "...");
}

console.log("\nInserted:", total, "Failed:", failed);

// Rebuild FTS
console.log("Rebuilding FTS...");
try { dst.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')"); console.log("FTS rebuilt"); }
catch(e) { console.log("FTS rebuild:", e.message); }

dst.exec("PRAGMA foreign_keys=ON");
dst.exec("PRAGMA wal_checkpoint(TRUNCATE)");

const c = dst.prepare("SELECT COUNT(*) as c FROM memories").get();
console.log("Final count:", c.c);

const integ = dst.pragma("integrity_check(5)");
console.log("Integrity:", JSON.stringify(integ));

dst.close();
src.close();
