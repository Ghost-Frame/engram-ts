// ============================================================================
// GROUNDING CLIENT - Provider registry, session management, tool dispatch
// Ported from OpenSpace grounding/core/grounding_client.py
// ============================================================================

import { randomUUID } from "crypto";
import { log } from "../config/logger.ts";
import type {
  BackendType, GroundingProvider, SessionConfig, SessionInfo,
  ToolSchema, ToolResult, SessionStatus,
} from "./types.ts";
import { buildToolKey } from "./types.ts";
import { ToolQualityManager } from "./quality.ts";

interface CachedTools {
  tools: ToolSchema[];
  cached_at: number;
}

const TOOL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class GroundingClient {
  private providers: Map<string, GroundingProvider> = new Map();
  private sessions: Map<string, { info: SessionInfo; provider: GroundingProvider }> = new Map();
  private toolCache: Map<string, CachedTools> = new Map();
  private qualityManager: ToolQualityManager;

  constructor(qualityManager: ToolQualityManager) {
    this.qualityManager = qualityManager;
  }

  // --- Provider Management ---

  registerProvider(provider: GroundingProvider): void {
    const key = `${provider.type}:${provider.name}`;
    this.providers.set(key, provider);
    log.info({ msg: "provider_registered", type: provider.type, name: provider.name });
  }

  getProvider(type: BackendType, name?: string): GroundingProvider | undefined {
    if (name) return this.providers.get(`${type}:${name}`);
    // Return first provider of this type
    for (const [key, provider] of this.providers) {
      if (provider.type === type) return provider;
    }
    return undefined;
  }

  listProviders(): Array<{ type: BackendType; name: string; key: string }> {
    return Array.from(this.providers.entries()).map(([key, p]) => ({
      type: p.type,
      name: p.name,
      key,
    }));
  }

  // --- Session Management ---

  async createSession(config: SessionConfig): Promise<SessionInfo> {
    const provider = this.getProvider(config.backend);
    if (!provider) throw new Error(`No provider registered for backend: ${config.backend}`);

    await provider.initialize();
    const session = await provider.createSession(config);
    this.sessions.set(session.id, { info: session, provider });

    log.info({ msg: "session_created", id: session.id, backend: config.backend });
    return session;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId)?.info;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.info);
  }

  async destroySession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    try {
      await entry.provider.destroySession(sessionId);
    } catch (e: any) {
      log.warn({ msg: "session_destroy_error", id: sessionId, error: e.message });
    }

    this.sessions.delete(sessionId);
    log.info({ msg: "session_destroyed", id: sessionId });
  }

  // --- Tool Discovery ---

  async getAllTools(forceRefresh = false): Promise<ToolSchema[]> {
    const allTools: ToolSchema[] = [];

    for (const [key, provider] of this.providers) {
      const cached = this.toolCache.get(key);
      if (!forceRefresh && cached && Date.now() - cached.cached_at < TOOL_CACHE_TTL_MS) {
        allTools.push(...cached.tools);
        continue;
      }

      try {
        const tools = await provider.getTools();
        this.toolCache.set(key, { tools, cached_at: Date.now() });
        allTools.push(...tools);
      } catch (e: any) {
        log.warn({ msg: "tool_discovery_failed", provider: key, error: e.message });
        if (cached) allTools.push(...cached.tools); // use stale cache
      }
    }

    return allTools;
  }

  // --- Tool Execution ---

  async executeTool(
    toolName: string,
    args: Record<string, any>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    // Find provider for this tool
    let provider: GroundingProvider | undefined;
    let toolKey = "";

    if (sessionId) {
      const entry = this.sessions.get(sessionId);
      if (!entry) throw new Error(`Session not found: ${sessionId}`);
      provider = entry.provider;
      toolKey = buildToolKey(provider.type, provider.name, toolName);
      // Update session activity
      entry.info.last_activity_at = new Date().toISOString();
    } else {
      // Search all providers for the tool
      for (const [key, p] of this.providers) {
        const cached = this.toolCache.get(key);
        if (cached?.tools.some(t => t.name === toolName)) {
          provider = p;
          toolKey = buildToolKey(p.type, p.name, toolName);
          break;
        }
      }
    }

    if (!provider) throw new Error(`No provider found for tool: ${toolName}`);

    try {
      const result = await provider.executeTool(toolName, args, timeoutMs);
      const executionTime = Date.now() - startTime;
      result.execution_time_ms = executionTime;

      // Record quality
      this.qualityManager.recordExecution(
        toolKey,
        result.status === "success",
        executionTime,
        result.error,
      );

      return result;
    } catch (e: any) {
      const executionTime = Date.now() - startTime;

      this.qualityManager.recordExecution(toolKey, false, executionTime, e.message);

      return {
        status: "error",
        content: null,
        error: e.message,
        execution_time_ms: executionTime,
      };
    }
  }

  // --- Cleanup ---

  async destroyAll(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.destroySession(sessionId);
    }
    this.toolCache.clear();
  }
}

// --- Singleton ---

let _client: GroundingClient | null = null;

export function getGroundingClient(qualityManager: ToolQualityManager): GroundingClient {
  if (!_client) {
    _client = new GroundingClient(qualityManager);
  }
  return _client;
}
