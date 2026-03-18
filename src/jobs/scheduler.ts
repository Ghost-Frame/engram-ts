// ============================================================================
// SCHEDULER LEASES -- Prevent duplicate background job execution
// Makes multi-instance deployment safe
// ============================================================================

import { db } from "../db/index.ts";
import { log } from "../config/logger.ts";
import { randomUUID } from "crypto";

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduler_leases (
    job_name TEXT PRIMARY KEY,
    holder_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    last_run_at TEXT
  )
`);

const INSTANCE_ID = randomUUID().slice(0, 8);

const acquireStmt = db.prepare(
  `INSERT INTO scheduler_leases (job_name, holder_id, expires_at)
   VALUES (?, ?, datetime('now', '+' || ? || ' seconds'))
   ON CONFLICT(job_name) DO UPDATE SET
     holder_id = excluded.holder_id,
     acquired_at = datetime('now'),
     expires_at = excluded.expires_at
   WHERE scheduler_leases.expires_at < datetime('now')
      OR scheduler_leases.holder_id = excluded.holder_id`
);

const releaseStmt = db.prepare(
  `DELETE FROM scheduler_leases WHERE job_name = ? AND holder_id = ?`
);

const touchStmt = db.prepare(
  `UPDATE scheduler_leases SET last_run_at = datetime('now') WHERE job_name = ? AND holder_id = ?`
);

/**
 * Try to acquire a lease for a named background job.
 * Returns true if this instance holds the lease.
 * ttlSeconds controls how long the lease is valid (should be > interval).
 */
export function acquireLease(jobName: string, ttlSeconds: number = 600): boolean {
  try {
    const result = acquireStmt.run(jobName, INSTANCE_ID, String(ttlSeconds));
    return (result as any).changes > 0;
  } catch {
    return false;
  }
}

/**
 * Release a lease (e.g., on shutdown).
 */
export function releaseLease(jobName: string): void {
  releaseStmt.run(jobName, INSTANCE_ID);
}

/**
 * Mark that a leased job just ran successfully.
 */
export function touchLease(jobName: string): void {
  touchStmt.run(jobName, INSTANCE_ID);
}

/**
 * Wrap a scheduled job function with lease protection.
 * Only one instance will run the job at a time.
 */
export function withLease(
  jobName: string,
  fn: () => Promise<void> | void,
  ttlSeconds: number = 600
): () => Promise<void> {
  return async () => {
    if (!acquireLease(jobName, ttlSeconds)) {
      log.debug({ msg: "lease_skipped", job: jobName, instance: INSTANCE_ID });
      return;
    }
    try {
      await fn();
      touchLease(jobName);
    } catch (e: any) {
      log.error({ msg: "leased_job_failed", job: jobName, error: e.message });
    }
  };
}

/**
 * Release all leases held by this instance (call on shutdown).
 */
export function releaseAllLeases(): void {
  try {
    db.prepare("DELETE FROM scheduler_leases WHERE holder_id = ?").run(INSTANCE_ID);
    log.info({ msg: "leases_released", instance: INSTANCE_ID });
  } catch {}
}

export { INSTANCE_ID };
