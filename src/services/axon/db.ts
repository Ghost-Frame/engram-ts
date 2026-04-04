// ============================================================================
// Axon DB - Schema + prepared statements
// Migrations run at module scope so tables exist before statements compile.
// ============================================================================

import { db } from "../../db/index.ts";
import { log } from "../../config/logger.ts";

// - Schema (module-scope migration) --

function migrate(sql: string) {
  try { db.exec(sql); } catch (e: any) {
    const msg = String(e);
    if (msg.includes("duplicate column") || msg.includes("already exists")) return;
    log.warn({ msg: "axon_migrate_error", error: msg });
  }
}

migrate(`
  CREATE TABLE IF NOT EXISTS axon_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    retain_hours INTEGER NOT NULL DEFAULT 168
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS axon_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS axon_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    channel TEXT NOT NULL,
    filter_type TEXT,
    webhook_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent, channel)
  )
`);

migrate(`
  CREATE TABLE IF NOT EXISTS axon_cursors (
    agent TEXT NOT NULL,
    channel TEXT NOT NULL,
    last_event_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(agent, channel)
  )
`);

migrate(`CREATE INDEX IF NOT EXISTS idx_axon_events_channel ON axon_events(channel, created_at DESC)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_axon_events_type ON axon_events(type)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_axon_subs_channel ON axon_subscriptions(channel)`);

// - Seed default channels --

const seedChannel = db.prepare("INSERT OR IGNORE INTO axon_channels (name, description) VALUES (?, ?)");
seedChannel.run("system", "System-wide events (startup, shutdown, errors)");
seedChannel.run("memory", "Memory storage and retrieval events");
seedChannel.run("tasks", "Task lifecycle events (created, updated, completed)");
seedChannel.run("deploy", "Deployment and infrastructure events");
seedChannel.run("alerts", "Alerts and notifications");

// - Prepared statements --

export const insertEvent = db.prepare(
  "INSERT INTO axon_events (channel, source, type, payload) VALUES (?, ?, ?, ?)"
);

export const getEventById = db.prepare("SELECT * FROM axon_events WHERE id = ?");

export const upsertSubscription = db.prepare(
  `INSERT INTO axon_subscriptions (agent, channel, filter_type, webhook_url)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(agent, channel) DO UPDATE SET filter_type = excluded.filter_type, webhook_url = excluded.webhook_url`
);

export const deleteSubscription = db.prepare(
  "DELETE FROM axon_subscriptions WHERE agent = ? AND channel = ?"
);

export const getSubsByAgent = db.prepare(
  "SELECT * FROM axon_subscriptions WHERE agent = ? ORDER BY id"
);

export const getSubsByChannel = db.prepare(
  "SELECT * FROM axon_subscriptions WHERE channel = ? ORDER BY id"
);

export const getSubsWithWebhook = db.prepare(
  "SELECT * FROM axon_subscriptions WHERE channel = ? AND webhook_url IS NOT NULL"
);

export const upsertCursor = db.prepare(
  `INSERT INTO axon_cursors (agent, channel, last_event_id, updated_at)
   VALUES (?, ?, ?, datetime('now'))
   ON CONFLICT(agent, channel) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = datetime('now')`
);

export const getCursor = db.prepare(
  "SELECT * FROM axon_cursors WHERE agent = ? AND channel = ?"
);

export const channelCount = db.prepare("SELECT COUNT(*) as count FROM axon_channels");
export const eventCount = db.prepare("SELECT COUNT(*) as count FROM axon_events");
export const subscriptionCount = db.prepare("SELECT COUNT(*) as count FROM axon_subscriptions");
