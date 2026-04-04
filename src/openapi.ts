// ============================================================================
// OPENAPI - OpenAPI 3.1 spec for the Engram Memory API
// ============================================================================

import { PKG_VERSION } from "./config/index.ts";

export function getOpenAPISpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Engram Memory API",
      version: PKG_VERSION,
      description: "Cognitive memory server with semantic search, multi-tenant isolation, and intelligent features.",
      license: { name: "Source Available", url: "https://github.com/syntheos/engram" },
    },
    servers: [
      { url: "/", description: "Current instance" },
    ],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          description: "Returns server health. Unauthenticated: minimal response. Authenticated: full diagnostics.",
          tags: ["System"],
          responses: {
            "200": {
              description: "Server is healthy",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["ok"] },
                  version: { type: "string" },
                  memories: { type: "integer" },
                  embedded: { type: "integer" },
                  embedding_model: { type: "string" },
                  embedding_provider: { type: "string", enum: ["local", "google", "vertex"] },
                  llm_configured: { type: "boolean" },
                },
                required: ["status", "version"],
              }}},
            },
          },
        },
      },
      "/store": {
        post: {
          summary: "Store a memory",
          description: "Store a new memory. Automatically generates embedding, extracts facts, and creates similarity links.",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                content: { type: "string", description: "The memory content text", maxLength: 102400 },
                category: { type: "string", default: "general", description: "Memory category" },
                source: { type: "string", default: "unknown", description: "Origin agent or system" },
                importance: { type: "integer", minimum: 1, maximum: 10, default: 5 },
                tags: { type: "array", items: { type: "string" }, description: "Categorization tags" },
                session_id: { type: "string", description: "Group related memories by session" },
                confidence: { type: "number", minimum: 0, maximum: 1, default: 1.0 },
              },
              required: ["content"],
            }}},
          },
          responses: {
            "201": {
              description: "Memory stored successfully",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  created_at: { type: "string", format: "date-time" },
                  job_id: { type: "integer", description: "Background embedding job ID" },
                },
              }}},
            },
            "413": { description: "Content too large" },
            "429": { description: "Rate limit or quota exceeded" },
          },
        },
      },
      "/search": {
        post: {
          summary: "Search memories",
          description: "Hybrid semantic + keyword search with optional cross-encoder reranking. Automatically classifies query type (fact_recall, preference, reasoning, temporal) and applies appropriate search strategy.",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Natural language search query" },
                limit: { type: "integer", default: 10, maximum: 100 },
                include_links: { type: "boolean", default: false },
                expand_relationships: { type: "boolean", default: false },
                source: { type: "string", description: "Filter by source agent" },
                category: { type: "string", description: "Filter by category" },
                question_type: { type: "string", enum: ["fact_recall", "preference", "reasoning", "generalization", "temporal"] },
              },
              required: ["query"],
            }}},
          },
          responses: {
            "200": {
              description: "Search results ranked by relevance",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        content: { type: "string" },
                        category: { type: "string" },
                        source: { type: "string" },
                        importance: { type: "integer" },
                        score: { type: "number", description: "Combined relevance score" },
                        semantic_score: { type: "number" },
                        fts_score: { type: "number" },
                        created_at: { type: "string", format: "date-time" },
                        tags: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                  count: { type: "integer" },
                  question_type: { type: "string" },
                  reranked: { type: "boolean" },
                },
              }}},
            },
          },
        },
      },
      "/recall": {
        post: {
          summary: "Contextual recall",
          description: "Budget-aware memory retrieval for LLM context injection. Returns relevant memories within a token budget.",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                query: { type: "string" },
                budget: { type: "integer", default: 2000, description: "Maximum token budget for returned context" },
              },
              required: ["query"],
            }}},
          },
          responses: {
            "200": { description: "Context blob within token budget" },
          },
        },
      },
      "/context": {
        post: {
          summary: "Get LLM context",
          description: "Retrieve relevant context for an LLM conversation. Like /recall but returns structured context with metadata.",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                query: { type: "string" },
                budget: { type: "integer", default: 3000 },
              },
              required: ["query"],
            }}},
          },
          responses: { "200": { description: "Structured context with memories and metadata" } },
        },
      },
      "/list": {
        get: {
          summary: "List recent memories",
          description: "Paginated list of recent memories, newest first.",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "category", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Paginated memory list",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  memories: { type: "array", items: { type: "object" } },
                  total: { type: "integer" },
                  limit: { type: "integer" },
                  offset: { type: "integer" },
                  has_more: { type: "boolean" },
                },
              }}},
            },
          },
        },
      },
      "/memory/{id}": {
        get: {
          summary: "Get memory by ID",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": { description: "Memory details with version chain" },
            "404": { description: "Memory not found or access denied" },
          },
        },
        delete: {
          summary: "Delete memory",
          tags: ["Memory"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": { description: "Memory deleted" },
            "404": { description: "Memory not found" },
          },
        },
      },
      "/conversations": {
        post: {
          summary: "Create conversation",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                agent: { type: "string" },
                session_id: { type: "string" },
                title: { type: "string" },
                messages: { type: "array", items: {
                  type: "object",
                  properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } },
                  required: ["role", "content"],
                }},
              },
            }}},
          },
          responses: { "201": { description: "Conversation created" } },
        },
        get: {
          summary: "List conversations",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "agent", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Paginated conversation list" } },
        },
      },
      "/export": {
        get: {
          summary: "Export user data",
          description: "Download all user memories, conversations, entities, and projects as portable JSON.",
          tags: ["Data"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "since", in: "query", schema: { type: "string", format: "date" }, description: "Only export memories created after this date" },
          ],
          responses: { "200": { description: "JSON export file" } },
        },
      },
      "/import/json": {
        post: {
          summary: "Import user data",
          description: "Import memories and conversations from a JSON export file.",
          tags: ["Data"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                version: { type: "string" },
                memories: { type: "array", items: { type: "object" } },
                conversations: { type: "array", items: { type: "object" } },
              },
              required: ["version", "memories"],
            }}},
          },
          responses: { "200": { description: "Import results with counts" } },
        },
      },
      "/backup": {
        get: {
          summary: "Download database backup",
          description: "Admin-only. Downloads a consistent SQLite snapshot of the entire database.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "SQLite database file", content: { "application/x-sqlite3": {} } },
            "403": { description: "Admin required" },
          },
        },
      },
      "/keys": {
        post: {
          summary: "Create API key",
          tags: ["Auth"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                scopes: { type: "string", default: "read,write", description: "Comma-separated: read,write,admin" },
                rate_limit: { type: "integer", default: 120 },
                user_id: { type: "integer", description: "Admin: create key for another user" },
                expires_at: { type: "string", format: "date-time", description: "Optional expiration" },
              },
            }}},
          },
          responses: {
            "201": {
              description: "API key created. The key value is only shown once.",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  key: { type: "string", description: "The API key (eg_...). Store securely, shown only once." },
                  id: { type: "integer" },
                },
              }}},
            },
          },
        },
      },
      "/metrics": {
        get: {
          summary: "Prometheus metrics",
          description: "Prometheus-compatible metrics endpoint. No auth required.",
          tags: ["System"],
          responses: { "200": { description: "Prometheus text format", content: { "text/plain": {} } } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Key (eg_...)",
          description: "API key from POST /keys or POST /bootstrap. Format: Bearer eg_xxxx...",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            request_id: { type: "string" },
          },
          required: ["error"],
        },
        Memory: {
          type: "object",
          properties: {
            id: { type: "integer" },
            content: { type: "string" },
            category: { type: "string" },
            source: { type: "string" },
            importance: { type: "integer", minimum: 1, maximum: 10 },
            tags: { type: "array", items: { type: "string" } },
            confidence: { type: "number" },
            version: { type: "integer" },
            is_latest: { type: "boolean" },
            is_static: { type: "boolean" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        PaginatedResponse: {
          type: "object",
          properties: {
            total: { type: "integer" },
            limit: { type: "integer" },
            offset: { type: "integer" },
            has_more: { type: "boolean" },
          },
        },
      },
    },
    tags: [
      { name: "System", description: "Health, metrics, and server status" },
      { name: "Memory", description: "Store, search, and manage memories" },
      { name: "Conversations", description: "Multi-turn conversation tracking" },
      { name: "Data", description: "Import, export, and data portability" },
      { name: "Auth", description: "API keys, users, and authentication" },
      { name: "Admin", description: "Backup, schema, tenant management" },
    ],
  };
}
