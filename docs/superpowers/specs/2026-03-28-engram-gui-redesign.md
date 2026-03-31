# Engram GUI Redesign

**Date:** 2026-03-28
**Status:** Draft
**Reference:** Commit `e5d0b8b` saved at `docs/superpowers/specs/reference/graph-good-version-e5d0b8b.svelte`

---

## Problem

The Engram GUI has been through 10+ visual iterations across multiple agents over 2+ weeks. Each iteration made things worse:

- Background kept becoming bright teal/purple instead of staying dark
- Edge/connection lines became barely visible
- Nodes lacked bloom, shape detail, and structure
- Performance degraded to ~5fps with the full memory graph (~1000 nodes, ~2800 edges)
- The bolt-graph React + React Three Fiber rewrite was abandoned as a complete failure
- Agents could not see what they were producing, leading to blind iteration loops

One version (commit `e5d0b8b`, "living organism nodes with flow trail connections") was close to correct. It had curved lines, bioluminescent organism nodes, and a three-layer edge system. It needed polish on colors, line visibility, node detail, and performance. Instead of polishing it, subsequent iterations destroyed it.

## Solution

Two-part rebuild:

1. **Next.js React app** for the GUI shell (dashboard, search, inbox, entities, projects, timeline)
2. **Standalone graph.html** bundled in Next.js `public/` for the 3D memory graph visualization

The graph page is built fresh, using commit `e5d0b8b` purely as visual inspiration for the bioluminescent aesthetic. Performance is the #1 constraint.

## Architecture

### Project Structure

```
engram-gui/
  public/
    graph.html          # Standalone graph visualization (zero framework)
  src/
    app/
      layout.tsx        # Root layout with sidebar nav
      page.tsx          # Dashboard
      search/page.tsx   # Search interface
      inbox/page.tsx    # Memory review queue
      entities/page.tsx # Entity management
      projects/page.tsx # Project tracking
      timeline/page.tsx # Temporal memory view
    components/
      layout/
        Sidebar.tsx     # Navigation sidebar
        Header.tsx      # Top bar with search
      shared/
        MemoryCard.tsx  # Reusable memory display
        StatsCard.tsx   # Dashboard stat widget
        CategoryBadge.tsx
      search/
        SearchBar.tsx
        ResultList.tsx
      inbox/
        InboxItem.tsx
        BulkActions.tsx
    lib/
      engram-client.ts  # API client (fetch wrapper with Bearer auth)
      types.ts          # Shared TypeScript types
  package.json
  next.config.js
  tailwind.config.ts
  Dockerfile
  docker-compose.yml
```

### Tech Stack

**GUI (Next.js app):**
- Next.js 15 (App Router, SSR-ready)
- React 19
- TypeScript
- Tailwind CSS 4
- No additional UI library (custom components, dark theme)

**Graph (standalone HTML):**
- Three.js (from CDN, pinned version)
- 3d-force-graph (from CDN, pinned version)
- Vanilla TypeScript/JavaScript
- No build step, no bundler, no framework

### Shared State

- **Auth token:** localStorage key `engram_api_key`
- **API URL:** localStorage key `engram_url` (falls back to `window.location.origin`)
- **Navigation:** Graph links to GUI via standard `<a>` tags (e.g. clicking a node links to `/memories/{id}`)
- **GUI to graph:** Sidebar link to `/graph`, can pass query params for filtering (e.g. `/graph?center=m123`)

### Deployment

- Single Docker container running Next.js
- `graph.html` served as a static file from `public/`
- Registered in Pangolin dashboard as a site
- Traefik handles TLS and routing through Pangolin

---

## Graph Visualization Spec

### Visual Reference

The target aesthetic is "bioluminescent neural network" as achieved in commit `e5d0b8b`:
- Organism-like nodes with nucleus, membrane, organelles, internal filaments
- Curved connection lines between nodes
- Glowing bloom postprocessing
- Dark space background with subtle star field
- Community-based color coding

### Performance Budget (Hard Constraints)

These are non-negotiable. If a visual feature breaks the budget, the feature gets cut.

| Metric | Target | Absolute Minimum |
|--------|--------|-----------------|
| FPS with 1000 nodes | 60fps | 30fps |
| FPS with 2000 nodes | 30fps | 20fps |
| Initial load to interactive | < 3s | < 5s |
| Memory usage | < 500MB | < 800MB |

### Performance Rules

1. **Texture atlas, not individual textures.** All node variants baked into a single texture atlas. One draw call for all nodes.
2. **InstancedMesh for nodes.** Not individual Sprite objects. One geometry, one material, instanced rendering.
3. **GPU-side animation.** Breathing/pulse via vertex shader uniforms, not per-node JS updates every frame.
4. **Edge LOD (Level of Detail):**
   - Camera far: Only edges with weight >= 0.5 rendered
   - Camera mid: Edges with weight >= 0.2 rendered
   - Camera close: All edges rendered
5. **Particle budget:** Maximum 500 total flow particles across all edges. Distribute by edge weight.
6. **Bloom on separate pass:** Only apply UnrealBloomPass to node layer, not the entire scene. Use layer masking.
7. **Force simulation cooldown:** Simulation runs for max 300 ticks then stops. No continuous physics. Reheat only on user interaction (drag, filter change).
8. **Frustum culling:** Three.js default frustum culling stays enabled. Nodes outside camera view are not drawn.
9. **No per-frame DOM updates.** Stats/info panels update on hover/click events only, not on every animation frame.

### Node Rendering

**Organism textures** (from reference version):
- 128x128 canvas textures, pre-generated at load time
- 8 variants with seeded randomization (organelle count, filament angles)
- Features: corona gradient, membrane ring, organelles (4-10 dots), nucleus glow, 3 internal curved filaments
- Circular mask to eliminate square sprite artifacts under bloom
- White/neutral textures, colored via material tint (community or category color)

**Sizing:**
- Base size: `Math.max(4, importance * 1.8 + size * 0.4)`
- Static nodes: golden ring indicator overlay (0.15 opacity)
- Search-highlighted nodes: gold tint (#ffd700)

**Animation:**
- Breathing: 8% scale oscillation at 0.8Hz with per-node phase offset
- Opacity pulse: subtle 0.05 variation at 1.2Hz
- Implemented via vertex shader uniform, not per-node JS

### Edge Rendering (Three-Layer System)

From the reference version, refined for visibility:

**Layer 1 -- Topology (always visible):**
- All edges with weight >= `weightThreshold` (user-adjustable slider, default 0)
- Curved lines (quadratic bezier with midpoint offset proportional to distance)
- Opacity: `0.08 + weight * 0.12` (faint but visible, not invisible)
- Color: source node's community color, desaturated 50%
- Line width: 1px constant (not weight-scaled, avoids visual noise)

**Layer 2 -- Flow particles (strong connections):**
- Edges with weight >= 0.5, capped at top 200 by weight
- Particle count per edge: `Math.floor(weight * 6)` (max 6 per edge)
- Speed: `0.003 + weight * 0.008`
- Particle size: 2px
- Color: source node color, full saturation
- Total particle budget: 500 max across all edges

**Layer 3 -- Hover amplification:**
- On node hover: connected edges brighten to opacity 0.6
- Particle count doubles on hovered edges
- Non-connected edges fade to 0.02 opacity
- Transition: 200ms ease

### Color Scheme

**Background:** `#050a0a` (near-black with barely perceptible green-dark tint). NOT teal. NOT purple. NOT bright.

**Community colors (12-color palette):**
```
#4fc3f7  (cyan)       #ba68c8  (purple)     #81c784  (green)
#ff8a65  (orange)     #64b5f6  (blue)       #f06292  (pink)
#fff176  (yellow)     #4db6ac  (teal)       #e57373  (red)
#7986cb  (indigo)     #aed581  (lime)       #ffb74d  (amber)
```

**Category fallback colors** (when community_id is null):
```
general: #4fc3f7    decision: #ba68c8    task: #81c784
state: #ff8a65      discovery: #64b5f6   reference: #f06292
issue: #e57373      preference: #fff176
```

**Rules:**
- Background is ALWAYS near-black. No agent changes this.
- Node colors come from community or category. No overrides.
- Edge colors derive from source node color, desaturated. Never bright.
- Bloom makes things glow. The base colors stay muted; bloom provides the luminance.

### Bloom Settings

```
UnrealBloomPass:
  strength: 1.3
  radius: 0.5
  threshold: 0.12
```

These values are from the reference version BEFORE the bloom was cranked up (which was a regression). Layer-masked to node layer only so edges and background are unaffected.

### Force Layout

```
Charge: -1500 strength, 3000 max distance
Link distance: varies by weight
  weight >= 0.7: 30px  (strong links pull close)
  weight >= 0.3: 80px  (medium links, moderate distance)
  weight < 0.3:  600px (weak links, far apart)
Cluster force: 0.03 strength (gentle community grouping)
Warmup: 150 ticks
Cooldown: 300 ticks (then simulation stops)
```

### Camera & Controls

- Orbit controls (rotate, zoom, pan)
- Initial zoom: fit all nodes with 20% padding
- Zoom range: 50 (close) to 5000 (far)
- Double-click node: zoom to node, open detail panel
- Right-click: reset camera to overview

### UI Controls (Overlay)

Minimal floating controls panel (top-right, glassmorphism):
- Search input (filters/highlights nodes)
- Weight threshold slider (0-1, filters edges)
- Toggle: show/hide labels
- Toggle: enable/disable clustering
- Node count / edge count display
- FPS counter (dev mode only, hidden in production)

### Detail Panel (Right Sidebar)

On node click:
- Memory content (full text)
- Category badge, importance score, decay score
- Source agent tag
- Created date
- Tags
- Connected memories list (with similarity scores)
- Version chain (if versioned)
- Link to full memory detail page in GUI (`/memories/{id}`)

---

## Next.js GUI Pages

### Shared Layout

- Dark theme matching graph aesthetic (`#0a0a0a` background, not the same as graph's `#050a0a`)
- Left sidebar with navigation links (Dashboard, Search, Graph, Inbox, Entities, Projects, Timeline)
- Collapsible sidebar
- Top header with global search and connection status indicator
- Tailwind CSS, no external component library

### Dashboard (`/`)

- Stats cards: total memories, entities, episodes, pending inbox items
- LLM/embedding model status
- Recent memories list (last 10)
- Quick store form (add a memory directly)

### Search (`/search`)

- Search input with mode selector (fact, timeline, preference, decision, recent)
- Results list with memory cards
- Actions per result: archive, delete, view detail
- Abstain indicator when Engram declines to answer

### Inbox (`/inbox`)

- Pending/rejected memory queue
- Approve/reject/edit actions per item
- Bulk approve/reject
- Category badges, importance indicators

### Entities (`/entities`)

- Entity list with type filtering
- Relationship count per entity
- Click to see related memories

### Projects (`/projects`)

- Project list with status (active/archived)
- Memory count per project
- Click to see associated memories

### Timeline (`/timeline`)

- Chronological memory view
- Date grouping
- Episode grouping where applicable
- Scroll-based loading

### Memory Detail (`/memories/[id]`)

- Full memory content
- All metadata (category, importance, decay, source, timestamps)
- Version chain
- Related memories (linked)
- Tags
- Edit/archive/delete actions

---

## API Client

Shared between GUI pages. The graph page has its own inline fetch logic.

```typescript
// lib/engram-client.ts
class EngramClient {
  private url: string;
  private key: string;

  constructor() {
    this.url = localStorage.getItem('engram_url') || window.location.origin;
    this.key = localStorage.getItem('engram_api_key') || '';
  }

  private async fetch<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.key}`,
        ...opts?.headers,
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  // Health & stats
  health() { return this.fetch('/health'); }
  stats() { return this.fetch('/stats'); }

  // Memories
  search(query: string, opts?: { limit?: number; mode?: string }) {
    return this.fetch('/search', { method: 'POST', body: JSON.stringify({ query, ...opts }) });
  }
  store(content: string, opts?: { category?: string; importance?: number; source?: string }) {
    return this.fetch('/store', { method: 'POST', body: JSON.stringify({ content, ...opts }) });
  }
  getMemory(id: number) { return this.fetch(`/memories/${id}`); }
  deleteMemory(id: number) { return this.fetch(`/memories/${id}`, { method: 'DELETE' }); }
  archiveMemory(id: number) { return this.fetch(`/memories/${id}/archive`, { method: 'POST' }); }

  // Inbox
  inbox() { return this.fetch('/inbox'); }
  approve(id: number) { return this.fetch(`/inbox/${id}/approve`, { method: 'POST' }); }
  reject(id: number) { return this.fetch(`/inbox/${id}/reject`, { method: 'POST' }); }

  // Graph
  graph(opts?: { depth?: number; max?: number; center?: string }) {
    const params = new URLSearchParams();
    if (opts?.depth) params.set('depth', String(opts.depth));
    if (opts?.max) params.set('max', String(opts.max));
    if (opts?.center) params.set('center', opts.center);
    return this.fetch(`/graph?${params}`);
  }
  communities() { return this.fetch('/communities'); }

  // Entities & Projects
  entities() { return this.fetch('/entities'); }
  projects() { return this.fetch('/projects'); }
}
```

---

## Deployment

### Dockerfile

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

### Registration

Registered in Pangolin dashboard as a site pointing to the container's port on zan-hetzner. Domain TBD (likely `gui.engram.lol` or `app.engram.lol/gui`).

---

## What This Design Does NOT Include

- No authentication/login system (auth is API key in localStorage, entered once)
- No user management (single-user system for now)
- No real-time updates/websockets (polling or manual refresh)
- No mobile-specific layout (desktop-first, responsive enough to not break on mobile)
- No offline support
- No i18n

These can be added later when managed hosting requires them.

---

## Success Criteria

1. Graph renders 1000 nodes at >= 30fps on a mid-range machine
2. Background is dark, nodes glow with bloom, edges are clearly visible curved lines
3. The visual aesthetic matches the bioluminescent neural network from commit `e5d0b8b`
4. All 7 GUI pages are functional and equivalent to the current SvelteKit GUI
5. Single container deployment through Pangolin dashboard
6. No agent can accidentally break the graph by editing GUI code (they're separate files)
