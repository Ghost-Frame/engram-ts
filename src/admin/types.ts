// ============================================================================
// ADMIN DOMAIN - Types
// ============================================================================

export interface ReembedResult {
  reembedded: number;
  failed: number;
  provider: Record<string, unknown>;
}

export interface BackfillResult {
  backfilled: number;
}

export interface CooccurrenceRebuildResult {
  rebuilt_pairs: number;
}

export interface CommunityDetectResult {
  communities: number;
  assigned: number;
  elapsed_ms?: number;
}

export interface RebuildFtsResult {
  rebuilt: boolean;
  rows: number;
  elapsed_ms: number;
}

export interface RefreshCacheResult {
  refreshed: boolean;
  elapsed_ms: number;
  total: number;
  cold_count: number;
  avg_search_ms: number;
}

export interface CompactResult {
  compacted: boolean;
  before_size_mb: number;
  after_size_mb: number;
  saved_mb: number;
  elapsed_ms: number;
}

export interface GcBreakdown {
  forgotten_stale: number;
  orphaned_links: number;
  expired_scratchpad: number;
  old_audit_entries: number;
  old_jobs: number;
  orphaned_signals: number;
}

export interface GcResult {
  dry_run: boolean;
  reclaimable_rows: number;
  breakdown: GcBreakdown;
  message: string;
}

export interface SchemaDriftResult {
  has_drift: boolean;
  missing_tables: string[];
  unexpected_tables: string[];
}

export interface SchemaResult {
  schema_version: number;
  tables: number;
  indexes: number;
  drift: SchemaDriftResult;
  table_details: Record<string, string>;
  migrations: unknown[];
}

export interface ScaleReportResult {
  tier: string;
  total_memories: number;
  embedding_cache: Record<string, unknown>;
  ann_prefilter: {
    enabled: boolean;
    threshold: number;
    candidate_multiplier: number;
  };
  cold_storage: {
    enabled: boolean;
    days: number;
    min_memories: number;
    active: boolean;
  };
  recommendations: string[];
}

export interface ColdStorageResult {
  config: {
    cold_storage_days: number;
    cold_min_memories: number;
    enabled: boolean;
  };
  totals: {
    all_memories: number;
    with_embedding: number;
    in_hot_cache: number;
    in_cold_storage: number;
  };
  distribution: unknown[];
  recommendation: string | null;
}

export interface MaintenanceStatus {
  maintenance: boolean;
  reason: string;
}

export interface SlaTargets {
  search_p95_under_200ms: { target: number; actual: number; met: boolean };
  store_p95_under_500ms: { target: number; actual: number; met: boolean };
  error_rate_under_1pct: { target: number; actual: number; met: boolean };
}

export interface SlaResult {
  period: { start: string; duration_hours: number };
  targets: SlaTargets;
  raw: {
    total_requests: number;
    total_errors_5xx: number;
    search_total: number;
    search_under_200ms: number;
    store_total: number;
    store_under_500ms: number;
  };
  overall_health: "healthy" | "degraded";
}

export interface UsageRow {
  username: string;
  user_id: number;
  event_type: string;
  total: number;
}

export interface UsageResult {
  period_start: string;
  totals: unknown[];
  by_user: UsageRow[];
}

export interface TenantRow {
  user_id: number;
  username: string;
  role: string;
  created_at: string;
  memory_count: number;
  conversation_count: number;
  active_keys: number;
  space_count: number;
  last_active: string | null;
  max_memories: number | null;
}

export interface ProvisionResult {
  user_id: number;
  username: string;
  api_key: string;
  api_key_id: number;
  space: string;
}

export interface DeprovisionResult {
  deprovisioned: boolean;
  user_id: number;
  username: string;
  rows_deleted: number;
}

export interface CheckpointResult {
  checkpointed: boolean;
  busy: number;
  log: number;
  checkpointed_pages: number;
}

export interface BackupVerifyResult {
  integrity: string;
  foreign_key_violations: number;
  foreign_key_details?: unknown[];
  wal_pages: unknown;
  memories: number;
  tables: number;
  db_size_mb: number;
}

export interface ExportData {
  version: string;
  exported_at: string;
  memories: unknown[];
  links: unknown[];
  stats: { memory_count: number; link_count: number };
}

export interface ImportResult {
  imported: number;
  failed: number;
  total: number;
}

export interface ResetResult {
  reset: boolean;
  user_id: number;
  source?: string;
  memories_deleted?: number;
  scoped?: boolean;
}

export interface StateRow {
  key: string;
  value: string;
  user_id: number;
  updated_at: string;
}

export interface AuditEntry {
  id: number;
  user_id: number | null;
  action: string;
  target_type: string | null;
  target_id: number | null;
  details: string | null;
  ip: string | null;
  created_at: string;
}
