// ============================================================================
// DURABLE JOB QUEUE -- DB-backed async processing with retries
// Replaces fire-and-forget setTimeout patterns
// ============================================================================

import { db } from "../db/index.ts";
import { log } from "../config/logger.ts";

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_at TEXT,
    completed_at TEXT,
    next_retry_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type, status);
`);

// Prepared statements
const enqueueStmt = db.prepare(
  `INSERT INTO jobs (type, payload, max_attempts) VALUES (?, ?, ?) RETURNING id`
);

const claimStmt = db.prepare(
  `UPDATE jobs SET status = 'running', claimed_at = datetime('now'), attempts = attempts + 1
   WHERE id = (
     SELECT id FROM jobs
     WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
     ORDER BY created_at ASC LIMIT 1
   ) RETURNING id, type, payload, attempts, max_attempts`
);

const completeStmt = db.prepare(
  `UPDATE jobs SET status = 'completed', completed_at = datetime('now'), error = NULL WHERE id = ?`
);

const failStmt = db.prepare(
  `UPDATE jobs SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?`
);

const retryStmt = db.prepare(
  `UPDATE jobs SET status = 'pending', error = ?, next_retry_at = datetime('now', '+' || ? || ' seconds') WHERE id = ?`
);

const statsStmt = db.prepare(
  `SELECT status, COUNT(*) as count FROM jobs GROUP BY status`
);

const cleanupStmt = db.prepare(
  `DELETE FROM jobs WHERE status = 'completed' AND completed_at < datetime('now', '-1 day')`
);

// Recover stuck jobs (claimed but never completed -- process crashed)
const recoverStmt = db.prepare(
  `UPDATE jobs SET status = 'pending', claimed_at = NULL
   WHERE status = 'running' AND claimed_at < datetime('now', '-5 minutes')`
);

// ── Public API ──────────────────────────────────────────────────────

export function enqueueJob(type: string, payload: Record<string, any>, maxAttempts: number = 3): number {
  const result = enqueueStmt.get(type, JSON.stringify(payload), maxAttempts) as { id: number };
  return result.id;
}

export type JobHandler = (payload: Record<string, any>) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export async function processNextJob(): Promise<boolean> {
  const job = claimStmt.get() as { id: number; type: string; payload: string; attempts: number; max_attempts: number } | undefined;
  if (!job) return false;

  const handler = handlers.get(job.type);
  if (!handler) {
    failStmt.run(`No handler registered for job type: ${job.type}`, job.id);
    log.error({ msg: "job_no_handler", job_id: job.id, type: job.type });
    return true;
  }

  try {
    const payload = JSON.parse(job.payload);
    await handler(payload);
    completeStmt.run(job.id);
    log.debug({ msg: "job_completed", job_id: job.id, type: job.type, attempt: job.attempts });
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    if (job.attempts >= job.max_attempts) {
      failStmt.run(errMsg, job.id);
      log.error({ msg: "job_failed_permanent", job_id: job.id, type: job.type, attempts: job.attempts, error: errMsg });
    } else {
      // Exponential backoff: 10s, 40s, 90s, ...
      const delaySec = 10 * job.attempts * job.attempts;
      retryStmt.run(errMsg, String(delaySec), job.id);
      log.warn({ msg: "job_retry", job_id: job.id, type: job.type, attempt: job.attempts, retry_in: delaySec, error: errMsg });
    }
  }
  return true;
}

// Process all pending jobs in a batch (up to limit)
export async function drainJobs(limit: number = 20): Promise<number> {
  let processed = 0;
  while (processed < limit) {
    const hadWork = await processNextJob();
    if (!hadWork) break;
    processed++;
  }
  return processed;
}

export function getJobStats(): Record<string, number> {
  const rows = statsStmt.all() as Array<{ status: string; count: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) result[row.status] = row.count;
  return result;
}

export function cleanupCompletedJobs(): number {
  return (cleanupStmt.run() as any).changes || 0;
}

export function recoverStuckJobs(): number {
  return (recoverStmt.run() as any).changes || 0;
}
