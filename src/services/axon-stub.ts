// ============================================================================
// Axon stub — Phase 1 placeholder for event bus
// Replaced with real publish() in Phase 2 when Axon is absorbed.
// ============================================================================

import { log } from "../config/logger.ts";

/**
 * Fire-and-forget event emission stub.
 * In standalone services, this was an HTTP POST to Axon at port 4600.
 * Phase 1: log at debug level only.
 * Phase 2: replace with real internal bus.
 */
export function publish(channel: string, source: string, type: string, payload: Record<string, unknown>): void {
  log.debug({ msg: "axon_stub", channel, source, type, payload_keys: Object.keys(payload) });
}
