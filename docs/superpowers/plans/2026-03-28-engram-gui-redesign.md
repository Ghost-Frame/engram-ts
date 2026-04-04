# Engram GUI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the current SvelteKit GUI with a standalone graph.html (raw Three.js + 3d-force-graph, zero framework) and a Next.js 15 app for CRUD pages, deployed as a single Docker container.

**Architecture:** Two independent artifacts: (1) engram-gui/public/graph.html - a single self-contained HTML file with inline JS using CDN-loaded Three.js and 3d-force-graph, (2) engram-gui/ - a Next.js 15 App Router project with Tailwind CSS 4.

**Tech Stack:**
- Graph: Three.js r169 + 3d-force-graph 1.77.x from CDN (pinned). Vanilla JS. No build step.
- GUI: Next.js 15, React 19, TypeScript, Tailwind CSS 4. No external UI component library.
- Deployment: Single Docker container (node:22-alpine), registered in Pangolin.

---

## CRITICAL INVARIANTS (Read before every task)

These have been violated repeatedly by past agents. Treat as hard constraints:

1. **Background color**: Graph is #050a0a. GUI is #0a0a0a. NEVER teal, purple, or bright.
2. **Bloom settings**: strength=1.3, radius=0.5, threshold=0.12. LOCKED. Do not change.
3. **Performance**: 30fps minimum with 1000 nodes. If a feature breaks this, cut the feature.
4. **Graph is standalone**: graph.html has ZERO imports, ZERO build step, ZERO framework. CDN only.
5. **InstancedMesh**: Nodes use InstancedMesh, NOT individual Sprites. One draw call.
6. **GPU animation**: Breathing via vertex shader uniforms, NOT per-node JS in onEngineTick.
7. **No server changes**: The Engram API server (src/routes/index.ts) is not modified.

---

## Part 1: Graph Visualization (graph.html)

The graph is the critical deliverable. Built as a single HTML file with CDN dependencies.

### API Response Shape

The /graph?depth=N&max=N endpoint returns nodes with fields: id (mN/eN/pN), label, type, category, importance, group, size, source, created_at, is_static, content, source_count, version, pagerank_score. Edges have: source, target, type, weight. Node types: memory (id=mN), entity (id=eN), project (id=pN).

**Community coloring note:** The graph API does not include community_id on node data. Node coloring uses category-based colors as the primary scheme.

---

### Task G1: Minimal working graph - data fetch + basic render
- [ ] **Complete**

**File:** engram-gui/public/graph.html
**Action:** Create
**Time estimate:** 5 min

Create the minimal graph.html that: (1) Loads Three.js r169 and 3d-force-graph 1.77.5 from CDN (unpkg, pinned) via importmap, (2) Reads engram_api_key and engram_url from localStorage, (3) Shows a settings modal if no API key set (URL + key inputs, save to localStorage), (4) Fetches /graph?depth=2&max=1500 with Bearer auth, (5) Renders with ForceGraph3D using default node rendering, (6) Background: #050a0a, (7) Basic orbit controls.

**Structure:** Single HTML file. All CSS in inline style tag. importmap for Three.js r169 + 3d-force-graph from unpkg. All JS in single script type=module. HTML: graph-container div, settings-modal div, loading-overlay div.

**Data fetch:** fetchJson(path, opts) helper wrapping fetch with Bearer auth header and JSON content-type. Reads API_URL and API_KEY from localStorage.

**Graph init:** ForceGraph3D()(container).backgroundColor("#050a0a").showNavInfo(false).warmupTicks(150).cooldownTicks(300)

**Verification:** Dark background (#050a0a), default nodes/edges render, orbit controls work, settings modal if no key.

**Commit:** feat(graph): minimal working graph with data fetch and dark background

---

### Task G2: Texture atlas - organism textures
- [ ] **Complete**

**File:** engram-gui/public/graph.html
**Action:** Modify
**Time estimate:** 5 min
**Depends on:** G1

Create 8 organism texture variants on a single 512x256 atlas canvas (4x2 grid, 128x128 cells). Each variant has: corona gradient (subtle outer glow), membrane ring (faint circle at r=28), 4-10 organelles (bright dots, seeded random positions), nucleus (bright center radial gradient), 3 internal filaments (curved arcs), circular mask (eliminates square artifacts under bloom). All white/neutral tones - color applied via InstancedMesh color attribute.

**Functions:** seededRng(seed, n) - deterministic PRNG identical to reference (LCG: (s * 1103515245 + 12345) & 0x7fffffff). drawOrganismCell(ctx, ox, oy, size, seed) - draws one organism variant at offset, same visuals as reference lines 101-184. createTextureAtlas(THREE) - creates 512x256 canvas, returns { texture, CELL:128, COLS:4, ROWS:2 }. createRingTexture(THREE) - 64x64 canvas, golden ring gradient for static nodes.

**Verification:** 8 distinct organism variants visible on atlas. No bleeding between cells.

**Commit:** feat(graph): texture atlas with 8 organism variants

---

### Task G3: InstancedMesh node rendering
- [ ] **Complete**

**File:** engram-gui/public/graph.html
**Action:** Modify
**Time estimate:** 5 min
**Depends on:** G2

Replace default rendering with InstancedMesh. One draw call for all nodes.

**Color constants:** CATEGORY_COLORS = { general:"#4fc3f7", decision:"#ba68c8", task:"#81c784", state:"#ff8a65", discovery:"#64b5f6", reference:"#f06292", issue:"#e57373", preference:"#fff176" }

**InstancedMesh setup:** PlaneGeometry(1,1) + custom ShaderMaterial with atlas/uTime/cellSize uniforms. Max 2000 instances. Set to layer 1 for bloom isolation.

**Custom InstancedBufferAttributes:** aVariant (float, atlas cell 0-7), aPhase (float, breathing phase offset seeded from node ID), aSize (float, Math.max(4, importance * 1.8 + size * 0.4)).

**Integration with 3d-force-graph:** Suppress built-in rendering: graph.nodeThreeObject(() => { const o = new THREE.Object3D(); o.visible = false; return o; }). Add nodeMesh to graph.scene().

**onEngineTick position update:** Loop nodes, set position from force layout, billboard via camera quaternion copy, update instanceMatrix. Also update uTime uniform for GPU animation.

**Color at data load:** Loop nodes, set instanceColor from CATEGORY_COLORS. nodeMesh.instanceColor.needsUpdate = true.

**Static node ring overlay:** Separate small InstancedMesh (max 50, golden #ffd700, opacity 0.15, scale 1.15x).

**Verification:** Organism-textured billboards, category colors, golden static rings, single draw call, FPS >= 60.

**Commit:** feat(graph): InstancedMesh node rendering with category colors

---

### Task G4: GPU-side breathing animation
- [ ] **Complete**

**File:** engram-gui/public/graph.html
**Action:** Modify
**Time estimate:** 4 min
**Depends on:** G3

Breathing animation entirely in vertex shader. Only uTime uniform updated per frame (already done in G3 onEngineTick).

**VERTEX_SHADER:** Uses uTime + aPhase for per-node breathing (8% scale oscillation at 0.8Hz = uTime*5.0265) and opacity pulse (5% variation at 1.2Hz = uTime*7.5398). Billboards via instanceMatrix origin + scaled position offset. Atlas UV lookup from aVariant (col = mod(idx,4), row = floor(idx/4), UV Y-flipped for canvas coordinate system).

**FRAGMENT_SHADER:** Sample atlas at vUv, discard if alpha < 0.01, output vColor * tex.rgb with tex.a * vOpacity.

**Constants:** 5.0265 = 0.8 * 2*PI (0.8Hz breath), 7.5398 = 1.2 * 2*PI (1.2Hz pulse).

**Verification:** Gentle pulsing, smooth animation, FPS unchanged, onEngineTick < 1ms.

**Commit:** feat(graph): GPU-side breathing animation via vertex shader

---

### Task G5: Three-layer edge system
- [ ] **Complete**

**File:** engram-gui/public/graph.html
**Action:** Modify
**Time estimate:** 5 min
**Depends on:** G3

**desaturate(hex, amount) helper:** Convert to HSL via THREE.Color, reduce saturation by amount, return hex string.

**Layer 1 - Topology (always visible):** linkWidth(0.15), linkOpacity(link => 0.08 + link.weight * 0.12), linkColor(desaturate(source node category color, 0.5)), linkCurvature(0.2), linkCurveRotation(0).

**Layer 2 - Flow particles (strong connections):** Pre-compute particleEdgeSet: filter edges weight >= 0.5, sort by weight desc, take top 200. linkDirectionalParticles(min(6, floor(weight*6))) for set members, 0 otherwise. linkDirectionalParticleWidth(2). linkDirectionalParticleSpeed(0.003 + weight*0.008). Particle color = source node category color at full saturation.

**Edge LOD (every 10 frames in onEngineTick):** Check camera distance. far(>2000): show weight >= 0.5 only. mid(800-2000): weight >= 0.2. close(<800): all edges visible.

**Layer 3 (hover amplification) wired in Task G7.**

**Verification:** Faint curved edges, flow particles on strong edges, LOD works with zoom, FPS >= 30.

**Commit:** feat(graph): three-layer edge system with LOD

---

### Task G6: Bloom postprocessing
- [ ] **Complete**

**File:** engram-gui/public/graph.html
**Action:** Modify
**Time estimate:** 5 min
**Depends on:** G4

Import UnrealBloomPass from three/addons/postprocessing/UnrealBloomPass.js. Add to graph.postProcessingComposer().

**LOCKED VALUES - DO NOT CHANGE:** strength=1.3, radius=0.5, threshold=0.12. Threshold 0.12 naturally isolates bright node centers from dim edges (opacity 0.08-0.20) and near-black background (#050a0a).

**Star field:** 400 dim points spread across 5000-unit cube. THREE.Points with PointsMaterial: size 0.8, vertexColors true, transparent true, opacity 0.7, sizeAttenuation true. Colors: 0.3-1.0 brightness with slight blue tint. Added to graph.scene() on default layer (no bloom).

**Verification:** Soft bloom halos on nodes, background stays #050a0a, edges do not bloom, stars visible as faint dots, bioluminescent aesthetic, FPS >= 30 at 1000 nodes.

**Commit:** feat(graph): bloom postprocessing with star field

---

### Task G7: Interaction handlers
- [ ] **Complete**

**File:** engram-gui/public/graph.html
**Action:** Modify
**Time estimate:** 5 min
**Depends on:** G5, G6

**State tracking:** nodeMap (Map, id->node), highlightNodes (Set), highlightLinks (Set), searchHighlights (Set), hoverNode (null|node), pinnedNode (null|node).

**Build neighbor/link lookup at data load:** Iterate nodes: set neighbors=[], links=[], add to nodeMap. Iterate edges: push neighbors and links on both source and target endpoints.

**Hover handler (Layer 3 amplification):** On node hover: add node + neighbors to highlightNodes, add connected links to highlightLinks. Update edge styling: highlighted edges -> opacity 0.6, width weight*2; non-highlighted when hovering -> opacity 0.02; particles doubled on highlighted edges. Set cursor to pointer.

**Click handler:** Set pinnedNode. Zoom to node: compute camera position at distance 120 from node, transition 1500ms via graph.cameraPosition(). Call showDetailPanel(node).

**Search highlight:** updateNodeColors() function sets gold (#ffd700) for IDs in searchHighlights Set, restores category color for others, via nodeMesh.setColorAt() + needsUpdate.

**Background click:** Clear pinnedNode, highlightNodes, highlightLinks, searchHighlights. Close detail panel. Restore default edge styling and colors.

**Right-click:** preventDefault, graph.zoomToFit(800, 50).

**Verification:** Hover brightens connected edges, click zooms, search highlights gold, background click resets, right-click fits view.

**Commit:** feat(graph): hover, click, search highlighting, edge amplification

---

### Task G8: UI overlay
- [ ] **Complete**

**File:** engram-gui/public/graph.html
**Action:** Modify
**Time estimate:** 5 min
**Depends on:** G7

**HTML overlays (all fixed position, z-index 50):**

**Top bar:** Gradient fade background (rgba(5,10,10,0.85) to transparent). Contains: back link (arrow + "Back"), "ENGRAM" logo (gradient text teal-to-cyan), search form (text input + submit on Enter), stats display (node count, edge count, set once after load).

**Controls panel (bottom-left):** Glassmorphism: background rgba(10,14,20,0.85), backdrop-filter blur(20px), border rgba(255,255,255,0.06), border-radius 12px. Contains: weight threshold range slider (0 to 1, step 0.05, controls graph.linkVisibility), labels toggle button (controls graph.nodeLabel), clusters toggle button (controls toggleClusters function), fit view button (calls graph.zoomToFit).

**Detail panel (right sidebar, 380px):** Background rgba(10,14,20,0.92), backdrop-filter blur(30px), border-left rgba(255,255,255,0.06). Slides in via CSS transform translateX(100%) default, translateX(0) with .open class, transition 0.3s ease. Close button top-right. Dynamic content area populated by buildDetailHTML(mem).

**buildDetailHTML(mem) returns:** Full content text (pre-wrap), category badge (colored), source tag, version tag, static badge, importance bar (colored fill width%), decay bar (teal fill), created/updated dates, access count, last accessed, episode title, tags as pills (teal-tinted), linked memories list (with similarity %, type badge, zoom-to button each), version chain timeline (vertical dots), "Open in GUI" link to /memories/{id}.

**Search form handler:** POST to /search with query + limit 20. Call highlightSearchResults with result IDs. Show results in detail panel as clickable list with zoom-to-node buttons.

**FPS counter:** Small div top-right, hidden by default. Toggle with F key. Updates every 30 frames.

**Escape key:** Closes detail panel.

**Verification:** All controls functional, detail panel shows full info, search works, no per-frame DOM updates.

**Commit:** feat(graph): UI overlay with search, controls, and detail panel

---

### Task G9: Force layout tuning
- [ ] **Complete**

**File:** engram-gui/public/graph.html
**Action:** Modify
**Time estimate:** 3 min
**Depends on:** G1

**Force configuration:** charge strength -1500, distanceMax 3000. Link distance: weight>=0.7 -> 30px, weight>=0.3 -> 80px, else 600px. Link strength: weight>=0.7 -> 1.5, weight>=0.5 -> 0.5, else 0 (weak links exert zero force, visual only). Center strength 0.005.

**Cluster forces:** Compute Fibonacci sphere centroids based on node categories. makeClusterForce(centroids, dim, strength) function: iterates nodes, applies gentle pull toward category centroid. Apply with strength 0.03 for X, Y, Z dimensions. Toggle function for UI: when disabled, set cluster forces to null and reheat simulation.

**Camera:** zoomToFit(800, 50) after 3-second delay (layout settling). controls.minDistance = 50, controls.maxDistance = 5000.

**Verification:** Organic branch-like structure, categories cluster gently, simulation stops after 300 tick cooldown.

**Commit:** feat(graph): force layout tuning with cluster forces

---

### Task G10: Performance verification
- [ ] **Complete**

**File:** engram-gui/public/graph.html
**Action:** Modify
**Time estimate:** 3 min
**Depends on:** G1-G9

**FPS counter:** Toggle with F key (only when no input focused). Calculates FPS every 30 frames, displays in top-right corner.

**URL parameter support:** ?max=N for node limit (default 1500), ?center=mN for centered view. Applied to fetch URL.

**Performance budget verification:**

| Metric | Target | Absolute Minimum |
|--------|--------|-----------------|
| FPS 1000 nodes | 60fps | 30fps |
| FPS 2000 nodes | 30fps | 20fps |
| Memory usage | < 500MB | < 800MB |
| Load to interactive | < 3s | < 5s |

**Optimization fallbacks if below target (apply in order):** (1) Reduce particle edge cap from 200 to 100, (2) Increase edge LOD far threshold from weight 0.5 to 0.7, (3) Reduce star field from 400 to 200 points, (4) Last resort: disable bloom.

**Commit:** feat(graph): performance verification with FPS counter and URL params

---

## Part 2: Next.js GUI Application

---

### Task N1: Project scaffolding
- [ ] **Complete**

**File:** engram-gui/ (entire directory)
**Action:** Create
**Time estimate:** 5 min

Run: npx create-next-app@latest engram-gui --typescript --tailwind --eslint --app --src-dir --no-turbopack --import-alias "@/*"

**Modify next.config.js:** Set output: "standalone" for Docker deployment.

**Modify tailwind.config.ts:** Extend theme.colors with engram palette: bg (#0a0a0a), surface (#111111), border (#1a1a1a), border-hover (#252525), cyan (#4fc3f7), purple (#ba68c8), green (#81c784), orange (#ff8a65), blue (#64b5f6), pink (#f06292), yellow (#fff176), teal (#4db6ac), red (#e57373), indigo (#7986cb), lime (#aed581), amber (#ffb74d).

**Modify globals.css:** Dark body background (bg-engram-bg text-gray-200 antialiased), custom scrollbar (6px, transparent track, rgba(255,255,255,0.08) thumb).

**Verification:** npm run dev starts, dark background loads, Tailwind classes work.

**Commit:** feat(gui): Next.js 15 project scaffolding with Tailwind

---

### Task N2: API client library and types
- [ ] **Complete**

**Files:** src/lib/types.ts, src/lib/engram-client.ts
**Action:** Create
**Time estimate:** 4 min
**Depends on:** N1

**types.ts:** Full TypeScript interfaces matching actual API responses. Memory (id, content, category, source, importance, created_at, updated_at, is_static, is_archived, source_count, version, is_latest, tags[], decay_score, access_count, last_accessed_at, score, semantic_score, episode{id,title}, links: MemoryLink[], version_chain: VersionEntry[], explain{vector,reranker,rrf,decay,static,corroborated,reasons[]}). MemoryLink (id, similarity, type, content, category). VersionEntry (id, content, version, is_latest). Entity (id, name, type, description, memory_count, created_at). Project (id, name, status, description, memory_count, created_at). HealthResponse (status, version, memories, entities, episodes, pending, static, versioned, llm_configured, embedding_model, db_size_mb). SearchResponse (results: Memory[], abstained: boolean). StatsResponse (total_memories, db_size_mb, memories.categories[]).

**engram-client.ts:** Singleton class. Constructor reads localStorage engram_url and engram_api_key. isConfigured(). setCredentials(url, key). Private request<T>(path, opts?) with Bearer auth. Methods: health(), stats(), search(query, opts?), store(content, opts?), listMemories(opts?), getMemory(id), deleteMemory(id), archiveMemory(id), getInbox(limit?), approveMemory(id), rejectMemory(id), getEntities(type?), getProjects(status?), graph(opts?). Exported via getClient() singleton factory.

**Commit:** feat(gui): API client library and TypeScript types

---

### Task N3: Shared layout
- [ ] **Complete**

**Files:** src/app/layout.tsx, src/components/layout/Sidebar.tsx, Header.tsx, ApiKeyModal.tsx, AppShell.tsx
**Action:** Create
**Time estimate:** 5 min
**Depends on:** N1, N2

**Root layout (layout.tsx):** Server component. Sets metadata (title: Engram). Imports globals.css. Wraps children in AppShell client component.

**AppShell (client component):** Renders Sidebar + Header + main content area. Manages sidebarCollapsed state (persisted in localStorage), showApiKeyModal state. Calls client.health() on mount for connection status.

**Sidebar:** Navigation items: Dashboard / (grid icon), Search /search (search icon), Graph /graph.html (circle-dot icon, external <a> tag not Next Link), Inbox /inbox (inbox icon), Entities /entities (users icon), Projects /projects (folder icon), Timeline /timeline (clock icon). Active state: border-l-2 border-engram-cyan, bg-engram-cyan/10, text-engram-cyan. Inactive: text-gray-400, hover:bg-white/5. Collapsible: 56px collapsed (icons only), 208px expanded (icon + label). Toggle button at sidebar bottom.

**Header:** Full-width bar above main content. ENGRAM branding text (bg-gradient from engram-cyan to engram-teal, bg-clip-text transparent). Connection status dot (w-2 h-2 rounded-full, bg-green-400 if healthy, bg-red-400 if not). API key config button (top-right).

**ApiKeyModal:** Dialog overlay (fixed inset-0, bg-black/60). Card with URL input (default window.location.origin), API key input (type password), Save button. On save: calls client.setCredentials(), tests /health, closes on success, shows error on failure.

**Verification:** Layout renders with sidebar and header. Navigation works. Graph link opens graph.html. Sidebar persists collapse state. API key modal works.

**Commit:** feat(gui): shared layout with sidebar, header, API key modal

---

### Task N4: Shared components
- [ ] **Complete**

**Files:** src/components/shared/MemoryCard.tsx, CategoryBadge.tsx, StatsCard.tsx
**Action:** Create
**Time estimate:** 3 min
**Depends on:** N2

**CategoryBadge:** Props: category string. Colored pill span. Mapping: task=green, discovery=blue, decision=purple, state=orange, issue=red, reference=pink, general=cyan, preference=yellow. Style: bg-{color}/10 text-{color}, px-2 py-0.5 rounded-full text-[10px] font-medium.

**MemoryCard:** Props: memory Memory, onArchive? (id)=>void, onDelete? (id)=>void, compact? boolean, showActions? boolean. Dark card: bg-engram-surface border-engram-border rounded-lg p-3 hover:border-engram-border-hover transition-colors. Shows: row with #id mono, CategoryBadge, source tag, timestamp right-aligned. Content text-sm text-gray-300, line-clamp-2 if compact. Explain reasons as small pills. Archive/Delete buttons if showActions.

**StatsCard:** Props: label string, value number|string, color? string. Dark surface card: bg-engram-surface border-engram-border rounded-xl p-4. Large number (text-2xl font-bold) in specified color, small label below (text-xs text-gray-500).

**Commit:** feat(gui): shared components

---

### Task N5: Dashboard page
- [ ] **Complete**

**File:** src/app/page.tsx
**Action:** Create (use client component)
**Time estimate:** 4 min
**Depends on:** N3, N4

On mount: client.health() for stats, client.listMemories({limit:10}) for recent list. Layout: 4-column stats grid (Memories, Entities, Episodes, Pending using StatsCard), 3-column model status row (LLM on/off, embedding model name, static/versioned counts), collapsible quick-store form (textarea, category dropdown with all 8 categories, importance slider 1-10 default 5, submit button calling client.store()), recent memories list using MemoryCard components in compact mode.

**Commit:** feat(gui): dashboard page with stats and quick store

---

### Task N6: Search page
- [ ] **Complete**

**File:** src/app/search/page.tsx
**Action:** Create (use client component)
**Time estimate:** 4 min
**Depends on:** N3, N4

Search input with submit button. Mode selector: button row (auto, fact, timeline, preference, decision, recent). Active mode: bg-engram-cyan/20 text-engram-cyan border-engram-cyan/40. Inactive: bg-engram-surface text-gray-400 border-engram-border. Results list with MemoryCard (showActions=true). Archive calls client.archiveMemory(), delete calls client.deleteMemory(), both remove from results state. Abstain indicator: amber banner when response.abstained. Result count. Loading spinner.

**Commit:** feat(gui): search page with mode selector

---

### Task N7: Inbox page
- [ ] **Complete**

**File:** src/app/inbox/page.tsx
**Action:** Create (use client component)
**Time estimate:** 4 min
**Depends on:** N3, N4

Load client.getInbox() on mount. Pending count badge next to heading. Per-item: MemoryCard with approve (green) and reject (red) buttons. Approve: client.approveMemory(id), remove from list. Reject: client.rejectMemory(id), remove from list. Bulk actions bar: select-all checkbox, approve-selected button, reject-selected button. Selected items tracked in Set<number>. Empty state: checkmark icon + "Inbox empty" message. Loading state.

**Commit:** feat(gui): inbox page with bulk actions

---

### Task N8: Entities page
- [ ] **Complete**

**File:** src/app/entities/page.tsx
**Action:** Create (use client component)
**Time estimate:** 3 min
**Depends on:** N3, N4

Load client.getEntities() on mount. Type filter buttons: all, person, server, tool, service, project, organization. Client-side filtering. 2-column card grid. Each card: type icon (Unicode symbols per type), entity name (font-medium), type badge (colored by type), description (line-clamp-2), memory count. Entity count display. Empty state.

**Commit:** feat(gui): entities page with type filtering

---

### Task N9: Projects page
- [ ] **Complete**

**File:** src/app/projects/page.tsx
**Action:** Create (use client component)
**Time estimate:** 3 min
**Depends on:** N3, N4

Load client.getProjects() on mount. Status filter buttons: all, active, completed, paused, archived. Client-side filtering. List layout. Each project: name (font-medium), status badge (colored: active=green, completed=blue, paused=amber, archived=gray), description (line-clamp-2), memory count. Empty state.

**Commit:** feat(gui): projects page with status filtering

---

### Task N10: Timeline page
- [ ] **Complete**

**File:** src/app/timeline/page.tsx
**Action:** Create (use client component)
**Time estimate:** 4 min
**Depends on:** N3, N4

Load client.listMemories({limit:50}) on mount. Category filter buttons (same pattern). Client-side filtering. Date grouping: group memories by YYYY-MM-DD from created_at. Timeline visual: vertical line on left (2px, gray-800), dot per memory (w-2.5 h-2.5 rounded-full border-2 border-gray-700 bg-engram-bg), cards branching right. Date group headers as bold text. Category-colored left border on each card (border-l-4). Card content: id, category badge, source, timestamp, full text.

**Commit:** feat(gui): timeline page with date grouping

---

### Task N11: Memory detail page
- [ ] **Complete**

**File:** src/app/memories/[id]/page.tsx
**Action:** Create (use client component)
**Time estimate:** 4 min
**Depends on:** N3, N4

Dynamic route page. Extract id from params. Load client.getMemory(id) on mount. Full content display (large readable block, whitespace-pre-wrap, text-sm text-gray-300). Metadata grid (2 columns): CategoryBadge, source agent tag, importance bar (colored fill, width proportional to importance/10), decay score bar (teal fill), created date, updated date, access count, last accessed, version number, static badge (if is_static), episode link (if episode present). Tags section: pills row (teal-tinted). Linked memories section: list of cards with similarity %, type badge, content preview, each linking to /memories/{linked_id} via Next Link. Version chain: vertical timeline with dots, version number, content preview, "latest" marker. Action buttons: Archive (confirm dialog), Delete (confirm dialog). "View in Graph" link: /graph.html?center={id}. Back button.

**Commit:** feat(gui): memory detail page with full metadata

---

### Task N12: Dockerfile and docker-compose
- [ ] **Complete**

**Files:** engram-gui/Dockerfile, docker-compose.yml, .dockerignore
**Action:** Create
**Time estimate:** 3 min
**Depends on:** N1

**Dockerfile:** Multi-stage build. Stage 1 (builder): FROM node:22-alpine, WORKDIR /app, COPY package*.json, RUN npm ci, COPY ., RUN npm run build. Stage 2 (runner): FROM node:22-alpine, WORKDIR /app, ENV NODE_ENV=production, COPY --from=builder /app/.next/standalone ./, COPY --from=builder /app/.next/static ./.next/static, COPY --from=builder /app/public ./public, EXPOSE 3000, CMD ["node", "server.js"].

**docker-compose.yml:** Single service engram-gui, build ., ports 3000:3000, environment NODE_ENV=production, restart unless-stopped.

**.dockerignore:** node_modules, .next, .git, *.md, .env*

**Verification:** docker build succeeds, docker run serves app on port 3000, /graph.html accessible, all pages work.

**Commit:** feat(gui): Dockerfile and docker-compose for deployment

---

## Execution Order

**Phase 1 (Graph - critical path, do first):**
G1 -> G2 -> G3 -> G4 -> G5 -> G6 -> G7 -> G8 -> G9 -> G10

Each task builds on the previous. G9 (force tuning) can technically be applied right after G1 since it is just d3Force configuration, but it is listed at G9 to keep the layering clean.

**Phase 2 (GUI - can start after G1, runs parallel with remaining graph):**
N1 -> N2 -> N3 -> N4 -> [N5, N6, N7, N8, N9, N10, N11 in parallel] -> N12

N5-N11 are independent pages and can be implemented in any order or in parallel. N12 (Docker) depends only on N1.

**Final step:** Copy completed graph.html into engram-gui/public/graph.html so it is served by the Next.js container.

---

## Risk Matrix

| Risk | Impact | Mitigation |
|------|--------|------------|
| InstancedMesh + 3d-force-graph integration | High | Suppress built-in rendering via invisible nodeThreeObject, add InstancedMesh to graph.scene(). Fallback: per-node Sprite with shared material + atlas (still fast with shared textures). |
| importmap browser support | Medium | Supported in Chrome 89+, Firefox 108+, Safari 16.4+. Add es-module-shims polyfill script for older browsers. |
| Bloom bleeding to edges/background | Medium | Threshold 0.12 should isolate bright nodes. If edges bloom, reduce edge base opacity from 0.08 to 0.04. |
| UV atlas coordinate math wrong | Medium | Test with single variant first. Immediately visible if UVs are scrambled. |
| Force layout not settling | Low | Hard cooldown at 300 ticks via cooldownTicks(300). Simulation stops regardless. |
| Next.js 15 / Tailwind 4 compatibility | Low | Use only stable APIs, pin versions in package.json. |

---

## Files Summary

**New (graph):** engram-gui/public/graph.html (Tasks G1-G10)

**New (GUI):** src/lib/types.ts (N2), src/lib/engram-client.ts (N2), src/app/layout.tsx (N3), src/app/globals.css (N1), src/app/page.tsx (N5), src/app/search/page.tsx (N6), src/app/inbox/page.tsx (N7), src/app/entities/page.tsx (N8), src/app/projects/page.tsx (N9), src/app/timeline/page.tsx (N10), src/app/memories/[id]/page.tsx (N11), src/components/layout/Sidebar.tsx (N3), src/components/layout/Header.tsx (N3), src/components/layout/ApiKeyModal.tsx (N3), src/components/layout/AppShell.tsx (N3), src/components/shared/MemoryCard.tsx (N4), src/components/shared/CategoryBadge.tsx (N4), src/components/shared/StatsCard.tsx (N4), Dockerfile (N12), docker-compose.yml (N12), .dockerignore (N12), next.config.js (N1), tailwind.config.ts (N1)

**Not modified:** src/routes/index.ts (server code, explicitly excluded), gui/ (old SvelteKit GUI, left in place, not deleted)
