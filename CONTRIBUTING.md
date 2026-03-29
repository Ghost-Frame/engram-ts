# Contributing to Engram

Thanks for your interest in contributing to Engram! This document provides guidelines and information for contributors.

## Development Setup

```bash
# Clone the repo
git clone https://codeberg.org/GhostFrame/engram.git
cd engram

# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Start in dev mode (auto-restart on changes)
npm run dev
```

**Requirements:**
- Node.js ≥ 22.0.0
- ~350MB disk for embedding model (BGE-large-en-v1.5, auto-downloaded on first run)

## Architecture

Engram is a single-process TypeScript server with zero external service dependencies.

```
archive/server.ts.legacy-monolith  (archived monolith, ~7400 lines, do not use)
server-split.ts    modular entrypoint, imports from src/
mcp-server.ts      MCP server, JSON-RPC 2.0 stdio transport
src/
├── auth/          API keys, GUI cookies, RBAC, Google Cloud auth
├── config/        environment and runtime configuration, logger + ops counters
├── db/            libsql with FTS5 + dynamic FLOAT32 vectors
├── embeddings/    Pluggable: local ONNX (BGE-large-en-v1.5), Google AI Studio, Vertex AI
├── fsrs/          FSRS-6 spaced repetition, 21 trained weights
├── graph/         Graphology-based knowledge graph + community detection
├── gui/           GUI route handlers
├── helpers/       shared utilities (security headers, SSRF protection)
├── intelligence/  fact extraction, consolidation, reflections, contradiction detection, personality
├── llm/           LLM client (Anthropic/MiniMax/Vertex/OpenAI-compatible, with fallback chain)
├── memory/        core memory CRUD + versioning, hybrid vector+FTS search, profile generation
├── platform/      webhooks, digests, sync, import/export
├── reranker/      ONNX cross-encoder (BGE-reranker-base) with SentencePiece tokenizer
├── routes/        HTTP route definitions
├── services/      consolidated Syntheos microservices
│   ├── thymus/    rubric-based quality evaluation and scoring
│   ├── soma/      agent registry, heartbeat, groups, logs
│   ├── chiasm/    task tracking and agent coordination
│   ├── axon/      event bus with pub/sub, SSE streaming, webhook fan-out
│   ├── loom/      workflow orchestration with step executors
│   └── broca/     action logging, template narration, NL query
└── tier4/         causal chains, predictive recall, valence scoring

engram-gui.html    WebGL galaxy visualization (standalone HTML)
engram-login.html  login page
landing.html       marketing landing page
```

### Key Design Decisions

1. **Modular architecture**: The server was split from a monolith (`archive/server.ts.legacy-monolith`, ~7400 lines) into `src/` modules. The only supported entrypoint is `server-split.ts`.

2. **libsql, not better-sqlite3**: We use libsql for native FLOAT32 vector columns and HNSW index support. This gives us vector search without an external service.

3. **In-memory embedding cache**: All embeddings (memories + episodes) are loaded into RAM on startup. This makes vector search sub-millisecond for thousands of memories. Memory usage scales with embedding dimension (e.g., ~4KB/memory at 1024-dim, ~3KB at 768-dim).

4. **FSRS-6 over exponential decay**: Every other memory system uses exponential decay. We use the FSRS-6 algorithm (power-law forgetting curve) with 21 weights trained on millions of Anki reviews. This is mathematically more accurate and gives us features nobody else has (dual-strength model, same-day review handling, optimal review intervals).

5. **Node.js HTTP, not Express/Hono**: Zero framework dependency. The server uses `createServer` with a Web Request/Response adapter. Core dependencies: libsql, onnxruntime-node, graphology, and @modelcontextprotocol/sdk.

6. **Raw ONNX inference**: Embeddings use onnxruntime-node directly with a hand-written BERT WordPiece tokenizer - no @huggingface/transformers wrapper. Model files (tokenizer.json + quantized ONNX) are auto-downloaded from HuggingFace on first run.

7. **Episodic memory**: Conversations are stored as episodes with narrative summaries, embedded for semantic search, and linked to extracted facts. This enables temporal queries ("what did I work on last week?") and contextual recall ("why was this decision made?").

8. **Abstention**: Search returns an `abstained` flag when top result confidence is below a configurable threshold. This prevents false positives - the system knows when it doesn't have relevant information.

9. **Service consolidation pattern**: Satellite services (Thymus, Soma, Chiasm) are absorbed into the monolith under `src/services/<name>/`. Each service follows a consistent `db.ts` (schema + prepared statements) / business-logic / `routes.ts` pattern. Tables are prefixed (e.g., `soma_agents`, `chiasm_tasks`) to avoid collisions. Route handlers return `Response | null` and are mounted as prefix checks in `fetchHandler`. Events publish via the shared Axon stub.

## Code Style

- TypeScript with `--experimental-strip-types` (no build step)
- Structured JSON logging via the `log` object
- Prepared statements for all repeated queries
- `migrate()` helper for safe schema evolution
- All API responses use the `json()` helper with security headers

## Testing

API tests use Node.js built-in test runner. Start the server, then:

```bash
# Run against a locally running Engram (server defaults to port 4200)
ENGRAM_URL=http://localhost:4200 node --test tests/api.test.mjs

# Or use ENGRAM_OPEN_ACCESS=1 to skip auth headers
ENGRAM_OPEN_ACCESS=1 node --experimental-strip-types server-split.ts &
ENGRAM_URL=http://localhost:4200 node --test tests/api.test.mjs
```

40 tests across 15 suites covering core API, multi-tenant isolation, CRUD, FSRS, and more.

We always need more coverage:
- [ ] Benchmark suite for search latency vs competitors
- [ ] Stress tests for large memory sets (10k+ memories)
- [ ] Multi-user isolation tests (two API keys, verify data separation)

## Pull Request Process

1. Fork the repo and create a feature branch
2. Make your changes with clear commit messages
3. Ensure no regressions (run the server, test affected endpoints)
4. Update CHANGELOG.md under `[Unreleased]`
5. Submit a PR with a clear description of what changed and why

## Recent Changes (v5.10)

**Syntheos Phase 1: Service Consolidation** - Three standalone microservices (Thymus, Soma, Chiasm) absorbed into the Engram monolith as native modules under `src/services/`. Each service follows the same `db.ts` / business-logic / `routes.ts` pattern. All use parameterized SQL, share the main database, and reuse Engram auth. See `src/services/index.ts` for the barrel export and `src/routes/index.ts` fetchHandler for route wiring.

**Thymus** - Rubric-based quality evaluation. Define weighted criteria, score agent outputs, track metrics over time. See `src/services/thymus/`.

**Soma** - Agent registry with heartbeat tracking, capability search, group management, and structured logging. See `src/services/soma/`.

**Chiasm** - Task tracking and coordination. Agents create tasks, update status, read each other's work via a feed endpoint. See `src/services/chiasm/`.

These areas may benefit from additional test coverage:

| Feature | Location |
|---------|----------|
| Thymus rubric CRUD and scoring | `src/services/thymus/routes.ts`, `scoring.ts` |
| Soma agent lifecycle | `src/services/soma/routes.ts`, `registry.ts` |
| Chiasm task coordination | `src/services/chiasm/routes.ts`, `engine.ts` |
| PageRank in search scoring | `src/memory/search.ts`, `src/graph/pagerank.ts` |
| CLI commands | `src/cli/index.ts` |
| Source filtering in search | `src/memory/search.ts` `hybridSearch()` |
| Memory health diagnostics | `GET /memory-health` |

## Roadmap (Not Yet Shipped)

- **OpenAPI Spec**: Exists in `sdk/` but not yet served at `/docs` via Swagger UI

## Areas Where Help Is Needed (shipped features that need improvement)

- **Benchmarks**: Measure and publish latency vs Mem0, SuperMemory, ChromaDB
- **Encryption at rest**: SQLCipher integration or envelope encryption
- **Scale tests**: Concurrency, long-running background work, 10k+ memory datasets
- **Agent trust docs**: The passport/signing system needs dedicated documentation and threat model
- **Feedback loop tuning**: The `/feedback` importance adjustments (+0.5 helpful, -0.3 irrelevant) need real-world validation
- **Memory health thresholds**: Duplicate threshold (0.94), staleness window, and unlinked importance cutoff (7) may need tuning per deployment

## License

Elastic License 2.0 (ELv2). See [LICENSE](LICENSE) for details.
