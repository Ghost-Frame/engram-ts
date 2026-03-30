import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerAuthKeysRoutes } from '../src/auth-keys/routes.ts';
import type {
  UserRow,
  CreateUserBody,
  KeyRow,
  CreateKeyBody,
  RotateKeyBody,
  SpaceRow,
  CreateSpaceBody,
  GuiAuthBody,
  BootstrapBody,
} from '../src/auth-keys/types.ts';

describe('registerAuthKeysRoutes', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof registerAuthKeysRoutes, 'function');
  });
  it('accepts a router argument', () => {
    assert.strictEqual(registerAuthKeysRoutes.length, 1);
  });
});

describe('auth-keys types', () => {
  it('UserRow has expected fields', () => {
    const row: UserRow = {
      id: 1,
      username: 'alice',
      email: null,
      is_admin: 0,
      created_at: '2026-01-01 00:00:00',
    };
    assert.strictEqual(row.id, 1);
    assert.strictEqual(row.username, 'alice');
    assert.strictEqual(row.is_admin, 0);
  });

  it('KeyRow has expected fields', () => {
    const row: KeyRow = {
      id: 42,
      key_prefix: 'eg_abc1234',
      name: 'default',
      scopes: 'read,write',
      rate_limit: 1000,
      is_active: 1,
      last_used_at: null,
      created_at: '2026-01-01 00:00:00',
    };
    assert.strictEqual(row.id, 42);
    assert.strictEqual(row.is_active, 1);
  });

  it('SpaceRow has expected fields', () => {
    const row: SpaceRow = {
      id: 7,
      name: 'default',
      description: null,
      created_at: '2026-01-01 00:00:00',
    };
    assert.strictEqual(row.id, 7);
    assert.strictEqual(row.name, 'default');
  });

  it('CreateUserBody accepts valid shape', () => {
    const body: CreateUserBody = { username: 'bob', email: 'bob@example.com', role: 'writer' };
    assert.strictEqual(body.username, 'bob');
  });

  it('CreateKeyBody accepts valid shape', () => {
    const body: CreateKeyBody = { name: 'mykey', scopes: 'read,write', rate_limit: 500 };
    assert.strictEqual(body.name, 'mykey');
  });

  it('RotateKeyBody accepts valid shape', () => {
    const body: RotateKeyBody = { key_id: 1 };
    assert.strictEqual(body.key_id, 1);
  });

  it('CreateSpaceBody accepts valid shape', () => {
    const body: CreateSpaceBody = { name: 'workspace', description: 'my space' };
    assert.strictEqual(body.name, 'workspace');
  });

  it('GuiAuthBody accepts valid shape', () => {
    const body: GuiAuthBody = { password: 'secret' };
    assert.strictEqual(body.password, 'secret');
  });

  it('BootstrapBody accepts valid shape', () => {
    const body: BootstrapBody = { token: 'abc123', name: 'admin' };
    assert.strictEqual(body.token, 'abc123');
  });
});
