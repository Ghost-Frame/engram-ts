import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerScratchRoutes } from '../src/scratch/routes.ts';
import type {
  ScratchEntryRow,
  ScratchEntry,
  ScratchKV,
  ScratchPutBody,
  ScratchPromoteBody,
  ScratchSummarizeBody,
} from '../src/scratch/types.ts';

describe('registerScratchRoutes', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof registerScratchRoutes, 'function');
  });
  it('accepts a router argument', () => {
    assert.strictEqual(registerScratchRoutes.length, 1);
  });
});

describe('scratch types', () => {
  it('ScratchEntryRow has expected fields', () => {
    const row: ScratchEntryRow = {
      session: 'sess-abc',
      agent: 'claude-code',
      model: 'claude-sonnet-4-6',
      entry_key: 'server_ip',
      value: '10.0.0.1',
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:01:00',
      expires_at: '2026-01-01 00:30:00',
    };
    assert.strictEqual(row.entry_key, 'server_ip');
    assert.strictEqual(row.agent, 'claude-code');
  });

  it('ScratchEntry has key (not entry_key)', () => {
    const entry: ScratchEntry = {
      session: 'sess-abc',
      agent: 'claude-code',
      model: 'claude-sonnet-4-6',
      key: 'server_ip',
      value: '10.0.0.1',
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:01:00',
      expires_at: '2026-01-01 00:30:00',
    };
    assert.strictEqual(entry.key, 'server_ip');
  });

  it('ScratchKV has key and value', () => {
    const kv: ScratchKV = { key: 'foo', value: 'bar' };
    assert.strictEqual(kv.key, 'foo');
    assert.strictEqual(kv.value, 'bar');
  });

  it('ScratchPutBody accepts valid shape', () => {
    const body: ScratchPutBody = {
      session: 'sess-abc',
      agent: 'claude-code',
      model: 'claude-sonnet-4-6',
      entries: [{ key: 'foo', value: 'bar' }],
      ttl: 60,
    };
    assert.strictEqual(body.session, 'sess-abc');
    assert.strictEqual(body.ttl, 60);
  });

  it('ScratchPutBody entries is optional', () => {
    const body: ScratchPutBody = { session: 'x' };
    assert.strictEqual(body.session, 'x');
    assert.strictEqual(body.entries, undefined);
  });

  it('ScratchPromoteBody accepts valid shape', () => {
    const body: ScratchPromoteBody = { keys: ['a', 'b'], combine: true, category: 'fact' };
    assert.ok(Array.isArray(body.keys));
    assert.strictEqual(body.combine, true);
    assert.strictEqual(body.category, 'fact');
  });

  it('ScratchSummarizeBody accepts valid shape', () => {
    const body: ScratchSummarizeBody = { delete: false };
    assert.strictEqual(body.delete, false);
  });

  it('ScratchSummarizeBody delete is optional', () => {
    const body: ScratchSummarizeBody = {};
    assert.strictEqual(body.delete, undefined);
  });
});
