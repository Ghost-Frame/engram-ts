// ============================================================================
// SCRATCH PAD DOMAIN - Database prepared statements
// ============================================================================

import { db } from "../db/connection.ts";
import type { ScratchEntryRow } from "./types.ts";

// Re-export the shared scratchpad statements from the main db module
export {
  upsertScratchEntryWithTTL,
  upsertScratchEntry,
  getScratchSessionAll,
  listScratchEntries,
  listScratchEntriesForContext,
  deleteScratchSession,
  deleteScratchSessionKey,
  purgeExpiredScratchpad,
} from "../db/index.ts";

// Export db for cases where routes need raw db access (transactions)
export { db } from "../db/connection.ts";
