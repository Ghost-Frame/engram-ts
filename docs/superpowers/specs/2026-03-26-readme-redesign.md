# Engram README Redesign

**Date**: 2026-03-26
**Status**: Draft

## Problem

The current README is a 41KB wall of text. Nobody reads it. The project has evolved from a memory store into a full cognitive layer (memory, personality, reasoning, trust), and the README doesn't reflect that. There's no visual hook, no quick demo, and the technical depth buries the value proposition.

## Design Decisions

- **Audience**: Hook casual GitHub browsers first, serve technical depth deeper down
- **Positioning**: "The cognitive layer for AI agents" -- not just memory, but personality, reasoning, and trust
- **Vibe**: Evocative and memorable (Supabase/Vercel energy, not Postgres energy)
- **Content strategy**: Punchy hero section up top, collapsible `<details>` for deep dives
- **Visual hero**: Terminal demo (asciinema SVG) ships now; graph GIF slots in later once GUI is polished
- **Landing page**: Exists separately at engram.lol, will share visual assets once ready

## README Structure

### 1. Header

```markdown
# Engram

The cognitive layer for AI agents.

Memory, personality, reasoning, and trust -- in a single self-hosted system that learns, forgets, and grows.

[version badge] [license badge] [node badge] [docker badge]
```

Placeholder HTML comment for graph hero image (added later).

### 2. Terminal Demo

An SVG recording (generated via svg-term-cli or similar) showing the core loop:

```
$ engram-cli store "The auth service runs on port 9091" --category discovery
Stored memory #847 (discovery)

$ engram-cli search "where does auth run"
#847 [discovery] 0.94 -- The auth service runs on port 9091

$ engram-cli context "setting up SSO"
7 memories across 3 categories. Top: #847 (discovery), #203 (decision), #91 (reference)...
```

Short. Shows store, search, context in ~5 seconds of terminal activity.

### 3. Four Pillars

Four blocks, each 2-3 sentences max. No bullet-point soup.

**Memory**
FSRS-6 spaced repetition with power-law forgetting. Hybrid search fuses vector similarity, full-text, personality matching, and graph traversal into a single ranked result. Memories strengthen when accessed and fade when ignored, like the real thing.

**Personality**
Extracts preferences, values, motivations, decisions, emotions, and identity markers from conversations. Your agent doesn't just remember what happened -- it understands who it's talking to.

**Reasoning**
Detects contradictions between memories, generates reflections, derives new memories from existing ones. Time-travel queries let you ask "what did I know on March 1st?" Smart context assembles the right memories for the right moment.

**Trust**
Execution signing, guardrails, trust scoring, and full audit trails. Every memory has provenance. Every action can be verified.

### 4. Quick Start

```bash
# Docker (recommended)
docker compose up -d

# Or run directly (Node 22+)
npm install
node --experimental-strip-types server-split.ts
```

Then a 2-line curl example hitting /store and /search.

### 5. Feature Highlights

A compact table or short list of standout features, each linking to its collapsible deep-dive below:

- 4-channel hybrid search (RRF fusion)
- Knowledge graph with community detection and PageRank
- MCP server with 25+ tools
- TypeScript SDK
- Zero-dependency CLI
- WebGL graph visualization (3D force graph)
- Multi-tenant with API keys
- One-command Docker deployment

### 6. Collapsible Deep Dives

Each major topic gets a `<details>` block:

- Architecture (runtime, DB, embeddings, reranker, search pipeline)
- API Reference (endpoints, request/response shapes)
- CLI Reference (all commands and flags)
- SDK Usage (TypeScript examples)
- MCP Server (tool list, setup for Claude Desktop/Cursor)
- Configuration (.env reference)
- Graph Visualization (GUI setup, screenshot placeholder)
- Deployment (Docker, systemd, reverse proxy)
- Contributing

Content migrated from the current README, trimmed for conciseness.

### 7. Footer

License, links to landing page (engram.lol), GitHub issues, contributing guide.

## What Ships Now vs Later

**Now:**
- Full README restructure with all sections
- Terminal demo SVG (can be generated from CLI on Hetzner)
- Four pillars copy
- Quick start
- Collapsible deep dives (migrated from current README)

**Later (when GUI is polished):**
- Hero graph GIF/screenshot as banner
- Graph visualization section with real screenshots
- Landing page update to match

## Terminal Demo Generation

Use `svg-term-cli` or `terminalizer` to record a real CLI session against the Hetzner Engram instance. The recording shows actual data, not fake examples. Keep it under 10 seconds of playback.

## Writing Standards

- Every section gets run through `prose_analyze` (agent-forge) in documentation format
- Fix all flagged AI patterns before committing
- No em dashes (per Master's rules)
- Short sentences. Active voice. No filler.
- Approved final copy gets fed to `prose_learn` to build the documentation voice profile

## Out of Scope

- GUI improvements (separate task, frontend skills being installed)
- Authentik SSO for Pangolin (separate task)
- Landing page update (future, shares assets with README)
