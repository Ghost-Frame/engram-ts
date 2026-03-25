import Database from "../node_modules/libsql/index.js";

const CORRUPT = process.argv[2];
const TARGET = process.argv[3];
console.log("From:", CORRUPT);
console.log("To:", TARGET);

const src = new Database(CORRUPT, { readonly: true });
const dst = new Database(TARGET);
dst.exec("PRAGMA foreign_keys=OFF");

// All columns EXCEPT embedding (BLOB that needs special handling)
const TEXT_COLS = "id, content, category, source, session_id, importance, version, is_latest, parent_memory_id, root_memory_id, source_count, is_static, is_forgotten, forget_after, forget_reason, is_inference, is_archived, created_at, updated_at, user_id, space_id, last_accessed_at, access_count, tags, episode_id, decay_score, confidence, sync_id, fsrs_stability, fsrs_difficulty, fsrs_storage_strength, fsrs_retrieval_strength, fsrs_learning_state, fsrs_reps, fsrs_lapses, fsrs_last_review_at, status, valence, arousal, dominant_emotion, recall_hits, recall_misses, adaptive_score, model, simhash, community_id, pagerank_score";
const ALL_COLS = TEXT_COLS + ", embedding";
const textArr = TEXT_COLS.split(",").map(c => c.trim());
const allArr = ALL_COLS.split(",").map(c => c.trim());
const placeholders = allArr.map(() => "?").join(", ");

const ins = dst.prepare(`INSERT OR REPLACE INTO memories (${ALL_COLS}) VALUES (${placeholders})`);
const insNoEmb = dst.prepare(`INSERT OR REPLACE INTO memories (${TEXT_COLS}) VALUES (${textArr.map(() => "?").join(", ")})`);

let total = 0;
let noEmb = 0;
let failed = 0;

// Read all memories
const rows = src.prepare(`SELECT ${ALL_COLS} FROM memories ORDER BY id`).all();
console.log("Read", rows.length, "memories from source");

for (const row of rows) {
  try {
    // Try with embedding
    const emb = row.embedding;
    if (emb && (emb instanceof Buffer || emb instanceof Uint8Array || emb instanceof ArrayBuffer)) {
      const buf = emb instanceof Buffer ? emb : Buffer.from(emb);
      const vals = textArr.map(c => row[c]);
      vals.push(buf);
      ins.run(...vals);
      total++;
    } else if (emb) {
      // Unknown type - skip embedding, insert without it
      insNoEmb.run(...textArr.map(c => row[c]));
      noEmb++;
      total++;
    } else {
      insNoEmb.run(...textArr.map(c => row[c]));
      noEmb++;
      total++;
    }
  } catch(e) {
    // Try without embedding
    try {
      insNoEmb.run(...textArr.map(c => row[c]));
      noEmb++;
      total++;
    } catch(e2) {
      failed++;
      if (failed <= 5) console.log("Insert failed id=" + row.id + ":", e2.message.slice(0, 100));
    }
  }
}

console.log("Inserted:", total, "(with embedding:", total - noEmb, ", without:", noEmb, ") Failed:", failed);

// Rebuild FTS
console.log("Rebuilding FTS...");
try { dst.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')"); }
catch(e) { console.log("FTS rebuild:", e.message); }

dst.exec("PRAGMA foreign_keys=ON");
dst.exec("PRAGMA wal_checkpoint(TRUNCATE)");

const c = dst.prepare("SELECT COUNT(*) as c FROM memories").get();
const embCount = dst.prepare("SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL").get();
console.log("Final count:", c.c, "memories,", embCount.c, "with embeddings");

const integ = dst.pragma("integrity_check(5)");
console.log("Integrity:", JSON.stringify(integ));

// Test batch update
try {
  const mem = dst.prepare("SELECT id FROM memories WHERE is_forgotten=0 AND is_archived=0 AND is_latest=1").all();
  const upd = dst.prepare("UPDATE memories SET decay_score = 5.0 WHERE id = ?");
  const batch = dst.transaction(() => { let n = 0; for (const r of mem) { upd.run(r.id); n++; } return n; });
  console.log("Batch UPDATE test:", batch(), "rows - SUCCESS");
} catch(e) { console.log("Batch UPDATE:", e.message, e.code); }

dst.close();
src.close();
