// Database recovery using libsql (which supports vector indexes)
// Usage: node tools/db-recover-libsql.mjs [--execute]

import libsql from 'libsql';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROD_DB_PATH = path.join(__dirname, '..', 'data', 'memory.db');
const BACKUP_0501_PATH = path.join(__dirname, '..', '..', 'engram-backup-20260315-0501', 'data', 'memory.db');

const execute = process.argv.includes('--execute');

console.log('=== ENGRAM DATABASE RECOVERY ===\n');

// Read backup with better-sqlite3 (read-only, no trigger issues)
const backupDb = new Database(BACKUP_0501_PATH, { readonly: true });

// Read production with better-sqlite3 too (read-only for comparison)
const prodReadDb = new Database(PROD_DB_PATH, { readonly: true });

// Find missing memory IDs
const prodIds = new Set(prodReadDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id));
const backupAllIds = backupDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id);
const missingIds = backupAllIds.filter(id => !prodIds.has(id));

console.log(`Production: ${prodIds.size} memories`);
console.log(`Backup: ${backupAllIds.length} memories`);
console.log(`Missing: ${missingIds.length} memories (IDs ${missingIds[0]} to ${missingIds[missingIds.length - 1]})`);

// Find missing links
const allBackupLinks = backupDb.prepare('SELECT * FROM memory_links').all();
const allProdLinks = prodReadDb.prepare('SELECT * FROM memory_links').all();
const prodLinkSigs = new Set(allProdLinks.map(l => `${l.source_id}-${l.target_id}-${l.type}`));
const missingLinks = allBackupLinks.filter(l => !prodLinkSigs.has(`${l.source_id}-${l.target_id}-${l.type}`));
console.log(`Missing links: ${missingLinks.length}`);

// Find missing structured_facts
const prodFactIds = new Set(prodReadDb.prepare('SELECT id FROM structured_facts').all().map(r => r.id));
const backupFacts = backupDb.prepare('SELECT * FROM structured_facts').all();
const missingFacts = backupFacts.filter(f => !prodFactIds.has(f.id));
console.log(`Missing structured_facts: ${missingFacts.length}`);

prodReadDb.close();

if (!execute) {
  console.log('\nDry run complete. Add --execute to perform the restore.');
  backupDb.close();
  process.exit(0);
}

console.log('\n=== EXECUTING RESTORE ===\n');

// Step 1: Backup current production
const backupPath = PROD_DB_PATH + '.pre-recovery-' + Date.now();
fs.copyFileSync(PROD_DB_PATH, backupPath);
if (fs.existsSync(PROD_DB_PATH + '-wal')) {
  fs.copyFileSync(PROD_DB_PATH + '-wal', backupPath + '-wal');
}
if (fs.existsSync(PROD_DB_PATH + '-shm')) {
  fs.copyFileSync(PROD_DB_PATH + '-shm', backupPath + '-shm');
}
console.log(`Backed up to: ${backupPath}`);

// Step 2: Open production with libsql for writes (supports vector indexes)
const prodDb = new libsql(PROD_DB_PATH);

// Get column list (exclude vector columns -- they need re-embedding via Engram's embedding pipeline)
const backupCols = backupDb.pragma('table_info(memories)').map(c => c.name);
const vectorCols = ['embedding_vec', 'embedding_vec_1024'];
const insertCols = backupCols.filter(c => !vectorCols.includes(c));

console.log(`Inserting with ${insertCols.length} columns (excluding ${vectorCols.join(', ')})`);

// Step 3: Restore memories in a transaction
const placeholders = insertCols.map(() => '?').join(', ');
const insertSql = `INSERT OR IGNORE INTO memories (${insertCols.join(', ')}) VALUES (${placeholders})`;
const insertStmt = prodDb.prepare(insertSql);

const selectSql = `SELECT ${insertCols.join(', ')} FROM memories WHERE id = ?`;
const selectStmt = backupDb.prepare(selectSql);

let restoredMemories = 0;
let failedMemories = 0;

const restoreMemories = prodDb.transaction(() => {
  for (const id of missingIds) {
    const row = selectStmt.get(id);
    if (!row) continue;
    
    const values = insertCols.map(c => row[c] === undefined ? null : row[c]);
    try {
      insertStmt.run(...values);
      restoredMemories++;
    } catch (e) {
      failedMemories++;
      console.log(`  FAILED memory #${id}: ${e.message}`);
    }
  }
});

restoreMemories();
console.log(`Restored ${restoredMemories}/${missingIds.length} memories (${failedMemories} failed)`);

// Step 4: Restore missing links
const linkCols = backupDb.pragma('table_info(memory_links)').map(c => c.name);
const linkInsertCols = linkCols.filter(c => c !== 'id');
const linkPlaceholders = linkInsertCols.map(() => '?').join(', ');
const insertLinkSql = `INSERT OR IGNORE INTO memory_links (${linkInsertCols.join(', ')}) VALUES (${linkPlaceholders})`;
const insertLinkStmt = prodDb.prepare(insertLinkSql);

const allFinalIds = new Set([...prodIds, ...missingIds]);
const validLinks = missingLinks.filter(l => allFinalIds.has(l.source_id) && allFinalIds.has(l.target_id));

let restoredLinks = 0;
let failedLinks = 0;

const restoreLinks = prodDb.transaction(() => {
  for (const link of validLinks) {
    const values = linkInsertCols.map(c => link[c] === undefined ? null : link[c]);
    try {
      insertLinkStmt.run(...values);
      restoredLinks++;
    } catch (e) {
      failedLinks++;
    }
  }
});

restoreLinks();
console.log(`Restored ${restoredLinks}/${validLinks.length} memory_links (${failedLinks} failed)`);

// Step 5: Restore structured_facts
if (missingFacts.length > 0) {
  const factCols = backupDb.pragma('table_info(structured_facts)').map(c => c.name);
  let restoredFacts = 0;
  
  const restoreFacts = prodDb.transaction(() => {
    for (const fact of missingFacts) {
      const fp = factCols.map(() => '?').join(', ');
      const values = factCols.map(c => fact[c] === undefined ? null : fact[c]);
      try {
        prodDb.prepare(`INSERT OR IGNORE INTO structured_facts (${factCols.join(', ')}) VALUES (${fp})`).run(...values);
        restoredFacts++;
      } catch (e) {
        console.log(`  FAILED fact: ${e.message}`);
      }
    }
  });
  
  restoreFacts();
  console.log(`Restored ${restoredFacts}/${missingFacts.length} structured_facts`);
}

// Step 6: Rebuild FTS indexes
console.log('\nRebuilding FTS indexes...');
try {
  prodDb.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  console.log('  memories_fts rebuilt');
} catch (e) {
  console.log(`  memories_fts rebuild failed: ${e.message}`);
}

// Step 7: Verify
console.log('\n=== VERIFICATION ===\n');
const finalCount = prodDb.prepare('SELECT COUNT(*) as c FROM memories WHERE user_id = 1').get();
const finalLinks = prodDb.prepare('SELECT COUNT(*) as c FROM memory_links').get();
const finalFacts = prodDb.prepare('SELECT COUNT(*) as c FROM structured_facts').get();

console.log(`Final memory count (user_id=1): ${finalCount.c}`);
console.log(`Final memory_links count: ${finalLinks.c}`);
console.log(`Final structured_facts count: ${finalFacts.c}`);
console.log(`Expected memories: ${prodIds.size + missingIds.length}`);

backupDb.close();
prodDb.close();

console.log('\n=== RESTORE COMPLETE ===');
console.log(`Backup at: ${backupPath}`);
console.log('\nNOTE: Restored memories do NOT have vector embeddings yet.');
console.log('They will be searchable via FTS but not via vector similarity until re-embedded.');
console.log('Run a re-embedding pass via the Engram API to generate embeddings for restored memories.');
