import Database from "../node_modules/libsql/index.js";

const DB_PATH = process.argv[2] || "/opt/engram/data/memory.db";
const CORRUPT_PATH = DB_PATH + ".corrupted-" + process.argv[3];

if (!process.argv[3]) {
  console.log("Usage: node fix-fk-tables.mjs <db_path> <corrupted_backup_timestamp>");
  console.log("Finding most recent corrupted backup...");
  import("fs").then(fs => {
    import("path").then(path => {
      const dir = path.dirname(DB_PATH);
      const files = fs.readdirSync(dir).filter(f => f.includes("corrupted-2026"));
      files.sort();
      if (files.length > 0) {
        console.log("Found:", files[files.length - 1]);
        console.log("Re-run with:", files[files.length - 1].replace("memory.db.corrupted-", ""));
      }
    });
  });
  process.exit(1);
}

console.log("Source (corrupted):", CORRUPT_PATH);
console.log("Target (rebuilt):", DB_PATH);

const src = new Database(CORRUPT_PATH, { readonly: true });
const dst = new Database(DB_PATH);

// Disable FK checks for this session
dst.exec("PRAGMA foreign_keys=OFF");

const fkTables = ["api_keys", "consolidations", "current_state", "memory_links", "personality_signals", "spaces", "structured_facts", "user_preferences"];

for (const name of fkTables) {
  try {
    const cols = src.pragma("table_info(" + name + ")");
    const colNames = cols.map(c => c.name).filter(n => !n.includes("embedding_vec"));
    const colStr = colNames.join(", ");
    const placeholders = colNames.map(() => "?").join(", ");

    const srcRows = src.prepare(`SELECT ${colStr} FROM ${name}`).all();
    if (srcRows.length === 0) { console.log(name, ": empty, skip"); continue; }

    const ins = dst.prepare(`INSERT OR REPLACE INTO ${name} (${colStr}) VALUES (${placeholders})`);
    const batch = dst.transaction((rows) => {
      for (const row of rows) ins.run(...colNames.map(c => row[c]));
    });
    batch(srcRows);
    console.log("Copied", name, ":", srcRows.length, "rows");
  } catch(e) { console.log("Copy", name, "failed:", e.message.slice(0, 150)); }
}

// Also copy entity relationships and other join tables
const joinTables = ["entity_cooccurrences", "entity_relationships", "memory_entities", "memory_projects", "causal_chains", "causal_links", "temporal_patterns", "personality_profiles", "reconsolidations", "tenant_quotas"];
for (const name of joinTables) {
  try {
    const cols = src.pragma("table_info(" + name + ")");
    if (!cols || cols.length === 0) continue;
    const colNames = cols.map(c => c.name);
    const colStr = colNames.join(", ");
    const placeholders = colNames.map(() => "?").join(", ");

    const srcRows = src.prepare(`SELECT ${colStr} FROM ${name}`).all();
    if (srcRows.length === 0) continue;

    const ins = dst.prepare(`INSERT OR REPLACE INTO ${name} (${colStr}) VALUES (${placeholders})`);
    const batch = dst.transaction((rows) => {
      for (const row of rows) ins.run(...colNames.map(c => row[c]));
    });
    batch(srcRows);
    console.log("Copied", name, ":", srcRows.length, "rows");
  } catch(e) { console.log("Copy", name, "failed:", e.message.slice(0, 150)); }
}

// Re-enable FK
dst.exec("PRAGMA foreign_keys=ON");

// Verify
const memCount = dst.prepare("SELECT COUNT(*) as c FROM memories").get();
const latestCount = dst.prepare("SELECT COUNT(*) as c FROM memories WHERE is_latest = 1 AND is_forgotten = 0 AND is_archived = 0").get();
console.log("\nTotal memories:", memCount.c);
console.log("Active (latest, not forgotten/archived):", latestCount.c);

// Final integrity
const result = dst.pragma("integrity_check(10)");
console.log("Integrity:", JSON.stringify(result));

dst.exec("PRAGMA wal_checkpoint(TRUNCATE)");
dst.close();
src.close();
console.log("Done.");
