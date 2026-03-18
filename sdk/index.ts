/**
 * Engram SDK -- Thin TypeScript client for the Engram memory API.
 *
 * Usage:
 *   import { Engram } from "@zanfiel/engram/sdk";
 *   const engram = new Engram({ url: "http://localhost:4200", apiKey: "eg_..." });
 *   await engram.store("User prefers dark mode", { category: "decision", importance: 8 });
 *   const results = await engram.search("dark mode preferences");
 *   const context = await engram.context("setting up editor", { mode: "fast" });
 */

export interface EngramConfig {
  url?: string;
  apiKey?: string;
  source?: string;
  timeout?: number;
}

export interface StoreOptions {
  category?: "task" | "discovery" | "decision" | "state" | "issue" | "general" | "reference";
  importance?: number;
  source?: string;
  model?: string;
  tags?: string[];
  session_id?: string;
  is_static?: boolean;
}

export interface SearchOptions {
  limit?: number;
  mode?: "fact" | "timeline" | "preference" | "decision" | "recent";
  tag?: string;
  temporal_sort?: "asc" | "desc";
  rerank?: boolean;
  include_episodes?: boolean;
}

export interface ContextOptions {
  mode?: "fast" | "balanced" | "deep" | "decision";
  max_tokens?: number;
  depth?: 1 | 2 | 3;
  session?: string;
}

export interface RecallOptions {
  limit?: number;
  context?: string;
}

export interface GuardResult {
  verdict: "allow" | "warn" | "block";
  reasons: string[];
  matching_rules: Array<{ id: number; content: string; score: number }>;
}

export interface InboxOptions {
  limit?: number;
}

export interface Memory {
  id: number;
  content: string;
  category: string;
  source: string;
  importance: number;
  created_at: string;
  version?: number;
  is_static?: boolean;
  is_archived?: boolean;
  source_count?: number;
  tags?: string[];
  score?: number;
  semantic_score?: number;
  recall_source?: string;
  explain?: Record<string, any>;
}

export interface StoreResult {
  stored: boolean;
  id: number;
  created_at: string;
  importance: number;
  linked: number;
  embedded: boolean;
  fact_extraction: string;
}

export interface SearchResult {
  results: Memory[];
  abstained: boolean;
  top_score: number;
}

export interface ContextResult {
  context: string;
  memories: Memory[];
  token_estimate: number;
  working_memory?: string;
}

export class EngramError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "EngramError";
    this.status = status;
  }
}

export class Engram {
  private url: string;
  private apiKey: string;
  private source: string;
  private timeout: number;

  constructor(config: EngramConfig = {}) {
    this.url = (config.url || process.env.ENGRAM_URL || "http://127.0.0.1:4200").replace(/\/$/, "");
    this.apiKey = config.apiKey || process.env.ENGRAM_API_KEY || "";
    this.source = config.source || "sdk";
    this.timeout = config.timeout || 10000;
  }

  private async fetch<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new EngramError(`${method} ${path}: ${res.status} ${text}`, res.status);
    }
    return res.json() as Promise<T>;
  }

  // ── Core Methods ───────────────────────────────────────────────────

  /** Store a memory. */
  async store(content: string, options: StoreOptions = {}): Promise<StoreResult> {
    return this.fetch<StoreResult>("/store", "POST", {
      content,
      category: options.category || "general",
      importance: options.importance || 5,
      source: options.source || this.source,
      model: options.model,
      tags: options.tags,
      session_id: options.session_id,
      is_static: options.is_static,
    });
  }

  /** Semantic search with optional presets. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    return this.fetch<SearchResult>("/search", "POST", {
      query,
      limit: options.limit || 10,
      mode: options.mode,
      tag: options.tag,
      temporal_sort: options.temporal_sort,
      rerank: options.rerank,
      include_episodes: options.include_episodes,
    });
  }

  /** Budget-aware context for RAG injection. */
  async context(query: string, options: ContextOptions = {}): Promise<ContextResult> {
    return this.fetch<ContextResult>("/context", "POST", {
      query,
      max_tokens: options.max_tokens,
      mode: options.mode,
      depth: options.depth,
      session: options.session,
    });
  }

  /** Smart recall with profile + semantic matching. */
  async recall(query: string, options: RecallOptions = {}): Promise<{ memories: Memory[] }> {
    return this.fetch("/recall", "POST", {
      context: options.context || query,
      limit: options.limit || 10,
    });
  }

  /** Check an action against stored guardrail rules. */
  async guard(action: string, context?: string): Promise<GuardResult> {
    return this.fetch<GuardResult>("/guard", "POST", { action, context: context || "" });
  }

  /** List pending memories in the review inbox. */
  async inbox(options: InboxOptions = {}): Promise<{ pending: Memory[] }> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    return this.fetch(`/inbox?${params}`);
  }

  /** Approve a pending memory from the inbox. */
  async approve(id: number): Promise<void> {
    await this.fetch(`/inbox/${id}/approve`, "POST");
  }

  /** Reject a pending memory from the inbox. */
  async reject(id: number): Promise<void> {
    await this.fetch(`/inbox/${id}/reject`, "POST");
  }

  // ── Convenience Methods ────────────────────────────────────────────

  /** List recent memories. */
  async list(options: { category?: string; limit?: number } = {}): Promise<Memory[]> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.category) params.set("category", options.category);
    const result = await this.fetch<{ results: Memory[] }>(`/list?${params}`);
    return result.results || [];
  }

  /** Delete a memory by ID. */
  async delete(id: number): Promise<void> {
    await this.fetch(`/memory/${id}`, "DELETE");
  }

  /** Update a memory (creates new version, preserves history). */
  async update(id: number, content: string, category?: string): Promise<{ new_id: number; version: number }> {
    return this.fetch(`/memory/${id}/update`, "POST", { content, category });
  }

  /** Archive a memory (soft-remove from active recall). */
  async archive(id: number): Promise<void> {
    await this.fetch(`/memory/${id}/archive`, "POST");
  }

  /** Store a correction that supersedes an existing memory. */
  async correct(correction: string, options: { memory_id?: number; original_claim?: string; category?: string; source?: string } = {}): Promise<StoreResult> {
    return this.fetch<StoreResult>("/correct", "POST", {
      correction,
      original_claim: options.original_claim,
      memory_id: options.memory_id,
      category: options.category || "general",
      source: options.source || this.source,
    });
  }

  /** Health check. */
  async health(): Promise<{ status: string; version: string; memories?: number }> {
    return this.fetch("/health");
  }

  /** Readiness check. */
  async ready(): Promise<{ status: string; checks: Record<string, boolean> }> {
    return this.fetch("/ready");
  }

  // ── Scratchpad (working memory) ────────────────────────────────────

  /** Read current scratchpad entries. */
  async scratchRead(session?: string): Promise<any[]> {
    const params = session ? `?session=${encodeURIComponent(session)}` : "";
    const result = await this.fetch<{ entries: any[] }>(`/scratch${params}`);
    return result.entries || [];
  }

  /** Write to scratchpad. */
  async scratchWrite(session: string, entries: Array<{ key: string; value: string }>, options: { agent?: string; model?: string; ttl?: number } = {}): Promise<void> {
    await this.fetch("/scratch", "PUT", {
      session,
      agent: options.agent || this.source,
      model: options.model || "unknown",
      entries,
      ttl: options.ttl || 30,
    });
  }
}

export default Engram;
