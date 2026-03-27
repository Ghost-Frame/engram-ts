# Graph Connection Visibility Redesign

**Date**: 2026-03-26
**Status**: Draft
**File**: `gui/src/routes/graph/+page.svelte`

## Problem

The graph currently renders all edges as invisible (width 0, opacity 0) until a node is hovered. This means there is zero topology visible at rest. The user must hover individual nodes one at a time to understand connectivity, which makes the graph feel like a collection of floating dots rather than a connected knowledge network.

## Design

Three rendering layers, each building on the last.

### Layer 1: Faint Static Edges (always visible)

All edges with weight above the slider threshold get thin translucent lines showing the graph's topology at rest.

| Property | Value |
|----------|-------|
| Width | 0.3px constant (hairline) |
| Opacity | `weight * 0.15` (very subtle) |
| Color | Source node's community color at that alpha |
| Condition | `weight >= weightThreshold` (slider-controlled) |

When `weight * 0.15 < 0.02`, the edge renders as fully transparent to avoid wasting draw calls on invisible geometry.

### Layer 2: Flow Trail Particles (weight >= 0.5)

Persistent directional particles on stronger connections, creating a sense of information flowing through the network. These always appear on qualifying edges regardless of the slider position.

| Property | Value |
|----------|-------|
| Particle count | `Math.floor(weight * 6)` -- 1 to 6, scaling with strength |
| Particle speed | `0.002 + weight * 0.006` -- slow drift at 0.5, zippy at 1.0 |
| Particle width | `1.5 + weight * 2` -- subtle to prominent |
| Particle color | Source node's community color (picks up bloom glow) |
| Performance cap | Top 200 edges by weight (sorted descending, capped) |

The 200-edge cap prevents particle overload on dense graphs. Edges are sorted by weight so the strongest connections always get particles.

### Layer 3: Hover Amplification (interaction-driven)

When a node is hovered, its direct connections amplify while everything else dims.

| Property | Hovered edges | Non-connected edges |
|----------|--------------|-------------------|
| Width | `max(0.8, weight * 3)` | 0.3 (unchanged) |
| Opacity | `max(0.3, weight)` | 0.03 (near-zero dim) |
| Particles | Base count x2 | Unchanged |
| Particle width | `2.5 + weight * 2` | Unchanged |

The dim on non-connected edges uses 0.03 rather than 0 to maintain a ghost trace of topology and avoid a harsh visual pop when hover starts/ends.

### Slider Behavior

The "Edge Floor" slider (renamed from "Edge Weight") controls the minimum weight for Layer 1 faint lines. Layer 2 flow trails always activate at weight >= 0.5 regardless of slider position.

## Implementation Scope

Changes are confined to:

1. A new `particleEdges` Set computed once after edge data loads (~5 lines after the edge pre-processing loop)
2. The link configuration chain on the ForceGraph3D instance (lines 450-459 replaced)
3. The slider label text (one line)

NOT touched: node rendering, UI panels, force simulation, clustering, search, star field, bloom pass.

## Performance Considerations

- ~800 nodes, ~1500 edges is the current graph size
- Layer 1 hairlines are simple GL lines with no texture -- negligible cost
- Layer 2 particles capped at 200 emitting edges with 1-6 particles each (max 1200 particles)
- The `particleEdges` Set is computed once (sort + slice), lookups are O(1) per frame
- ForceGraph3D re-evaluates link callbacks each frame; all callbacks are simple conditionals with Set.has() checks

## Rollback

Revert the link config block (lines 450-459) to the original invisible-until-hover behavior. Single-file change, no data model or API impact.
