// ============================================================================
// AUTH-KEYS DOMAIN -- Database prepared statements for users, keys, spaces
// ============================================================================

import { db } from "../db/connection.ts";

// -- Users -------------------------------------------------------------------

export function countActiveKeys(): number {
  return (db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE is_active = 1").get() as any).count;
}

export function insertUser(username: string, email: string | null, role: string, isAdmin: number): { id: number; created_at: string } {
  return db.prepare(
    "INSERT INTO users (username, email, role, is_admin) VALUES (?, ?, ?, ?) RETURNING id, created_at"
  ).get(username, email, role, isAdmin) as any;
}

export function insertDefaultSpace(userId: number): void {
  db.prepare("INSERT INTO spaces (user_id, name, description) VALUES (?, 'default', 'Default memory space')").run(userId);
}

export function listUsers(): any[] {
  return db.prepare(
    `SELECT u.id, u.username, u.email, u.is_admin, u.created_at,
       (SELECT COUNT(*) FROM memories WHERE user_id = u.id) as memory_count,
       (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id AND is_active = 1) as key_count
     FROM users u ORDER BY u.id`
  ).all();
}

// -- API Keys ----------------------------------------------------------------

export function insertApiKey(
  userId: number, prefix: string, hash: string,
  name: string, scopes: string, rateLimit: number, expiresAt: string | null,
): { id: number } {
  return db.prepare(
    "INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(userId, prefix, hash, name, scopes, rateLimit, expiresAt) as any;
}

export function insertBootstrapAdminKey(prefix: string, hash: string, name: string): void {
  db.prepare(
    "INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(1, prefix, hash, name, "read,write,admin", 1000);
}

export function listKeysForUser(userId: number): any[] {
  return db.prepare(
    `SELECT id, key_prefix, name, scopes, rate_limit, is_active, last_used_at, created_at
     FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
  ).all(userId);
}

export function getKeyOwner(id: number): { user_id: number } | undefined {
  return db.prepare("SELECT user_id FROM api_keys WHERE id = ?").get(id) as any;
}

export function revokeKey(id: number): void {
  db.prepare("UPDATE api_keys SET is_active = 0 WHERE id = ?").run(id);
}

export function getKeyForUser(keyId: number, userId: number): any {
  return db.prepare("SELECT * FROM api_keys WHERE id = ? AND user_id = ?").get(keyId, userId) as any;
}

export function insertRotatedKey(
  userId: number, prefix: string, hash: string,
  name: string, scopes: string, rateLimit: number, agentId: number | null, expiresAt: string | null,
): { id: number } {
  return db.prepare(
    `INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit, agent_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`
  ).get(userId, prefix, hash, name, scopes, rateLimit, agentId, expiresAt) as any;
}

export function setKeyExpiry(keyId: number, expiresAt: string): void {
  db.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run(expiresAt, keyId);
}

// -- Spaces ------------------------------------------------------------------

export function insertSpace(userId: number, name: string, description: string | null): { id: number; created_at: string } {
  return db.prepare(
    "INSERT INTO spaces (user_id, name, description) VALUES (?, ?, ?) RETURNING id, created_at"
  ).get(userId, name, description) as any;
}

export function listSpacesForUser(userId: number): any[] {
  return db.prepare(
    `SELECT s.id, s.name, s.description, s.created_at,
       (SELECT COUNT(*) FROM memories WHERE space_id = s.id) as memory_count
     FROM spaces s WHERE s.user_id = ? ORDER BY s.name`
  ).all(userId);
}

export function getSpaceOwner(id: number): { user_id: number; name: string } | undefined {
  return db.prepare("SELECT user_id, name FROM spaces WHERE id = ?").get(id) as any;
}

export function deleteSpace(id: number): void {
  db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
}
