// ============================================================================
// AUTH-KEYS DOMAIN - Type definitions for users, API keys, and spaces
// ============================================================================

/** A user row as returned from the users table */
export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  is_admin: number;
  created_at: string;
  memory_count?: number;
  key_count?: number;
}

/** A user creation request body */
export interface CreateUserBody {
  username?: string;
  email?: string;
  role?: string;
}

/** A key row as returned from the api_keys table */
export interface KeyRow {
  id: number;
  key_prefix: string;
  name: string;
  scopes: string;
  rate_limit: number;
  is_active: number;
  last_used_at: string | null;
  created_at: string;
}

/** A key creation request body */
export interface CreateKeyBody {
  user_id?: number;
  name?: string;
  scopes?: string;
  rate_limit?: number;
  expires_at?: string;
}

/** A key rotation request body */
export interface RotateKeyBody {
  key_id?: number;
  expires_at?: string;
}

/** A space row as returned from the spaces table */
export interface SpaceRow {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  memory_count?: number;
}

/** A space creation request body */
export interface CreateSpaceBody {
  name?: string;
  description?: string;
}

/** GUI auth request body */
export interface GuiAuthBody {
  password?: string;
}

/** Bootstrap request body */
export interface BootstrapBody {
  token?: string;
  name?: string;
}
