// ============================================================================
// WEBHOOKS — Event dispatch
// ============================================================================

import { db } from "../db/index.ts";
import { log } from "../config/logger.ts";
import { createHmac } from "crypto";
import { validatePublicUrlWithDNS } from "../helpers/index.ts";

const getActiveWebhooks = db.prepare(
  "SELECT id, url, events, secret FROM webhooks WHERE user_id = ? AND active = 1"
);
const webhookTriggered = db.prepare(
  "UPDATE webhooks SET last_triggered_at = datetime('now'), failure_count = 0 WHERE id = ?"
);
const webhookFailed = db.prepare(
  "UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?"
);
const WEBHOOK_FAILURE_THRESHOLD = 10;
const webhookDisable = db.prepare(
  "UPDATE webhooks SET active = 0 WHERE id = ?"
);
function recordWebhookFailure(hookId: number): void {
  webhookFailed.run(hookId);
  const row = db.prepare("SELECT failure_count FROM webhooks WHERE id = ?").get(hookId) as { failure_count: number } | undefined;
  if (row && row.failure_count >= WEBHOOK_FAILURE_THRESHOLD) {
    webhookDisable.run(hookId);
    log.warn({ msg: "webhook_auto_disabled", webhook_id: hookId, failures: row.failure_count });
  }
}


// In-flight promise tracking for clean shutdown
const _inFlight = new Set<Promise<void>>();
export function drainWebhooks(): Promise<void[]> {
  return Promise.all([..._inFlight]);
}

export async function emitWebhookEvent(
  event: string,
  payload: Record<string, unknown>,
  userId: number = 1
): Promise<void> {
  const hooks = getActiveWebhooks.all(userId) as Array<{
    id: number; url: string; events: string; secret: string | null;
  }>;

  for (const hook of hooks) {
    try {
      const events = JSON.parse(hook.events) as string[];
      if (!events.includes("*") && !events.includes(event)) continue;

      // Dispatch-time SSRF revalidation (prevents DNS rebinding)
      const urlError = await validatePublicUrlWithDNS(hook.url, "Webhook URL");
      if (urlError) {
        log.error({ msg: "webhook_ssrf_blocked", webhook_id: hook.id, error: urlError });
        recordWebhookFailure(hook.id);
        continue;
      }

      const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (hook.secret) {
        const hmac = createHmac("sha256", hook.secret).update(body).digest("hex");
        headers["X-Engram-Signature"] = `sha256=${hmac}`;
      }

      const delivery = fetch(hook.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10000), redirect: "error" })
        .then(resp => {
          if (resp.ok) { webhookTriggered.run(hook.id); }
          else { recordWebhookFailure(hook.id); }
        })
        .catch(() => { recordWebhookFailure(hook.id); })
        .finally(() => { _inFlight.delete(delivery); }) as Promise<void>;
      _inFlight.add(delivery);
    } catch {}
  }
}
