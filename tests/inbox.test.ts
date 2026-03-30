import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerInboxRoutes } from '../src/inbox/routes.ts';
import {
  listPending,
  countPending,
  approveMemory,
  rejectMemory,
  getMemoryWithoutEmbedding,
} from '../src/inbox/db.ts';

describe('registerInboxRoutes', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof registerInboxRoutes, 'function');
  });
});

describe('inbox db exports', () => {
  it('listPending is an object (prepared statement)', () => {
    assert.strictEqual(typeof listPending, 'object');
    assert.ok(listPending !== null);
  });
  it('countPending is an object (prepared statement)', () => {
    assert.strictEqual(typeof countPending, 'object');
    assert.ok(countPending !== null);
  });
  it('approveMemory is an object (prepared statement)', () => {
    assert.strictEqual(typeof approveMemory, 'object');
    assert.ok(approveMemory !== null);
  });
  it('rejectMemory is an object (prepared statement)', () => {
    assert.strictEqual(typeof rejectMemory, 'object');
    assert.ok(rejectMemory !== null);
  });
  it('getMemoryWithoutEmbedding is an object (prepared statement)', () => {
    assert.strictEqual(typeof getMemoryWithoutEmbedding, 'object');
    assert.ok(getMemoryWithoutEmbedding !== null);
  });
});
