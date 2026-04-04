// ============================================================================
// WEBHOOKS DOMAIN - Type definitions
// ============================================================================

/** A registered webhook */
export interface WebhookRow {
  id: number;
  url: string;
  events: string; // JSON array stored as string; parsed before returning
  active: number;
  last_triggered_at: string | null;
  failure_count: number;
  created_at: string;
  user_id?: number;
  secret?: string | null;
}

/** Body for creating a webhook */
export interface CreateWebhookBody {
  url: string;
  events?: string[];
  secret?: string | null;
}

/** Result returned from insertWebhook RETURNING clause */
export interface InsertWebhookResult {
  id: number;
  created_at: string;
}

/** A memory row returned by getChangesSince */
export interface SyncChangeRow {
  id: number;
  content: string;
  category: string;
  source: string;
  session_id: string | null;
  importance: number;
  tags: string | null;
  confidence: number;
  sync_id: string | null;
  is_static: number;
  is_forgotten: number;
  is_archived: number;
  version: number;
  created_at: string;
  updated_at: string;
}

/** A memory row used for conflict resolution in sync receive */
export interface SyncExistingRow {
  id: number;
  updated_at: string;
}

/** An incoming memory in a sync receive request */
export interface SyncMemoryPayload {
  sync_id: string;
  content: string;
  category?: string;
  source?: string;
  session_id?: string | null;
  importance?: number;
  tags?: string[] | null;
  confidence?: number;
  is_static?: boolean;
  is_forgotten?: boolean;
  is_archived?: boolean;
  version?: number;
  model?: string | null;
  updated_at?: string;
}
