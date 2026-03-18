// Database comparison script for recovery
// Usage: node tools/db-compare.js

const Database = require('better-sqlite3');
const path = require('path');

const PROD_DB = path.join(__dirname, '..', 'data', 'memory.db');
const BACKUP_0501 = path.join(__dirname, '..', '..', 'engram-backup-20260315-0501', 'data', 'memory.db');
const WIPED_BACKUP = path.join(__dirname, '..', 'data', 'memory.db.wiped-backup');
const ROCKY_RECOVERY = path.join(__dirname, '..', 'data', 'memory.db.rocky-recovery');
const PRE_RESET_BAK = path.join(__dirname, '..', 'data', 'memory.db.pre-reset-fix-bak');
const PRE_BGE_BAK = path.join(__dirname, '..', 'data', 'memory.db.pre-bge-bak');

function getStats(dbPath, label) {
  try {
    const db = new Database(dbPath, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    
    let memStats = null;
    if (tables.includes('memories')) {
      memStats = db.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN forgotten = 0 THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN forgotten = 1 THEN 1 ELSE 0 END) as forgotten,
          MIN(created_at) as earliest,
          MAX(created_at) as latest
        FROM memories WHERE user_id = 1
      `).get();
      
      // Get category breakdown
      const categories = db.prepare(`
        SELECT category, COUNT(*) as count 
        FROM memories WHERE user_id = 1 AND forgotten = 0
        GROUP BY category ORDER BY count DESC
      `).all();
      memStats.categories = categories;
    }
    
    db.close();
    return { label, tables, memStats };
  } catch (e) {
    return { label, error: e.message };
  }
}

// Get stats from all databases
const databases = [
  [PROD_DB, 'PRODUCTION (memory.db)'],
  [BACKUP_0501, 'BACKUP-0501'],
  [WIPED_BACKUP, 'WIPED-BACKUP (memory.db.wiped-backup)'],
  [ROCKY_RECOVERY, 'ROCKY-RECOVERY'],
  [PRE_RESET_BAK, 'PRE-RESET-FIX-BAK'],
  [PRE_BGE_BAK, 'PRE-BGE-BAK'],
];

console.log('=== DATABASE COMPARISON ===\n');
for (const [dbPath, label] of databases) {
  const stats = getStats(dbPath, label);
  if (stats.error) {
    console.log(`[${label}] ERROR: ${stats.error}\n`);
  } else {
    console.log(`[${label}]`);
    console.log(`  Tables: ${stats.tables.join(', ')}`);
    if (stats.memStats) {
      console.log(`  Total memories (user_id=1): ${stats.memStats.total}`);
      console.log(`  Active: ${stats.memStats.active}, Forgotten: ${stats.memStats.forgotten}`);
      console.log(`  Date range: ${stats.memStats.earliest} to ${stats.memStats.latest}`);
      console.log(`  Categories: ${stats.memStats.categories.map(c => `${c.category}(${c.count})`).join(', ')}`);
    }
    console.log();
  }
}

// Now compare: find IDs in backup-0501 that are NOT in production
console.log('=== MISSING MEMORIES ANALYSIS ===\n');

try {
  const prodDb = new Database(PROD_DB, { readonly: true });
  const backupDb = new Database(BACKUP_0501, { readonly: true });
  
  // Get all memory IDs from both
  const prodIds = new Set(prodDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id));
  const backupIds = new Set(backupDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id));
  
  const missingFromProd = [...backupIds].filter(id => !prodIds.has(id));
  const onlyInProd = [...prodIds].filter(id => !backupIds.has(id));
  
  console.log(`Production has ${prodIds.size} memories (user_id=1)`);
  console.log(`Backup-0501 has ${backupIds.size} memories (user_id=1)`);
  console.log(`In backup but NOT in production: ${missingFromProd.length}`);
  console.log(`In production but NOT in backup: ${onlyInProd.length}`);
  
  if (missingFromProd.length > 0) {
    console.log(`\nMissing memory IDs (first 50): ${missingFromProd.slice(0, 50).join(', ')}`);
    
    // Get details of missing memories
    const placeholders = missingFromProd.map(() => '?').join(',');
    const missingDetails = backupDb.prepare(`
      SELECT id, category, content, created_at, forgotten
      FROM memories WHERE id IN (${placeholders}) AND user_id = 1
      ORDER BY id
    `).all(...missingFromProd);
    
    console.log(`\nMissing memories detail:`);
    for (const m of missingDetails.slice(0, 20)) {
      const preview = m.content.substring(0, 100).replace(/\n/g, ' ');
      console.log(`  #${m.id} [${m.category}] (forgotten=${m.forgotten}) ${m.created_at}: ${preview}...`);
    }
    if (missingDetails.length > 20) {
      console.log(`  ... and ${missingDetails.length - 20} more`);
    }
  }
  
  prodDb.close();
  backupDb.close();
} catch (e) {
  console.log(`Comparison error: ${e.message}`);
}

// Also check the wiped-backup for additional memories
console.log('\n=== WIPED-BACKUP ADDITIONAL ANALYSIS ===\n');
try {
  const prodDb = new Database(PROD_DB, { readonly: true });
  const wipedDb = new Database(WIPED_BACKUP, { readonly: true });
  
  const prodIds = new Set(prodDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id));
  const wipedIds = new Set(wipedDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id));
  
  const missingFromProd = [...wipedIds].filter(id => !prodIds.has(id));
  
  console.log(`Wiped-backup has ${wipedIds.size} memories (user_id=1)`);
  console.log(`In wiped-backup but NOT in production: ${missingFromProd.length}`);
  
  if (missingFromProd.length > 0) {
    const placeholders = missingFromProd.map(() => '?').join(',');
    const missingDetails = wipedDb.prepare(`
      SELECT id, category, content, created_at, forgotten
      FROM memories WHERE id IN (${placeholders}) AND user_id = 1
      ORDER BY id
    `).all(...missingFromProd);
    
    console.log(`\nMissing from wiped-backup detail (first 20):`);
    for (const m of missingDetails.slice(0, 20)) {
      const preview = m.content.substring(0, 100).replace(/\n/g, ' ');
      console.log(`  #${m.id} [${m.category}] (forgotten=${m.forgotten}) ${m.created_at}: ${preview}...`);
    }
    if (missingDetails.length > 20) {
      console.log(`  ... and ${missingDetails.length - 20} more`);
    }
  }
  
  prodDb.close();
  wipedDb.close();
} catch (e) {
  console.log(`Wiped-backup analysis error: ${e.message}`);
}

// Check rocky-recovery and pre-reset-fix-bak too
for (const [dbPath, label] of [[ROCKY_RECOVERY, 'ROCKY-RECOVERY'], [PRE_RESET_BAK, 'PRE-RESET-FIX-BAK']]) {
  console.log(`\n=== ${label} ADDITIONAL ANALYSIS ===\n`);
  try {
    const prodDb = new Database(PROD_DB, { readonly: true });
    const otherDb = new Database(dbPath, { readonly: true });
    
    const prodIds = new Set(prodDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id));
    const otherIds = new Set(otherDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id));
    
    const missingFromProd = [...otherIds].filter(id => !prodIds.has(id));
    
    console.log(`${label} has ${otherIds.size} memories (user_id=1)`);
    console.log(`In ${label} but NOT in production: ${missingFromProd.length}`);
    
    prodDb.close();
    otherDb.close();
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
}
