// ============================================================================
// GROUNDING TYPES - Tool execution framework type definitions
// Ported from OpenSpace grounding/core/types.py
// ============================================================================

// --- Enums ---

export type BackendType = "mcp" | "shell" | "web" | "gui" | "system";
export type ToolStatus = "success" | "error";
export type SessionStatus = "connected" | "disconnected" | "connecting";

// --- Security ---

export interface SecurityPolicy {
  allow_shell_commands: boolean;
  allow_network_access: boolean;
  allow_file_access: boolean;
  allowed_domains: string[];
  blocked_commands: string[];
  sandbox_enabled: boolean;
}

// --- Tool definitions ---

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
  return_schema?: Record<string, any>;
  examples?: Array<Record<string, any>>;
  usage_hint?: string;
  latency_hint?: string;
  backend_type: BackendType;
  security_policy?: SecurityPolicy;
}

export interface ToolResult {
  status: ToolStatus;
  content: any;
  error?: string;
  execution_time_ms?: number;
}

// --- Sessions ---

export interface SessionConfig {
  name: string;
  backend: BackendType;
  timeout_ms?: number;
  max_retries?: number;
  metadata?: Record<string, any>;
}

export interface SessionInfo {
  id: string;
  name: string;
  backend: BackendType;
  status: SessionStatus;
  tools: string[];
  created_at: string;
  last_activity_at: string;
  metadata?: Record<string, any>;
}

// --- Provider interface ---

export interface GroundingProvider {
  readonly type: BackendType;
  readonly name: string;

  initialize(): Promise<void>;
  getTools(): Promise<ToolSchema[]>;
  executeTool(toolName: string, args: Record<string, any>, timeoutMs?: number): Promise<ToolResult>;
  createSession(config: SessionConfig): Promise<SessionInfo>;
  destroySession(sessionId: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}

// --- Quality tracking ---

export interface ExecutionRecord {
  timestamp: string;
  success: boolean;
  execution_time_ms: number;
  error_message?: string;
}

export interface ToolQualityRecord {
  tool_key: string;
  backend: string;
  server: string;
  tool_name: string;
  description_hash: string;
  total_calls: number;
  total_successes: number;
  total_failures: number;
  avg_execution_ms: number;
  llm_flagged_count: number;
  quality_score: number;
  last_execution_at: string | null;
}

// --- Tool key helpers ---

export function buildToolKey(backend: string, server: string, toolName: string): string {
  return `${backend}:${server}:${toolName}`;
}

export function parseToolKey(key: string): { backend: string; server: string; tool_name: string } {
  const parts = key.split(":");
  if (parts.length === 3) {
    return { backend: parts[0], server: parts[1], tool_name: parts[2] };
  }
  if (parts.length === 2) {
    return { backend: parts[0], server: "default", tool_name: parts[1] };
  }
  return { backend: "unknown", server: "default", tool_name: key };
}
