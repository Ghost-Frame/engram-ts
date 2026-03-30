import { db } from "../db/connection.ts";
import { log } from "../config/logger.ts";

const insertAudit = db.prepare(
  `INSERT INTO audit_log (user_id, action, target_type, target_id, details, ip)
   VALUES (?, ?, ?, ?, ?, ?)`
);

export function auditLog(
  userId: number,
  action: string,
  resourceType: string,
  resourceId: number | string | null,
  details: string | null,
  ip: string,
): void {
  try {
    insertAudit.run(userId, action, resourceType, resourceId, details, ip);
  } catch (e: any) {
    log.warn({ msg: "audit_log_failed", action, error: e?.message });
  }
}

type EventPayload = Record<string, unknown>;
let webhookEmitter: ((userId: number, event: string, payload: EventPayload) => void) | null = null;

export function setWebhookEmitter(fn: (userId: number, event: string, payload: EventPayload) => void): void {
  webhookEmitter = fn;
}

export function emitEvent(userId: number, event: string, payload: EventPayload): void {
  if (webhookEmitter) {
    try { webhookEmitter(userId, event, payload); } catch {}
  }
}
