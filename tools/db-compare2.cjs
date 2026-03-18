// Phase 2: Get schema and full missing memory details
const Database = require('better-sqlite3');
const path = require('path');

const PROD_DB = path.join(__dirname, '..', 'data', 'memory.db');
const BACKUP_0501 = path.join(__dirname, '..', '..', 'engram-backup-20260315-0501', 'data', 'memory.db');

const prodDb = new Database(PROD_DB, { readonly: true });
const backupDb = new Database(BACKUP_0501, { readonly: true });

// Get schema
console.log('=== MEMORIES TABLE SCHEMA ===');
const schema = prodDb.prepare("SELECT sql FROM sqlite_master WHERE name='memories'").get();
console.log(schema.sql);
console.log();

// Get column names
const cols = prodDb.pragma('table_info(memories)');
console.log('Columns:', cols.map(c => c.name).join(', '));
console.log();

// Get all tables
const tables = prodDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('All tables:', tables.map(t => t.name).join(', '));
console.log();

// Count memories by status
const prodTotal = prodDb.prepare('SELECT COUNT(*) as c FROM memories WHERE user_id = 1').get();
const backupTotal = backupDb.prepare('SELECT COUNT(*) as c FROM memories WHERE user_id = 1').get();
console.log(`Production: ${prodTotal.c} memories (user_id=1)`);
console.log(`Backup-0501: ${backupTotal.c} memories (user_id=1)`);

// Find exact missing IDs
const prodIds = new Set(prodDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id));
const backupIds = backupDb.prepare('SELECT id FROM memories WHERE user_id = 1').all().map(r => r.id);
const missingIds = backupIds.filter(id => !prodIds.has(id));

console.log(`\nMissing from production: ${missingIds.length} memories`);
console.log(`Missing IDs: ${missingIds.join(', ')}`);

// Get details of ALL missing memories
if (missingIds.length > 0) {
  const placeholders = missingIds.map(() => '?').join(',');
  const missing = backupDb.prepare(`
    SELECT id, category, content, source, created_at, updated_at, importance
    FROM memories WHERE id IN (${placeholders})
    ORDER BY id
  `).all(...missingIds);
  
  console.log('\n=== ALL MISSING MEMORIES ===\n');
  for (const m of missing) {
    const preview = m.content.substring(0, 200).replace(/\n/g, ' ');
    console.log(`#${m.id} [${m.category}] (src: ${m.source || 'null'}, imp: ${m.importance}) ${m.created_at}`);
    console.log(`  ${preview}`);
    console.log();
  }
}

// Also check: what related tables exist and might need recovery
for (const table of ['memory_entities', 'memory_links', 'memory_projects', 'entities', 'entity_relationships']) {
  try {
    const prodCount = prodDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get();
    const backupCount = backupDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get();
    console.log(`${table}: prod=${prodCount.c}, backup=${backupCount.c}`);
  } catch (e) {
    console.log(`${table}: error - ${e.message}`);
  }
}

prodDb.close();
backupDb.close();
