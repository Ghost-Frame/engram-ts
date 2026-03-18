#!/usr/bin/env -S node --experimental-strip-types
/**
 * Engram MCP Server â€” exposes Engram memory tools to OpenCode
 *
 * Tools: memory_store, memory_recall, memory_list, memory_delete, memory_context
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { signToolManifest, hashTool, type SignedToolManifest, type ToolDefinition } from "./sign/index.ts";

const ENGRAM_URL = process.env.ENGRAM_URL ?? "http://127.0.0.1:4200";
const ENGRAM_API_KEY = process.env.ENGRAM_API_KEY ?? "";
const ENGRAM_SIGNING_SECRET = process.env.ENGRAM_SIGNING_SECRET ?? "";
const SOURCE = "opencode";

async function engram(path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ENGRAM_API_KEY) headers["Authorization"] = `Bearer ${ENGRAM_API_KEY}`;
  const res = await fetch(`${ENGRAM_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Engram ${method} ${path} â†’ ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}

const server = new Server(
  { name: "engram", version: "5.8.1" },
  { capabilities: { tools: {} } },
);

// â”€â”€ Tool Definitions (signed for integrity binding) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TOOLS: ToolDefinition[] = [
  {
    name: "memory_store",
    description: "Store a persistent memory in Engram. Use for important decisions, discoveries, state, and task progress.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Memory content" },
        category: {
          type: "string",
          enum: ["task", "discovery", "decision", "state", "issue", "general", "reference"],
          description: "Category (default: task)",
        },
        importance: { type: "number", description: "Importance 1-10 (default: 5)" },
        model: { type: "string", description: "Model ID that created this memory (e.g. claude-opus-4-6, claude-sonnet-4-6)" },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_recall",
    description: "Search Engram memories by semantic similarity. Use at session start or when you need context about past work.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_context",
    description: "Get a budget-aware context blob from Engram â€” relevance-ranked memories ready to inject into the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Topic / session description" },
        token_budget: { type: "number", description: "Max tokens to return (default: 6000)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_list",
    description: "List recent Engram memories, optionally filtered by category.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category (optional)" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
  },
  {
    name: "memory_delete",
    description: "Delete a memory from Engram by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_guard",
    description: "Check a proposed action against stored rules before execution. Returns allow/warn/block. Prevents repeated mistakes and policy violations.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "The action being proposed (e.g., 'deploy to production', 'delete user data')" },
        context: { type: "string", description: "Additional context about the action" },
      },
      required: ["action"],
    },
  },
  {
    name: "memory_inbox",
    description: "Review pending memories in the inbox. Auto-detected memories land here for triage. Returns memories awaiting approval/rejection.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
        action: { type: "string", enum: ["list", "approve", "reject"], description: "Action to take (default: list)" },
        id: { type: "number", description: "Memory ID to approve/reject (required for approve/reject)" },
      },
    },
  },
  {
    name: "memory_search_preset",
    description: "Search with opinionated presets. Modes: fact (standard), timeline (chronological), preference (user preferences), decision (decisions/corrections), recent (last 24h).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        mode: { type: "string", enum: ["fact", "timeline", "preference", "decision", "recent"], description: "Search preset mode" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query", "mode"],
    },
  },
  {
    name: "memory_entities",
    description: "List or search tracked entities (people, servers, tools, services).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Filter by entity type (person, server, tool, service, etc.)" },
        query: { type: "string", description: "Search query to filter entities" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
  },
  {
    name: "memory_projects",
    description: "List or search tracked projects.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "completed", "paused", "archived"], description: "Filter by status" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
  },
  {
    name: "memory_episodes",
    description: "List conversation episodes (sessions of related work).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 10)" },
        query: { type: "string", description: "Search episodes by content" },
      },
    },
  },
  {
    name: "memory_scratch",
    description: "Read or write to the scratchpad (short-term working memory with TTL). Entries expire after 30 minutes by default.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write"], description: "Read current scratchpad or write entries" },
        session: { type: "string", description: "Session identifier for grouping entries (required for write)" },
        entries: {
          type: "array",
          items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
          description: "Key-value pairs to write (required for write action)",
        },
        agent: { type: "string", description: "Agent name (default: mcp)" },
        model: { type: "string", description: "Model identifier" },
        ttl: { type: "number", description: "TTL in minutes (default: 30, max: 1440)" },
      },
      required: ["action"],
    },
  },
];

// Sign the tool manifest at startup â€” clients can verify tools haven't been poisoned
const toolManifest: SignedToolManifest | null = ENGRAM_SIGNING_SECRET
  ? signToolManifest(ENGRAM_SIGNING_SECRET, TOOLS)
  : null;

// Compute per-tool hashes for inclusion in tool metadata
const toolHashes = new Map(TOOLS.map(t => [t.name, hashTool(t)]));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(t => ({
    ...t,
    // Include integrity hash so clients can verify tool definitions weren't tampered with
    ...(toolManifest ? { _integrity: { hash: toolHashes.get(t.name), manifest_hash: toolManifest.manifest_hash } } : {}),
  })),
  // Include signed manifest in _meta for clients that support verification
  ...(toolManifest ? { _meta: { tool_manifest: toolManifest } } : {}),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params as { name: string; arguments: Record<string, any> };
  try {
    switch (name) {
      case "memory_store": {
        const result = await engram("/store", "POST", {
          content: args!.content,
          category: args!.category ?? "task",
          importance: args!.importance ?? 5,
          source: SOURCE,
          model: args!.model || undefined,
        });
        return { content: [{ type: "text", text: `Stored memory (id: ${result.id ?? "ok"})` }] };
      }

      case "memory_recall": {
        const result = await engram("/recall", "POST", {
          query: args!.query,
          limit: args!.limit ?? 10,
        });
        const memories: any[] = result.memories ?? [];
        if (memories.length === 0) return { content: [{ type: "text", text: "No memories found." }] };
        const text = memories
          .map((m) => `[${m.category}] (id:${m.id}) ${m.content}`)
          .join("\n\n");
        return { content: [{ type: "text", text }] };
      }

      case "memory_context": {
        const result = await engram("/context", "POST", {
          query: args!.query,
          max_tokens: args!.token_budget ?? 8000,
        });
        const ctx = typeof result === "string" ? result : result.context ?? JSON.stringify(result);
        return { content: [{ type: "text", text: ctx || "No context available." }] };
      }

      case "memory_list": {
        const params = new URLSearchParams();
        if (args!.category) params.set("category", String(args!.category));
        params.set("limit", String(args!.limit ?? 20));
        const result = await engram(`/list?${params}`);
        const memories: any[] = result.memories ?? result ?? [];
        if (memories.length === 0) return { content: [{ type: "text", text: "No memories." }] };
        const text = memories
          .map((m) => `[${m.category}] (id:${m.id}) ${String(m.content).slice(0, 200)}`)
          .join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "memory_delete": {
        await engram(`/memory/${args!.id}`, "DELETE");
        return { content: [{ type: "text", text: `Deleted memory ${args!.id}` }] };
      }

      case "memory_guard": {
        const result = await engram("/guard", "POST", {
          action: args!.action,
          context: args!.context || "",
        });
        const verdict = result.verdict || "unknown";
        const reasons = (result.reasons || []).join("; ");
        return { content: [{ type: "text", text: `Guard: ${verdict}${reasons ? ` -- ${reasons}` : ""}` }] };
      }

      case "memory_inbox": {
        const action = args!.action || "list";
        if (action === "approve" && args!.id) {
          await engram(`/inbox/${args!.id}/approve`, "POST");
          return { content: [{ type: "text", text: `Approved memory #${args!.id}` }] };
        }
        if (action === "reject" && args!.id) {
          await engram(`/inbox/${args!.id}/reject`, "POST");
          return { content: [{ type: "text", text: `Rejected memory #${args!.id}` }] };
        }
        const params = new URLSearchParams({ limit: String(args!.limit ?? 20) });
        const result = await engram(`/inbox?${params}`);
        const pending: any[] = result.pending ?? result.memories ?? [];
        if (pending.length === 0) return { content: [{ type: "text", text: "Inbox empty - no pending memories." }] };
        const text = pending.map((m: any) => `[#${m.id}] (${m.category}) ${String(m.content).slice(0, 200)}`).join("\n");
        return { content: [{ type: "text", text: `${pending.length} pending:\n${text}` }] };
      }

      case "memory_search_preset": {
        const result = await engram("/search", "POST", {
          query: args!.query,
          mode: args!.mode,
          limit: args!.limit ?? 10,
        });
        const memories: any[] = result.results ?? [];
        if (result.abstained || memories.length === 0) return { content: [{ type: "text", text: "No results found." }] };
        const text = memories.map((m: any) => `[${m.category}] (id:${m.id}, score:${m.score?.toFixed(3)}) ${m.content}`).join("\n\n");
        return { content: [{ type: "text", text }] };
      }

      case "memory_entities": {
        const params = new URLSearchParams({ limit: String(args!.limit ?? 20) });
        if (args!.type) params.set("type", String(args!.type));
        const result = await engram(`/entities?${params}`);
        const entities: any[] = result.entities ?? result ?? [];
        if (entities.length === 0) return { content: [{ type: "text", text: "No entities found." }] };
        const text = entities.map((e: any) => `[${e.type || "?"}] ${e.name} (id:${e.id})${e.description ? ` -- ${e.description}` : ""}`).join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "memory_projects": {
        const params = new URLSearchParams({ limit: String(args!.limit ?? 20) });
        if (args!.status) params.set("status", String(args!.status));
        const result = await engram(`/projects?${params}`);
        const projects: any[] = result.projects ?? result ?? [];
        if (projects.length === 0) return { content: [{ type: "text", text: "No projects found." }] };
        const text = projects.map((p: any) => `[${p.status || "?"}] ${p.name} (id:${p.id})${p.description ? ` -- ${p.description}` : ""}`).join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "memory_episodes": {
        if (args!.query) {
          const result = await engram("/episodes/search", "POST", { query: args!.query, limit: args!.limit ?? 10 });
          const episodes: any[] = result.episodes ?? result ?? [];
          if (episodes.length === 0) return { content: [{ type: "text", text: "No episodes found." }] };
          const text = episodes.map((e: any) => `[#${e.id}] ${e.title || "Untitled"} (${e.started_at}) -- ${(e.summary || "").slice(0, 150)}`).join("\n");
          return { content: [{ type: "text", text }] };
        }
        const params = new URLSearchParams({ limit: String(args!.limit ?? 10) });
        const result = await engram(`/episodes?${params}`);
        const episodes: any[] = result.episodes ?? result ?? [];
        if (episodes.length === 0) return { content: [{ type: "text", text: "No episodes." }] };
        const text = episodes.map((e: any) => `[#${e.id}] ${e.title || "Untitled"} (${e.started_at})${e.memory_count ? ` [${e.memory_count} memories]` : ""}`).join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "memory_scratch": {
        if (args!.action === "write") {
          if (!args!.session) return { content: [{ type: "text", text: "Error: session is required for write" }], isError: true };
          if (!args!.entries?.length) return { content: [{ type: "text", text: "Error: entries array is required for write" }], isError: true };
          const result = await engram("/scratch", "PUT", {
            session: args!.session,
            agent: args!.agent || "mcp",
            model: args!.model || "unknown",
            entries: args!.entries,
            ttl: args!.ttl ?? 30,
          });
          return { content: [{ type: "text", text: `Wrote ${result.count || args!.entries.length} entries to scratchpad session ${args!.session}` }] };
        }
        // read
        const result = await engram("/scratch");
        const entries: any[] = result.entries ?? [];
        if (entries.length === 0) return { content: [{ type: "text", text: "Scratchpad empty." }] };
        const text = entries.map((e: any) => `[${e.agent}/${e.session?.slice(0, 8)}] ${e.key}: ${e.value || "(empty)"}`).join("\n");
        return { content: [{ type: "text", text }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
