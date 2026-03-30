import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Types smoke test
import type {
  ReembedResult,
  BackfillResult,
  CooccurrenceRebuildResult,
  RebuildFtsResult,
  RefreshCacheResult,
  CompactResult,
  GcResult,
  GcBreakdown,
  SchemaResult,
  SchemaDriftResult,
  ScaleReportResult,
  ColdStorageResult,
  MaintenanceStatus,
  SlaResult,
  SlaTargets,
  UsageRow,
  UsageResult,
  TenantRow,
  ProvisionResult,
  DeprovisionResult,
  CheckpointResult,
  BackupVerifyResult,
  ExportData,
  ImportResult,
  ResetResult,
  StateRow,
  AuditEntry,
} from '../src/admin/types.ts';

// Route export test
import { registerAdminRoutes } from '../src/admin/routes.ts';

describe('registerAdminRoutes', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof registerAdminRoutes, 'function');
  });
});

describe('admin types', () => {
  it('GcResult structure is correct', () => {
    const result: GcResult = {
      dry_run: true,
      reclaimable_rows: 42,
      breakdown: {
        forgotten_stale: 10,
        orphaned_links: 5,
        expired_scratchpad: 3,
        old_audit_entries: 20,
        old_jobs: 4,
        orphaned_signals: 0,
      },
      message: 'Run with { dry_run: false } to execute cleanup',
    };
    assert.strictEqual(result.dry_run, true);
    assert.strictEqual(result.reclaimable_rows, 42);
    assert.strictEqual(result.breakdown.forgotten_stale, 10);
  });

  it('MaintenanceStatus structure is correct', () => {
    const status: MaintenanceStatus = { maintenance: false, reason: '' };
    assert.strictEqual(status.maintenance, false);
  });

  it('ExportData structure is correct', () => {
    const data: ExportData = {
      version: 'engram-v5.9',
      exported_at: new Date().toISOString(),
      memories: [],
      links: [],
      stats: { memory_count: 0, link_count: 0 },
    };
    assert.strictEqual(data.version, 'engram-v5.9');
    assert.strictEqual(data.stats.memory_count, 0);
  });

  it('SlaResult structure is correct', () => {
    const sla: SlaResult = {
      period: { start: new Date().toISOString(), duration_hours: 1 },
      targets: {
        search_p95_under_200ms: { target: 95, actual: 100, met: true },
        store_p95_under_500ms: { target: 95, actual: 98, met: true },
        error_rate_under_1pct: { target: 1, actual: 0, met: true },
      },
      raw: {
        total_requests: 1000,
        total_errors_5xx: 0,
        search_total: 500,
        search_under_200ms: 500,
        store_total: 200,
        store_under_500ms: 200,
      },
      overall_health: 'healthy',
    };
    assert.strictEqual(sla.overall_health, 'healthy');
    assert.strictEqual(sla.targets.search_p95_under_200ms.met, true);
  });

  it('ImportResult structure is correct', () => {
    const result: ImportResult = { imported: 5, failed: 1, total: 6 };
    assert.strictEqual(result.imported + result.failed, result.total);
  });

  it('ProvisionResult has required fields', () => {
    const result: ProvisionResult = {
      user_id: 1,
      username: 'testuser',
      api_key: 'eg_test',
      api_key_id: 1,
      space: 'default',
    };
    assert.ok(result.api_key.length > 0);
  });

  it('AuditEntry structure is correct', () => {
    const entry: AuditEntry = {
      id: 1,
      user_id: 1,
      action: 'backup',
      target_type: null,
      target_id: null,
      details: '1024 bytes',
      ip: '127.0.0.1',
      created_at: new Date().toISOString(),
    };
    assert.strictEqual(entry.action, 'backup');
  });
});
