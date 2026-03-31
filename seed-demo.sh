#!/bin/bash
# Seed the Engram demo instance with safe, generic engineering memories
# No personal data, no real infrastructure, no credentials

DEMO_URL="http://100.64.0.13:4201"
DEMO_KEY="${DEMO_SEED_KEY:?Set DEMO_SEED_KEY env var with a write-capable API key}"

store() {
  local content="$1"
  local category="${2:-discovery}"
  local importance="${3:-5}"
  local source="${4:-claude-code}"
  curl -sf "$DEMO_URL/store" -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $DEMO_KEY" \
    -d "{\"content\": \"$content\", \"category\": \"$category\", \"importance\": $importance, \"source\": \"$source\"}" > /dev/null
  echo "  stored: ${content:0:60}..."
}

echo "=== Seeding Engram Demo ==="
echo ""

# Infrastructure & DevOps
echo "[Infrastructure]"
store "Kubernetes cluster setup with 3 node pools: system (2 nodes), app (4 auto-scaling), gpu (1 on-demand). Using GKE Autopilot for cost optimization. HPA at CPU > 70%." "decision" 8 "claude-code"
store "Docker multi-stage builds reduced image size by 60%. Switched to node:22-alpine in final stage. Added .dockerignore. Production image went from 1.2GB to 480MB." "discovery" 7 "opencode"
store "CI/CD pipeline uses GitHub Actions with matrix strategy. Matrix builds across Node 20/22, tests + lint + typecheck in parallel. OIDC for cloud auth, no service account keys." "reference" 6 "claude-code"
store "Prometheus + Grafana monitoring stack deployed. Scrapes /metrics every 15s. Dashboards for request latency p50/p95/p99, error rates, pod resource usage. AlertManager routes to Slack." "task" 7 "opencode"
store "Blue-green deployment strategy for zero-downtime releases. New version deploys to green, smoke tests run, traffic switches atomically. Rollback is instant service selector change." "decision" 9 "claude-code"
store "Terraform modules for all cloud infrastructure: networking, cluster, database, cache, pubsub. State in GCS with locking. Workspaces for dev/staging/prod." "reference" 6 "gemini"
store "Redis cluster for session caching and rate limiting. 3 masters, 3 replicas. Session tokens (TTL 24h), rate limit counters (sliding window), feature flags cache (TTL 5m)." "task" 5 "claude-code"
store "Database migration workflow with Flyway. Runs in init container before app starts. Versioned SQL files. Always use IF EXISTS/IF NOT EXISTS." "reference" 6 "opencode"
store "HPA tuned for latency targets. CPU 70%, memory 80%, custom metric: request_latency_p95 < 200ms. Scale-up: 1 pod/30s, scale-down: 1 pod/5min. Min 2, max 20 replicas." "task" 7 "claude-code"
store "Structured JSON logging across all services. Fields: timestamp, level, service, trace_id, message, duration_ms. Shipped to Cloud Logging, retained 30 days." "decision" 5 "claude-code"
store "CDN configuration: static assets cached 1 year (hashed filenames), API GET responses cached 60s for public endpoints, no cache for authenticated endpoints." "task" 6 "opencode"
store "Disaster recovery plan tested monthly. RTO 15min, RPO 1hr. Daily full backups, hourly WAL archives to separate region. Runbook: promote replica, update DNS, verify integrity." "decision" 9 "claude-code"

# AI & Machine Learning
echo "[AI & ML]"
store "RAG pipeline with hybrid search: 0.7 * vector similarity + 0.3 * BM25. Reranking with cross-encoder on top 50 results. Returns top 10. Latency: 120ms p95." "discovery" 9 "claude-code"
store "Chose gte-large for 1024-dim embeddings. 10x cheaper than ada-002, comparable quality for our domain. Batch encoding at 800 docs/sec on GPU." "decision" 8 "opencode"
store "Fine-tuning with LoRA adapters: rank 16, alpha 32, applied to q_proj and v_proj. 5000 domain-specific examples. Eval loss plateaus at epoch 3." "reference" 7 "claude-code"
store "Semantic chunking with sentence boundaries. Target 512 tokens per chunk, 64 token overlap. Preserves paragraph structure. Better retrieval than fixed-size chunks." "decision" 7 "gemini"
store "Prompt engineering patterns: chain-of-thought for reasoning, few-shot for classification, structured output with JSON schema validation. System prompts versioned in git." "reference" 6 "claude-code"
store "pgvector with HNSW index: m=16, ef_construction=200, ef_search=100. Handles 500k vectors, query time <10ms. IVFFlat as fallback for memory-constrained environments." "decision" 8 "opencode"
store "LLM evaluation framework: automated BLEU/ROUGE/BERTScore on test set. Human eval: weekly review of 50 random outputs. Feedback stored for drift detection." "task" 6 "claude-code"
store "Token budget management for multi-turn conversations. Rolling context: system prompt + last 4 turns + retrieved context. Summarize older turns at 80% limit." "task" 5 "claude-code"
store "Spaced repetition decay model (FSRS) adapted for AI memories. Initial stability from importance score. Each access increases stability. Decay = importance * retrievability." "discovery" 8 "opencode"
store "Knowledge graph from unstructured text: NER + relation extraction pipeline. Entities become nodes, relations become edges. Community detection via Louvain algorithm." "discovery" 7 "claude-code"
store "Transformer attention visualization with BertViz for debugging retrieval quality. Shows which tokens the model attends to during encoding." "reference" 5 "gemini"
store "Hallucination detection via citation verification. Post-generation: extract claims, match against sources, flag unsupported statements. Reduced hallucination from 12% to 3%." "task" 8 "claude-code"

# Product Design
echo "[Design]"
store "Design system: 8px grid, 3 font weights (Inter 400/500/700), 6 color ramps. Primary (blue), secondary (slate), accent (amber), success, warning, error. 50-950 shades each." "decision" 8 "gpt"
store "User research: 12 interviews, 3 personas. Key insight: 78% of sessions start with search. Command palette pattern preferred over sidebar navigation." "discovery" 9 "claude-code"
store "A/B test result: card layout beats list view. +23% click-through, +15% time on page, -8% bounce rate. Statistical significance at n=2000." "discovery" 6 "opencode"
store "WCAG 2.1 AA compliance achieved. Keyboard navigation on all interactive elements. Color contrast >4.5:1. Screen reader labels. Focus indicators. Skip nav link." "task" 7 "claude-code"
store "Animation system uses spring physics (Framer Motion). Stiffness 300, damping 30. Entry animations stagger children 50ms. Respects prefers-reduced-motion." "decision" 6 "gpt"
store "Dark theme as default based on user research (82% preference). System preference detection on first visit. Manual toggle persisted in localStorage." "preference" 7 "claude-code"
store "Component library: 45 primitives (Button, Input, Select...) and 20 composites (DataTable, CommandPalette, Modal, Drawer). All with variants, sizes, states documented." "reference" 6 "opencode"
store "Typography scale 1.25 ratio. Base 16px. Scale: 12, 14, 16, 20, 24, 30, 36, 48. Line height 1.5 body, 1.2 headings. Letter spacing -0.02em for headings >24px." "reference" 5 "claude-code"
store "Responsive breakpoints: 640, 768, 1024, 1280, 1536px. Mobile-first. Single column <768, sidebar at 1024, expanded at 1280." "reference" 5 "gpt"

# Security
echo "[Security]"
store "OAuth 2.0 + PKCE for all client apps. Access tokens: 15min JWT. Refresh tokens: 7 day, rotated on use, httpOnly cookie. Revocation list in Redis." "decision" 9 "claude-code"
store "Row Level Security on all database tables. Every table has user ID check. No permissive policies. Separate policies for SELECT/INSERT/UPDATE/DELETE. Tested with pgTAP." "decision" 10 "opencode"
store "API rate limiting: sliding window in Redis. 100 req/min sustained, 1000 burst. 429 with Retry-After header. Auth endpoints: 10/min." "task" 7 "claude-code"
store "Vulnerability scanning in CI: Snyk for npm deps, Trivy for container images. Block merge on critical/high findings. Weekly full scan of production images." "task" 6 "gemini"
store "Secret rotation automated quarterly. All secrets in Vault with 90-day TTL. Generate new, deploy, verify, revoke old. DB creds via Vault dynamic secrets." "decision" 8 "claude-code"
store "CSP headers: default-src self; script-src self cdn; style-src self unsafe-inline; img-src self data https. Blocks inline scripts and unauthorized origins." "task" 6 "opencode"
store "Annual pentest: 0 critical, 2 medium resolved (CORS misconfiguration, session fixation edge case). Retest confirmed resolution." "issue" 7 "claude-code"
store "Input validation with Zod schemas on all API boundaries. Schema shared between client and server. Invalid input returns 400 with field-level errors." "decision" 7 "claude-code"

# Data Pipeline
echo "[Data Pipeline]"
store "ETL with Airflow DAGs: user_events (hourly), aggregates (nightly), exports (weekly), cleanup (monthly), health_check (6h). Kubernetes executor." "task" 7 "opencode"
store "Event streaming with Pub/Sub: 50k events/sec capacity. Message ordering by user_id. Dead letter topic after 5 retries. Avg e2e latency: 200ms." "reference" 6 "claude-code"
store "Data warehouse on BigQuery. Partitioned by date, clustered by user_id and event_type. Materialized views for common queries. ~\$50/month." "decision" 8 "claude-code"
store "Metabase analytics connected to read replica. 15 dashboards: user growth, feature adoption, performance metrics, revenue." "task" 5 "gemini"
store "Data retention: 2 years active in hot storage, archived to cold after 2 years, hard delete after 5 years per privacy policy. Automated lifecycle rules." "decision" 7 "claude-code"
store "Schema versioning: all changes via numbered migration files. Forward-only in prod. Dev can reset. Schema diffing catches drift." "reference" 6 "opencode"
store "ClickHouse for real-time analytics on high-cardinality data. MergeTree engine, date partition. 10M rows/sec insert, <100ms query on 1B rows." "discovery" 7 "claude-code"

# Cross-cutting / Bridge
echo "[Cross-cutting]"
store "API gateway (Kong) consolidates auth, rate limiting, routing, response caching, logging. Single entry point for all services." "decision" 8 "claude-code"
store "Feature flags via LaunchDarkly control AI model rollouts. Gradual: 1% -> 10% -> 50% -> 100%. Instant kill switch for regressions." "task" 6 "opencode"
store "OpenTelemetry end-to-end tracing. Trace ID in HTTP headers. Jaeger UI shows full request lifecycle from frontend click to DB query." "discovery" 7 "claude-code"
store "Cost optimization: reserved instances for stable workloads (DB, Redis, base compute). Spot for batch. Autoscaling for variable. Monthly review." "decision" 6 "gemini"
store "Documentation in code: TSDoc for APIs, Storybook for components, Architecture Decision Records for design decisions. All in git, auto-deployed." "reference" 5 "claude-code"

# Preferences
echo "[Preferences]"
store "All background jobs must be idempotent. Content-addressable IDs. Safe to retry indefinitely." "preference" 7 "claude-code"
store "DB migrations require custom runner, idempotent operations, and rollback scripts for all schema changes." "preference" 6 "opencode"
store "Frontend stack: React + TypeScript + Tailwind CSS. Custom component library. No external UI framework dependencies." "preference" 7 "claude-code"
store "Vector embeddings: FLOAT32 1024-dim. ANN search with cosine similarity. HNSW index for production workloads." "reference" 6 "claude-code"
store "Memory consolidation runs hourly. Memories above 0.92 cosine similarity are merged. Source attribution preserved." "discovery" 7 "opencode"
store "PageRank runs incrementally on memory link graph. High-PR memories boosted in search results." "discovery" 7 "claude-code"

echo ""
echo "=== Seeding complete ==="
echo ""
curl -sf "$DEMO_URL/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Memories: {d[\"memories\"]}, Embedded: {d[\"embedded\"]}, Links: {d[\"links\"]}')" 2>/dev/null || curl -sf "$DEMO_URL/health"
