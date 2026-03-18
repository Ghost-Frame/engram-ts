// ============================================================================
// SIMHASH - Near-duplicate detection via locality-sensitive hashing
// Inspired by Mem0/OpenMemory's approach. 64-bit fingerprint with Hamming
// distance comparison. Detects near-duplicates BEFORE embedding (saves compute).
// ============================================================================

import { db } from "../db/index.ts";
import { log } from "../config/logger.ts";

const HASH_BITS = 64;

// Canonical tokenization: lowercase, dedup, filter short tokens
function canonicalTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3);
  return [...new Set(tokens)];
}

// FNV-1a 32-bit hash for a token (fast, good distribution)
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// Compute a 64-bit SimHash as a hex string
export function computeSimHash(text: string): string {
  const tokens = canonicalTokens(text);
  if (tokens.length === 0) return "0".repeat(16);

  const vec = new Int32Array(HASH_BITS);

  for (const token of tokens) {
    // Use two FNV hashes to get 64 bits
    const h1 = fnv1a(token);
    const h2 = fnv1a(token + "\x00");

    for (let i = 0; i < 32; i++) {
      vec[i] += (h1 & (1 << i)) ? 1 : -1;
      vec[32 + i] += (h2 & (1 << i)) ? 1 : -1;
    }
  }

  // Convert sign vector to hex
  let hex = "";
  for (let nibbleIdx = 0; nibbleIdx < 16; nibbleIdx++) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit++) {
      const vecIdx = nibbleIdx * 4 + bit;
      if (vec[vecIdx] > 0) nibble |= (1 << bit);
    }
    hex += nibble.toString(16);
  }

  return hex;
}

// Hamming distance between two hex-encoded SimHashes
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return HASH_BITS;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    // Count bits in nibble
    dist += ((xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1));
  }
  return dist;
}

// Default threshold: 3 bits difference (from Mem0 research)
const SIMHASH_THRESHOLD = 3;

let simhashColumnExists: boolean | null = null;

function ensureSimHashColumn(): boolean {
  if (simhashColumnExists === true) return true;
  if (simhashColumnExists === false) return false;
  try {
    const row = db.prepare(
      "SELECT 1 FROM pragma_table_info('memories') WHERE name = 'simhash'"
    ).get();
    if (row) {
      simhashColumnExists = true;
      return true;
    }
    // Add column if missing
    db.exec("ALTER TABLE memories ADD COLUMN simhash TEXT DEFAULT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_simhash ON memories(simhash) WHERE simhash IS NOT NULL");
    simhashColumnExists = true;
    log.info({ msg: "simhash_column_added" });
    return true;
  } catch (e: any) {
    log.warn({ msg: "simhash_column_check_failed", error: e.message });
    simhashColumnExists = false;
    return false;
  }
}

let findBySimHash: ReturnType<typeof db.prepare<any[]>> | null = null;
let updateSimHash: ReturnType<typeof db.prepare<any[]>> | null = null;
let boostSourceCount: ReturnType<typeof db.prepare<any[]>> | null = null;

function getStatements() {
  if (!findBySimHash) {
    findBySimHash = db.prepare(
      "SELECT id, content, simhash, source_count FROM memories WHERE user_id = ? AND simhash IS NOT NULL AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 LIMIT 500"
    );
  }
  if (!updateSimHash) {
    updateSimHash = db.prepare("UPDATE memories SET simhash = ? WHERE id = ?");
  }
  if (!boostSourceCount) {
    boostSourceCount = db.prepare(
      "UPDATE memories SET source_count = source_count + 1, updated_at = datetime('now') WHERE id = ?"
    );
  }
}

export interface SimHashResult {
  isDuplicate: boolean;
  existingId?: number;
  existingContent?: string;
  distance?: number;
  simhash: string;
}

// Check if content is a near-duplicate of existing memories.
// Returns the existing memory ID if duplicate found, null otherwise.
export function checkSimHashDuplicate(content: string, userId: number): SimHashResult {
  const hash = computeSimHash(content);

  if (!ensureSimHashColumn()) {
    return { isDuplicate: false, simhash: hash };
  }

  getStatements();

  try {
    const candidates = findBySimHash!.all(userId) as Array<{
      id: number;
      content: string;
      simhash: string;
      source_count: number;
    }>;

    let bestMatch: { id: number; content: string; distance: number } | null = null;

    for (const c of candidates) {
      const dist = hammingDistance(hash, c.simhash);
      if (dist <= SIMHASH_THRESHOLD) {
        if (!bestMatch || dist < bestMatch.distance) {
          bestMatch = { id: c.id, content: c.content, distance: dist };
        }
      }
    }

    if (bestMatch) {
      return {
        isDuplicate: true,
        existingId: bestMatch.id,
        existingContent: bestMatch.content,
        distance: bestMatch.distance,
        simhash: hash,
      };
    }
  } catch (e: any) {
    log.warn({ msg: "simhash_check_failed", error: e.message });
  }

  return { isDuplicate: false, simhash: hash };
}

// Store the SimHash for a newly created memory
export function storeSimHash(memoryId: number, simhash: string): void {
  if (!ensureSimHashColumn()) return;
  getStatements();
  try {
    updateSimHash!.run(simhash, memoryId);
  } catch (e: any) {
    log.warn({ msg: "simhash_store_failed", error: e.message });
  }
}

// Boost source_count of an existing duplicate instead of creating new
export function boostDuplicate(existingId: number): void {
  if (!ensureSimHashColumn()) return;
  getStatements();
  try {
    boostSourceCount!.run(existingId);
  } catch (e: any) {
    log.warn({ msg: "simhash_boost_failed", error: e.message });
  }
}
