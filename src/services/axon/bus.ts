// ============================================================================
// Axon bus engine - pub/sub, SSE streaming, webhook fan-out, cursor polling
// Replaces the no-op axon-stub.ts with a real event bus.
// ============================================================================

import { db } from "../../db/index.ts";
import { log } from "../../config/logger.ts";
import { validatePublicUrlWithDNS } from "../../helpers/index.ts";
import { parseJsonFields, parseJsonFieldsAll } from "../helpers.ts";
import {
  insertEvent, getEventById,
  upsertSubscription, deleteSubscription as deleteSubStmt,
  getSubsByAgent, getSubsByChannel, getSubsWithWebhook,
  upsertCursor, getCursor,
  channelCount, eventCount, subscriptionCount,
} from "./db.ts";

// - SSE client tracking --

interface SSEClient {
  controller: ReadableStreamDefaultController;
  agent: string;
  channels: Set<string>;
  filterType: string | null;
}

const sseClients = new Map<string, SSEClient>();
let clientIdCounter = 0;

const encoder = new TextEncoder();

// - Publish --

export function publish(channel: string, source: string, type: string, payload: Record<string, unknown>): void {
  if (type.includes("\n")) {
    log.warn({ msg: "axon_publish_rejected", reason: "type contains newline", channel, source, type });
    return;
  }

  const info = insertEvent.run(channel, source, type, JSON.stringify(payload));
  const eventId = Number(info.lastInsertRowid);

  log.debug({ msg: "axon_publish", id: eventId, channel, source, type, payload_keys: Object.keys(payload) });

  // Fan out to SSE clients
  const sseData = `id: ${eventId}\nevent: ${type}\ndata: ${JSON.stringify({ id: eventId, channel, source, type, payload })}\n\n`;
  const encoded = encoder.encode(sseData);

  for (const [clientId, client] of sseClients) {
    if (!client.channels.has(channel)) continue;
    if (client.filterType && client.filterType !== type) continue;
    try {
      client.controller.enqueue(encoded);
    } catch {
      sseClients.delete(clientId);
    }
  }

  // Fan out to webhook subscribers (fire-and-forget)
  const webhookSubs = getSubsWithWebhook.all(channel) as Array<{ webhook_url: string; filter_type: string | null }>;
  for (const sub of webhookSubs) {
    if (sub.filter_type && sub.filter_type !== type) continue;
    if (!sub.webhook_url) continue;
    fetch(sub.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: eventId, channel, source, type, payload }),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      log.warn({ msg: "axon_webhook_error", url: sub.webhook_url, error: String(err) });
    });
  }
}

// - Query events --

export function getEvents(opts: {
  channel?: string;
  type?: string;
  source?: string;
  since_id?: number;
  limit?: number;
}) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.channel) { clauses.push("channel = ?"); params.push(opts.channel); }
  if (opts.type) { clauses.push("type = ?"); params.push(opts.type); }
  if (opts.source) { clauses.push("source = ?"); params.push(opts.source); }
  if (opts.since_id !== undefined) { clauses.push("id > ?"); params.push(opts.since_id); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit ?? 100;
  const rows = db.prepare(
    `SELECT * FROM axon_events ${where} ORDER BY id DESC LIMIT ?`
  ).all(...params, limit) as Record<string, unknown>[];

  return parseJsonFieldsAll(rows, "payload");
}

export function getEvent(id: number) {
  const row = getEventById.get(id) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "payload");
}

// - Channels --

export function listChannels() {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM axon_events WHERE channel = c.name) as event_count,
      (SELECT COUNT(*) FROM axon_subscriptions WHERE channel = c.name) as subscriber_count
    FROM axon_channels c ORDER BY c.name
  `).all();
}

export function createChannel(name: string, description?: string, retainHours?: number) {
  const retain = retainHours ?? 168;
  db.prepare(
    "INSERT INTO axon_channels (name, description, retain_hours) VALUES (?, ?, ?)"
  ).run(name, description ?? null, retain);
  return db.prepare("SELECT * FROM axon_channels WHERE name = ?").get(name);
}

// - Subscriptions --

export async function subscribe(
  agent: string,
  channel: string,
  filterType?: string,
  webhookUrl?: string,
) {
  if (webhookUrl) {
    const err = await validatePublicUrlWithDNS(webhookUrl, "webhook_url");
    if (err) throw new Error(err);
  }

  upsertSubscription.run(agent, channel, filterType ?? null, webhookUrl ?? null);
  return { agent, channel, filter_type: filterType ?? null, webhook_url: webhookUrl ?? null };
}

export function unsubscribe(agent: string, channel: string): boolean {
  const info = deleteSubStmt.run(agent, channel);
  return info.changes > 0;
}

export function getSubscriptions(agent?: string) {
  if (agent) {
    return getSubsByAgent.all(agent);
  }
  return db.prepare("SELECT * FROM axon_subscriptions ORDER BY id").all();
}

// - Cursor-based polling --

export function poll(agent: string, channel: string, limit: number) {
  const cursor = getCursor.get(agent, channel) as { last_event_id: number } | undefined;
  const lastId = cursor?.last_event_id ?? 0;

  const rows = db.prepare(
    "SELECT * FROM axon_events WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT ?"
  ).all(channel, lastId, limit) as Record<string, unknown>[];

  const events = parseJsonFieldsAll(rows, "payload");

  if (events.length > 0) {
    const maxId = (events[events.length - 1] as any).id as number;
    upsertCursor.run(agent, channel, maxId);
  }

  return { events, cursor: { agent, channel, last_event_id: events.length > 0 ? (events[events.length - 1] as any).id : lastId } };
}

// - SSE streaming --

export function startSSE(
  agent: string,
  channels: string[],
  filterType?: string,
  lastEventId?: number,
): Response {
  const clientId = `sse-${++clientIdCounter}`;
  let heartbeatTimer: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
      sseClients.set(clientId, {
        controller,
        agent,
        channels: new Set(channels),
        filterType: filterType ?? null,
      });

      // Send initial OK comment
      controller.enqueue(encoder.encode(":ok\n\n"));

      // Replay missed events if lastEventId provided
      if (lastEventId !== undefined) {
        for (const ch of channels) {
          const missed = db.prepare(
            "SELECT * FROM axon_events WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT 1000"
          ).all(ch, lastEventId) as Record<string, unknown>[];

          for (const row of missed) {
            const parsed = parseJsonFields({ ...row }, "payload");
            if (parsed) {
              if (filterType && parsed.type !== filterType) continue;
              const data = `id: ${parsed.id}\nevent: ${parsed.type}\ndata: ${JSON.stringify(parsed)}\n\n`;
              controller.enqueue(encoder.encode(data));
            }
          }
        }
      }

      // Heartbeat every 30s
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":heartbeat\n\n"));
        } catch {
          clearInterval(heartbeatTimer);
          sseClients.delete(clientId);
        }
      }, 30000);
    },
    cancel() {
      clearInterval(heartbeatTimer);
      sseClients.delete(clientId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// - Pruning --

export function pruneEvents() {
  const prune = db.transaction(() => {
    const channels = db.prepare("SELECT name, retain_hours FROM axon_channels").all() as Array<{ name: string; retain_hours: number }>;
    let totalDeleted = 0;

    for (const ch of channels) {
      const info = db.prepare(
        "DELETE FROM axon_events WHERE channel = ? AND created_at < datetime('now', '-' || ? || ' hours')"
      ).run(ch.name, ch.retain_hours);
      totalDeleted += info.changes;
    }

    return totalDeleted;
  });

  const deleted = prune();
  if (deleted > 0) {
    log.info({ msg: "axon_prune", deleted });
  }
  return deleted;
}

// - Stats --

export function getStats() {
  const channels = (channelCount.get() as any).count;
  const events = (eventCount.get() as any).count;
  const subscriptions = (subscriptionCount.get() as any).count;
  const sse_clients = sseClients.size;

  return { channels, events, subscriptions, sse_clients };
}
