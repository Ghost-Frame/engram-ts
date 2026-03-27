#!/usr/bin/env -S node --experimental-strip-types
/**
 * Engram MCP Server â€” exposes Engram memory tools to OpenCode
 *
 * Tools (12): memory_store, memory_search_preset, memory_recall, memory_context, memory_list,
 *   memory_delete, memory_guard, memory_inbox, memory_entities,
 *   memory_projects, memory_episodes, memory_scratch
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
  { name: "engram", version: "5.11.0" },
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
        source: { type: "string", description: "Source identifier for attribution (e.g. cursor, claude-code, opencode). Defaults to 'opencode' if not provided." },
        model: { type: "string", description: "Model ID that created this memory (e.g. claude-opus-4-6, claude-sonnet-4-6)" },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_search_preset",
    description: "Semantic search across all memories with query-optimized presets. Use this for finding specific information. Modes: fact (standard semantic search), timeline (chronological), preference (user preferences), decision (decisions and corrections), recent (last 24h).",
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
    name: "memory_recall",
    description: "Load broad session context from Engram (static facts + semantic + important + recent memories). Best for session-start context loading. For precise semantic search, use memory_search_preset instead.",
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
  // ---- Structural Analysis Tools ----
  {
    name: "structural_analyze",
    description: "Structural analysis of a system described in EN syntax. Returns topology classification (Pipeline, Tree, Fork-Join, DAG, Cycle, Disconnected), node roles (SOURCE, SINK, FORK, JOIN, HUB, PIPELINE), and bridges (single points of failure). EN syntax: Subject do: action needs: inputs yields: outputs.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "EN source code describing the system" },
      },
      required: ["source"],
    },
  },
  {
    name: "structural_detail",
    description: "Deep structural analysis -- concurrency metrics, critical path, flow depth levels, resilience analysis with bridge implications.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "EN source code describing the system" },
      },
      required: ["source"],
    },
  },
  {
    name: "structural_between",
    description: "Betweenness centrality for a node -- what fraction of all shortest paths flow through it. Score 0-1.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "EN source code describing the system" },
        node: { type: "string", description: "Node name to compute centrality for" },
      },
      required: ["source", "node"],
    },
  },
  {
    name: "structural_distance",
    description: "Shortest path between two nodes with subsystem crossing annotations.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "EN source code describing the system" },
        from: { type: "string", description: "Starting node name" },
        to: { type: "string", description: "Target node name" },
      },
      required: ["source", "from", "to"],
    },
  },
  {
    name: "structural_trace",
    description: "Follow directed flow from node A to node B respecting yields->needs direction. Falls back to undirected and flags reverse edges.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "EN source code describing the system" },
        from: { type: "string", description: "Starting node name" },
        to: { type: "string", description: "Target node name" },
      },
      required: ["source", "from", "to"],
    },
  },
  {
    name: "structural_impact",
    description: "Blast radius -- remove a node and see what disconnects. Works for any domain: infra, org charts, compliance flows.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "EN source code describing the system" },
        node: { type: "string", description: "Node to remove for impact analysis" },
      },
      required: ["source", "node"],
    },
  },
  {
    name: "structural_diff",
    description: "Structural diff between two systems. Reports topology changes, role changes, nodes added/removed, bridge count changes.",
    inputSchema: {
      type: "object",
      properties: {
        source_a: { type: "string", description: "EN source for the first system" },
        source_b: { type: "string", description: "EN source for the second system" },
      },
      required: ["source_a", "source_b"],
    },
  },
  {
    name: "structural_evolve",
    description: "Dry-run architectural changes. Apply a patch and see the structural delta plus new/eliminated bridges.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "EN source for the current system" },
        patch: { type: "string", description: "EN source patch to apply" },
      },
      required: ["source", "patch"],
    },
  },
  {
    name: "structural_categorize",
    description: "Auto-discover subsystem boundaries from dependency structure using Louvain community detection.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "EN source code describing the system" },
      },
      required: ["source"],
    },
  },
  {
    name: "structural_extract",
    description: "Extract a named subsystem as standalone EN source. Reports boundary inputs, outputs, and internal entities.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "EN source code describing the system" },
        subsystem: { type: "string", description: "Name of the subsystem to extract" },
      },
      required: ["source", "subsystem"],
    },
  },
  {
    name: "structural_compose",
    description: "Merge two EN graphs into one with entity linking.",
    inputSchema: {
      type: "object",
      properties: {
        source_a: { type: "string", description: "EN source for the first system" },
        source_b: { type: "string", description: "EN source for the second system" },
        links: { type: "string", description: "Entity links: 'a.node1=b.node2, a.node3=b.node4'" },
      },
      required: ["source_a", "source_b"],
    },
  },
  {
    name: "structural_memory_graph",
    description: "Analyze Engram's own memory link graph structurally. Returns topology, node roles, bridges, and metrics.",
    inputSchema: {
      type: "object",
      properties: {},
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
          source: args!.source ?? SOURCE,
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
          .map((m) => `[${m.category}] (id:${m.id}, source:${m.source ?? "unknown"}) ${m.content}`)
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
        const text = memories.map((m: any) => `[${m.category}] (id:${m.id}, source:${m.source ?? "unknown"}, score:${m.score?.toFixed(3)}) ${m.content}`).join("\n\n");
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

      // ---- Structural Analysis Tools ----

      case "structural_analyze": {
        const result = await engram("/structural/analyze", "POST", { source: args!.source });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_detail": {
        const result = await engram("/structural/detail", "POST", { source: args!.source });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_between": {
        const result = await engram("/structural/between", "POST", { source: args!.source, node: args!.node });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_distance": {
        const result = await engram("/structural/distance", "POST", { source: args!.source, from: args!.from, to: args!.to });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_trace": {
        const result = await engram("/structural/trace", "POST", { source: args!.source, from: args!.from, to: args!.to });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_impact": {
        const result = await engram("/structural/impact", "POST", { source: args!.source, node: args!.node });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_diff": {
        const result = await engram("/structural/diff", "POST", { source_a: args!.source_a, source_b: args!.source_b });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_evolve": {
        const result = await engram("/structural/evolve", "POST", { source: args!.source, patch: args!.patch });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_categorize": {
        const result = await engram("/structural/categorize", "POST", { source: args!.source });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_extract": {
        const result = await engram("/structural/extract", "POST", { source: args!.source, subsystem: args!.subsystem });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_compose": {
        const result = await engram("/structural/compose", "POST", { source_a: args!.source_a, source_b: args!.source_b, links: args!.links ?? "" });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "structural_memory_graph": {
        const result = await engram("/structural/memory-graph");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
