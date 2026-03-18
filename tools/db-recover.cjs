// Phase 3: Build and execute recovery from backup-0501 to production
// This script:
// 1. Backs up current production DB
// 2. Identifies missing memories and links
// 3. Restores them with all columns intact
// 4. Rebuilds FTS indexes
// 5. Verifies the result

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PROD_DB = path.join(__dirname, '..', 'data', 'memory.db');
const BACKUP_0501 = path.join(__dirname, '..', '..', 'engram-backup-20260315-0501', 'data', 'memory.db');

// Step 0: Pre-flight checks
console.log('=== PRE-FLIGHT CHECKS ===\n');

const prodDb = new Database(PROD_DB, { readonly: true });
const backupDb = new Database(BACKUP_0501, { readonly: true });

// Get production schema details
const prodSchema = prodDb.prepare("SELECT sql FROM sqlite_master WHERE name='memories'").get();
const backupSchema = backupDb.prepare("SELECT sql FROM sqlite_master WHERE name='memories'").get();

const prodCols = prodDb.pragma('table_info(memories)').map(c => c.name);
const backupCols = backupDb.pragma('table_info(memories)').map(c => c.name);

console.log(`Production columns (${prodCols.length}): ${prodCols.join(', ')}`);
console.log(`Backup columns (${backupCols.length}): ${backupCols.join(', ')}`);

// Find columns in prod but not in backup (new columns added since backup)
const newInProd = prodCols.filter(c => !backupCols.includes(c));
const missingFromProd = backupCols.filter(c => !prodCols.includes(c));
console.log(`\nColumns in prod but not backup: ${newInProd.length > 0 ? newInProd.join(', ') : 'none'}`);
console.log(`Columns in backup but not prod: ${missingFromProd.length > 0 ? missingFromProd.join(', ') : 'none'}`);

// Check memory_links schema
const prodLinksSchema = prodDb.prepare("SELECT sql FROM sqlite_master WHERE name='memory_links'").get();
const backupLinksSchema = backupDb.prepare("SELECT sql FROM sqlite_master WHERE name='memory_links'").get();
console.log(`\nProd memory_links schema: ${prodLinksSchema.sql}`);
console.log(`Backup memory_links schema: ${backupLinksSchema.sql}`);

const prodLinkCols = prodDb.pragma('table_info(memory_links)').map(c => c.name);
const backupLinkCols = backupDb.pragma('table_info(memory_links)').map(c => c.name);
console.log(`\nProd link columns: ${prodLinkCols.join(', ')}`);
console.log(`Backup link columns: ${backupLinkCols.join(', ')}`);

// Find missing memories
const prodIds = new Set(prodDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id));
const backupAllIds = backupDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id);
const missingIds = backupAllIds.filter(id => !prodIds.has(id));

console.log(`\nMissing memories to restore: ${missingIds.length}`);
console.log(`Missing IDs range: ${missingIds[0]} to ${missingIds[missingIds.length - 1]}`);

// Find missing memory_links
// Links reference memory IDs -- get all links from backup where source or target is in missing set
const missingSet = new Set(missingIds);
const allBackupLinks = backupDb.prepare('SELECT * FROM memory_links').all();
const allProdLinks = prodDb.prepare('SELECT * FROM memory_links').all();

// Create a set of existing prod link signatures for dedup
const prodLinkSigs = new Set(allProdLinks.map(l => `${l.source_id}-${l.target_id}-${l.type}`));
const missingLinks = allBackupLinks.filter(l => !prodLinkSigs.has(`${l.source_id}-${l.target_id}-${l.type}`));

console.log(`Missing memory_links to restore: ${missingLinks.length}`);

// Check for any links that reference memories not in either DB
const allFinalIds = new Set([...prodIds, ...missingIds]);
const orphanLinks = missingLinks.filter(l => !allFinalIds.has(l.source_id) || !allFinalIds.has(l.target_id));
console.log(`Orphan links (reference nonexistent memories): ${orphanLinks.length}`);

// Also check other related tables
for (const table of ['entities', 'entity_relationships', 'memory_entities', 'memory_projects', 'episodes', 'structured_facts', 'reflections', 'reconsolidations']) {
  try {
    const prodCount = prodDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get();
    const backupCount = backupDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get();
    if (prodCount.c !== backupCount.c) {
      console.log(`${table}: prod=${prodCount.c}, backup=${backupCount.c} (DIFF: ${backupCount.c - prodCount.c})`);
    }
  } catch (e) {
    // table might not exist in one or both
  }
}

prodDb.close();
backupDb.close();

console.log('\n=== READY TO RESTORE ===');
console.log(`Will restore: ${missingIds.length} memories + ${missingLinks.length - orphanLinks.length} links`);
console.log(`Run with --execute flag to perform the restore`);

if (process.argv.includes('--execute')) {
  console.log('\n=== EXECUTING RESTORE ===\n');
  
  // Step 1: Backup current production
  const backupPath = PROD_DB + '.pre-recovery-' + Date.now();
  fs.copyFileSync(PROD_DB, backupPath);
  console.log(`Backed up production to: ${backupPath}`);
  
  // Also copy WAL if exists
  if (fs.existsSync(PROD_DB + '-wal')) {
    fs.copyFileSync(PROD_DB + '-wal', backupPath + '-wal');
  }
  if (fs.existsSync(PROD_DB + '-shm')) {
    fs.copyFileSync(PROD_DB + '-shm', backupPath + '-shm');
  }
  
  // Step 2: Open both DBs
  const writeProdDb = new Database(PROD_DB);
  const readBackupDb = new Database(BACKUP_0501, { readonly: true });
  
  // Step 3: Get the common columns between backup and prod
  // EXCLUDE vector columns that require libsql extensions (better-sqlite3 can't handle these)
  const vectorCols = ['embedding_vec', 'embedding_vec_1024'];
  const commonCols = backupCols.filter(c => prodCols.includes(c) && !vectorCols.includes(c));
  console.log(`Restoring ${commonCols.length} common columns (excluding ${vectorCols.length} vector columns)`);
  console.log(`Vector columns excluded: ${vectorCols.join(', ')} (will need re-embedding via Engram API)`);
  
  // Step 3b: Drop vector indexes temporarily to avoid libsql_vector_idx errors
  console.log('\nDropping vector indexes temporarily...');
  const vectorIndexes = writeProdDb.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql LIKE '%vector%'").all();
  const shadowTables = writeProdDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%vec%shadow%'").all();
  console.log(`Found ${vectorIndexes.length} vector indexes and ${shadowTables.length} shadow tables`);
  
  // We can't drop libsql vector indexes with better-sqlite3 either
  // Instead, let's just exclude vector columns from the INSERT and that should work
  
  // Step 4: Restore missing memories
  const placeholders = commonCols.map(() => '?').join(', ');
  const insertSql = `INSERT OR IGNORE INTO memories (${commonCols.join(', ')}) VALUES (${placeholders})`;
  const insertStmt = writeProdDb.prepare(insertSql);
  
  const selectSql = `SELECT ${commonCols.join(', ')} FROM memories WHERE id = ?`;
  const selectStmt = readBackupDb.prepare(selectSql);
  
  let restoredCount = 0;
  const restoreMemories = writeProdDb.transaction(() => {
    for (const id of missingIds) {
      const row = selectStmt.get(id);
      if (row) {
        const values = commonCols.map(c => row[c]);
        try {
          insertStmt.run(...values);
          restoredCount++;
        } catch (e) {
          console.log(`  Failed to restore memory #${id}: ${e.message}`);
        }
      }
    }
  });
  
  restoreMemories();
  console.log(`Restored ${restoredCount}/${missingIds.length} memories`);
  
  // Step 5: Restore missing links (excluding orphans)
  const validMissingLinks = missingLinks.filter(l => allFinalIds.has(l.source_id) && allFinalIds.has(l.target_id));
  const commonLinkCols = backupLinkCols.filter(c => prodLinkCols.includes(c));
  const linkPlaceholders = commonLinkCols.map(() => '?').join(', ');
  const insertLinkSql = `INSERT OR IGNORE INTO memory_links (${commonLinkCols.join(', ')}) VALUES (${linkPlaceholders})`;
  const insertLinkStmt = writeProdDb.prepare(insertLinkSql);
  
  let restoredLinks = 0;
  const restoreLinks = writeProdDb.transaction(() => {
    for (const link of validMissingLinks) {
      const values = commonLinkCols.map(c => link[c]);
      try {
        insertLinkStmt.run(...values);
        restoredLinks++;
      } catch (e) {
        // Duplicate or constraint violation -- skip
      }
    }
  });
  
  restoreLinks();
  console.log(`Restored ${restoredLinks}/${validMissingLinks.length} memory_links`);
  
  // Step 5b: Restore missing structured_facts
  try {
    const prodFacts = writeProdDb.prepare('SELECT id FROM structured_facts').all().map(r => r.id);
    const prodFactIds = new Set(prodFacts);
    const backupFacts = readBackupDb.prepare('SELECT * FROM structured_facts').all();
    const missingFacts = backupFacts.filter(f => !prodFactIds.has(f.id));
    
    if (missingFacts.length > 0) {
      const factCols = readBackupDb.pragma('table_info(structured_facts)').map(c => c.name);
      const prodFactCols = writeProdDb.pragma('table_info(structured_facts)').map(c => c.name);
      const commonFactCols = factCols.filter(c => prodFactCols.includes(c));
      const factPlaceholders = commonFactCols.map(() => '?').join(', ');
      const insertFactSql = `INSERT OR IGNORE INTO structured_facts (${commonFactCols.join(', ')}) VALUES (${factPlaceholders})`;
      const insertFactStmt = writeProdDb.prepare(insertFactSql);
      
      let restoredFacts = 0;
      for (const fact of missingFacts) {
        const values = commonFactCols.map(c => fact[c]);
        try {
          insertFactStmt.run(...values);
          restoredFacts++;
        } catch (e) {
          console.log(`  Failed to restore fact #${fact.id}: ${e.message}`);
        }
      }
      console.log(`Restored ${restoredFacts}/${missingFacts.length} structured_facts`);
    } else {
      console.log('No missing structured_facts to restore');
    }
  } catch (e) {
    console.log(`structured_facts restore skipped: ${e.message}`);
  }
  
  // Step 6: Rebuild FTS index for restored memories
  console.log('\nRebuilding FTS indexes...');
  try {
    writeProdDb.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    console.log('  memories_fts rebuilt');
  } catch (e) {
    console.log(`  memories_fts rebuild failed: ${e.message}`);
  }
  
  // Step 7: Verify
  console.log('\n=== VERIFICATION ===\n');
  const finalCount = writeProdDb.prepare('SELECT COUNT(*) as c FROM memories WHERE user_id = 1').get();
  const finalLinks = writeProdDb.prepare('SELECT COUNT(*) as c FROM memory_links').get();
  console.log(`Final memory count (user_id=1): ${finalCount.c}`);
  console.log(`Final memory_links count: ${finalLinks.c}`);
  console.log(`Expected memories: ${prodIds.size + missingIds.length} (was ${prodIds.size})`);
  
  writeProdDb.close();
  readBackupDb.close();
  
  console.log('\n=== RESTORE COMPLETE ===');
  console.log(`Backup at: ${backupPath}`);
} else {
  console.log('\nDry run complete. Add --execute to perform the restore.');
}
