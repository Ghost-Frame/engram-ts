import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerHealthRoutes } from '../src/health/routes.ts';
import { registerHealthRoutes as registerHealthRoutesIndex } from '../src/health/index.ts';

describe('registerHealthRoutes', () => {
  it('is exported as a function from routes.ts', () => {
    assert.strictEqual(typeof registerHealthRoutes, 'function');
  });
  it('is exported as a function from index.ts', () => {
    assert.strictEqual(typeof registerHealthRoutesIndex, 'function');
  });
  it('routes and index exports are the same function', () => {
    assert.strictEqual(registerHealthRoutes, registerHealthRoutesIndex);
  });
});
