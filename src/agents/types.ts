// ============================================================================
// AGENTS DOMAIN - Type definitions
// ============================================================================

/** A registered agent row */
export interface AgentRow {
  id: number;
  user_id: number;
  name: string;
  category: string | null;
  description: string | null;
  code_hash: string | null;
  trust_score: number;
  total_ops: number;
  successful_ops: number;
  failed_ops: number;
  guard_allows: number;
  guard_warns: number;
  guard_blocks: number;
  is_active: number;
  last_seen_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
}

/** Minimal safe agent row (without code_hash) */
export type SafeAgentRow = Omit<AgentRow, "code_hash">;

/** Body for registering an agent */
export interface RegisterAgentBody {
  name: string;
  category?: string | null;
  description?: string | null;
  code_hash?: string | null;
}

/** Result from insertAgent RETURNING clause */
export interface InsertAgentResult {
  id: number;
  trust_score: number;
  created_at: string;
}

/** Body for revoking an agent */
export interface RevokeAgentBody {
  reason?: string;
}

/** Body for linking a key to an agent */
export interface LinkKeyBody {
  key_id: string;
}

/** An execution/audit log row for an agent */
export interface AgentExecutionRow {
  id: number;
  action: string;
  target_type: string | null;
  target_id: number | null;
  details: string | null;
  execution_hash: string | null;
  signature: string | null;
  created_at: string;
}

/** Passport issued for an agent */
export interface AgentPassport {
  agent_id: number;
  user_id: number;
  name: string;
  trust_score: number;
  issued_at: string;
  expires_at?: string;
  signature: string;
}

/** Result of a verify call */
export interface VerifyResult {
  type: "passport" | "execution" | "message" | "tool_manifest";
  valid?: boolean;
  [key: string]: unknown;
}
