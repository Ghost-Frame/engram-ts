// ============================================================================
// STRUCTURAL ANALYSIS ENGINE
// Deterministic graph analysis using graphology. No AI inside the computation.
// Parses EN syntax (or raw node/edge definitions) and runs topology classification,
// bridge detection, betweenness centrality, shortest path, blast radius, etc.
// ============================================================================

import { log } from "../config/logger.ts";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import betweennessCentrality from "graphology-metrics/centrality/betweenness.js";
import { bidirectional } from "graphology-shortest-path/unweighted.js";

// ============================================================================
// EN SYNTAX PARSER
// Format: Subject do: action needs: input1, input2 yields: output1, output2
// Lines starting with # are comments. Blank lines are ignored.
// Subsystem blocks: [Subsystem Name] ... lines ... (optional grouping)
// ============================================================================

export interface ENAction {
  subject: string;
  action: string;
  needs: string[];
  yields: string[];
  subsystem?: string;
}

export function parseEN(source: string): ENAction[] {
  const actions: ENAction[] = [];
  let currentSubsystem: string | undefined;

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Subsystem header: [Name]
    const subMatch = line.match(/^\[(.+)\]$/);
    if (subMatch) {
      currentSubsystem = subMatch[1].trim();
      continue;
    }

    // Parse: Subject do: action needs: x, y yields: a, b
    const doIdx = line.indexOf(" do:");
    if (doIdx === -1) continue;

    const subject = line.slice(0, doIdx).trim();
    const rest = line.slice(doIdx + 4).trim();

    let action = rest;
    let needsStr = "";
    let yieldsStr = "";

    const needsIdx = rest.indexOf("needs:");
    const yieldsIdx = rest.indexOf("yields:");

    if (needsIdx !== -1 && yieldsIdx !== -1) {
      action = rest.slice(0, needsIdx).trim();
      needsStr = rest.slice(needsIdx + 6, yieldsIdx).trim();
      yieldsStr = rest.slice(yieldsIdx + 7).trim();
    } else if (needsIdx !== -1) {
      action = rest.slice(0, needsIdx).trim();
      needsStr = rest.slice(needsIdx + 6).trim();
    } else if (yieldsIdx !== -1) {
      action = rest.slice(0, yieldsIdx).trim();
      yieldsStr = rest.slice(yieldsIdx + 7).trim();
    }

    const needs = needsStr ? needsStr.split(",").map(s => s.trim()).filter(Boolean) : [];
    const yields = yieldsStr ? yieldsStr.split(",").map(s => s.trim()).filter(Boolean) : [];

    actions.push({ subject, action, needs, yields, subsystem: currentSubsystem });
  }

  return actions;
}

// ============================================================================
// GRAPH CONSTRUCTION from EN actions
// ============================================================================

export interface StructuralNode {
  id: string;
  type: "action" | "entity";
  label: string;
  subject?: string;
  subsystem?: string;
}

export interface StructuralGraph {
  graph: Graph;
  actions: ENAction[];
  nodeMap: Map<string, StructuralNode>;
}

function entityId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_");
}

export function buildGraph(actions: ENAction[]): StructuralGraph {
  const graph = new Graph({ type: "directed", multi: false });
  const nodeMap = new Map<string, StructuralNode>();

  for (const act of actions) {
    const actionId = entityId(act.subject);

    if (!graph.hasNode(actionId)) {
      const node: StructuralNode = {
        id: actionId,
        type: "action",
        label: act.subject,
        subject: act.subject,
        subsystem: act.subsystem,
      };
      graph.addNode(actionId, { ...node });
      nodeMap.set(actionId, node);
    }

    // needs -> action edges (entity feeds into this action)
    for (const need of act.needs) {
      const nid = entityId(need);
      if (!graph.hasNode(nid)) {
        const node: StructuralNode = { id: nid, type: "entity", label: need };
        graph.addNode(nid, { ...node });
        nodeMap.set(nid, node);
      }
      if (!graph.hasDirectedEdge(nid, actionId)) {
        graph.addDirectedEdge(nid, actionId, { type: "needs" });
      }
    }

    // action -> yields edges (action produces this entity)
    for (const y of act.yields) {
      const yid = entityId(y);
      if (!graph.hasNode(yid)) {
        const node: StructuralNode = { id: yid, type: "entity", label: y };
        graph.addNode(yid, { ...node });
        nodeMap.set(yid, node);
      }
      if (!graph.hasDirectedEdge(actionId, yid)) {
        graph.addDirectedEdge(actionId, yid, { type: "yields" });
      }
    }
  }

  return { graph, actions, nodeMap };
}

// ============================================================================
// TOPOLOGY CLASSIFICATION
// ============================================================================

export type TopologyType =
  | "Pipeline"
  | "Tree"
  | "DAG"
  | "Fork-Join"
  | "Series-Parallel"
  | "Cycle"
  | "Disconnected"
  | "Single-Node"
  | "Empty";

function hasCycle(graph: Graph): boolean {
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string): boolean {
    visited.add(node);
    stack.add(node);
    for (const neighbor of graph.outNeighbors(node)) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (stack.has(neighbor)) {
        return true;
      }
    }
    stack.delete(node);
    return false;
  }

  for (const node of graph.nodes()) {
    if (!visited.has(node)) {
      if (dfs(node)) return true;
    }
  }
  return false;
}

function connectedComponents(graph: Graph): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];

  function bfs(start: string): string[] {
    const comp: string[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const node = queue.shift()!;
      comp.push(node);
      for (const n of graph.neighbors(node)) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    return comp;
  }

  for (const node of graph.nodes()) {
    if (!visited.has(node)) {
      components.push(bfs(node));
    }
  }
  return components;
}

export function classifyTopology(graph: Graph): TopologyType {
  const nodeCount = graph.order;
  const edgeCount = graph.size;

  if (nodeCount === 0) return "Empty";
  if (nodeCount === 1) return "Single-Node";

  const components = connectedComponents(graph);
  if (components.length > 1) return "Disconnected";

  if (hasCycle(graph)) return "Cycle";

  // DAG from here - check subtypes
  const sources = graph.nodes().filter(n => graph.inDegree(n) === 0);
  const sinks = graph.nodes().filter(n => graph.outDegree(n) === 0);

  // Pipeline: every node has in-degree <= 1 and out-degree <= 1
  const isPipeline = graph.nodes().every(n => graph.inDegree(n) <= 1 && graph.outDegree(n) <= 1);
  if (isPipeline) return "Pipeline";

  // Tree: edges = nodes - 1, one source
  if (edgeCount === nodeCount - 1 && sources.length === 1) return "Tree";

  // Fork-Join: has both forks (out-degree > 1) and joins (in-degree > 1)
  const hasFork = graph.nodes().some(n => graph.outDegree(n) > 1);
  const hasJoin = graph.nodes().some(n => graph.inDegree(n) > 1);
  if (hasFork && hasJoin) return "Fork-Join";

  return "DAG";
}

// ============================================================================
// NODE ROLE CLASSIFICATION
// ============================================================================

export type NodeRole = "SOURCE" | "SINK" | "HUB" | "FORK" | "JOIN" | "PIPELINE" | "CYCLE" | "ISOLATED";

export interface NodeRoleInfo {
  id: string;
  label: string;
  role: NodeRole;
  inDegree: number;
  outDegree: number;
  subsystem?: string;
}

export function classifyNodeRoles(graph: Graph, nodeMap: Map<string, StructuralNode>): NodeRoleInfo[] {
  return graph.nodes().map(id => {
    const inD = graph.inDegree(id);
    const outD = graph.outDegree(id);
    const node = nodeMap.get(id);

    let role: NodeRole;
    if (inD === 0 && outD === 0) role = "ISOLATED";
    else if (inD === 0) role = "SOURCE";
    else if (outD === 0) role = "SINK";
    else if (inD >= 2 && outD >= 2) role = "HUB";
    else if (outD >= 2) role = "FORK";
    else if (inD >= 2) role = "JOIN";
    else role = "PIPELINE";

    return {
      id,
      label: node?.label ?? id,
      role,
      inDegree: inD,
      outDegree: outD,
      subsystem: node?.subsystem,
    };
  });
}

// ============================================================================
// BRIDGE DETECTION (single points of failure)
// Uses Tarjan's bridge-finding algorithm on undirected view
// ============================================================================

export interface Bridge {
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
}

export function findBridges(graph: Graph, nodeMap: Map<string, StructuralNode>): Bridge[] {
  const bridges: Bridge[] = [];
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const visited = new Set<string>();
  let timer = 0;

  function dfs(u: string, parent: string | null) {
    visited.add(u);
    disc.set(u, timer);
    low.set(u, timer);
    timer++;

    for (const v of graph.neighbors(u)) {
      if (v === parent) continue;
      if (!visited.has(v)) {
        dfs(v, u);
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
        if (low.get(v)! > disc.get(u)!) {
          bridges.push({
            source: u,
            target: v,
            sourceLabel: nodeMap.get(u)?.label ?? u,
            targetLabel: nodeMap.get(v)?.label ?? v,
          });
        }
      } else {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  }

  for (const node of graph.nodes()) {
    if (!visited.has(node)) {
      dfs(node, null);
    }
  }

  return bridges;
}

// ============================================================================
// FULL ANALYSIS (analyze_system equivalent)
// ============================================================================

export interface AnalysisResult {
  topology: TopologyType;
  node_count: number;
  edge_count: number;
  nodes: NodeRoleInfo[];
  bridges: Bridge[];
  sources: string[];
  sinks: string[];
  hubs: string[];
  components: number;
}

export function analyzeSystem(source: string): AnalysisResult {
  const actions = parseEN(source);
  const { graph, nodeMap } = buildGraph(actions);

  const nodes = classifyNodeRoles(graph, nodeMap);
  const bridges = findBridges(graph, nodeMap);
  const topology = classifyTopology(graph);
  const components = connectedComponents(graph);

  return {
    topology,
    node_count: graph.order,
    edge_count: graph.size,
    nodes,
    bridges,
    sources: nodes.filter(n => n.role === "SOURCE").map(n => n.label),
    sinks: nodes.filter(n => n.role === "SINK").map(n => n.label),
    hubs: nodes.filter(n => n.role === "HUB").map(n => n.label),
    components: components.length,
  };
}

// ============================================================================
// DETAIL: concurrency, flow landmarks, resilience
// ============================================================================

export interface DetailResult {
  topology: TopologyType;
  critical_path: string[];
  critical_path_length: number;
  max_parallelism: number;
  depth_levels: { depth: number; nodes: string[] }[];
  bridges: Bridge[];
  bridge_implications: { bridge: Bridge; disconnected_components: number }[];
}

function topologicalSort(graph: Graph): string[] | null {
  const inDegrees = new Map<string, number>();
  for (const n of graph.nodes()) inDegrees.set(n, graph.inDegree(n));

  const queue: string[] = [];
  for (const [n, d] of inDegrees) if (d === 0) queue.push(n);

  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const neighbor of graph.outNeighbors(node)) {
      const newDeg = inDegrees.get(neighbor)! - 1;
      inDegrees.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return order.length === graph.order ? order : null; // null if cycle
}

export function detailAnalysis(source: string): DetailResult {
  const actions = parseEN(source);
  const { graph, nodeMap } = buildGraph(actions);
  const topology = classifyTopology(graph);
  const bridges = findBridges(graph, nodeMap);

  // Topological depth levels (BFS from sources)
  const depths = new Map<string, number>();
  const sources = graph.nodes().filter(n => graph.inDegree(n) === 0);
  const queue: string[] = [];

  for (const s of sources) {
    depths.set(s, 0);
    queue.push(s);
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    const d = depths.get(node)!;
    for (const neighbor of graph.outNeighbors(node)) {
      const existing = depths.get(neighbor) ?? -1;
      if (d + 1 > existing) {
        depths.set(neighbor, d + 1);
        queue.push(neighbor);
      }
    }
  }

  // Group by depth
  const depthGroups = new Map<number, string[]>();
  for (const [node, d] of depths) {
    if (!depthGroups.has(d)) depthGroups.set(d, []);
    depthGroups.get(d)!.push(nodeMap.get(node)?.label ?? node);
  }

  const depthLevels = Array.from(depthGroups.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([depth, nodes]) => ({ depth, nodes }));

  const maxParallelism = Math.max(...depthLevels.map(l => l.nodes.length), 0);

  // Critical path (longest path from any source to any sink)
  let criticalPath: string[] = [];
  const sinks = graph.nodes().filter(n => graph.outDegree(n) === 0);

  // BFS longest path via dynamic programming
  const topoOrder = topologicalSort(graph);
  if (topoOrder) {
    const dist = new Map<string, number>();
    const prev = new Map<string, string | null>();
    for (const n of topoOrder) { dist.set(n, 0); prev.set(n, null); }

    for (const n of topoOrder) {
      for (const neighbor of graph.outNeighbors(n)) {
        if (dist.get(n)! + 1 > dist.get(neighbor)!) {
          dist.set(neighbor, dist.get(n)! + 1);
          prev.set(neighbor, n);
        }
      }
    }

    // Find the node with max distance
    let maxNode = topoOrder[0];
    let maxDist = 0;
    for (const [n, d] of dist) {
      if (d > maxDist) { maxDist = d; maxNode = n; }
    }

    // Reconstruct path
    const path: string[] = [];
    let cur: string | null = maxNode;
    while (cur) {
      path.unshift(nodeMap.get(cur)?.label ?? cur);
      cur = prev.get(cur) ?? null;
    }
    criticalPath = path;
  }

  // Bridge implications: what happens if each bridge is removed
  const bridgeImplications = bridges.map(bridge => {
    const tempGraph = graph.copy();
    // Remove the bridge edge(s)
    const edgesToRemove = tempGraph.edges().filter(e => {
      const s = tempGraph.source(e);
      const t = tempGraph.target(e);
      return (s === bridge.source && t === bridge.target) ||
             (s === bridge.target && t === bridge.source);
    });
    for (const e of edgesToRemove) {
      if (tempGraph.hasEdge(e)) tempGraph.dropEdge(e);
    }
    return {
      bridge,
      disconnected_components: connectedComponents(tempGraph).length,
    };
  });

  return {
    topology,
    critical_path: criticalPath,
    critical_path_length: criticalPath.length,
    max_parallelism: maxParallelism,
    depth_levels: depthLevels,
    bridges,
    bridge_implications: bridgeImplications,
  };
}

// ============================================================================
// BETWEENNESS CENTRALITY for a specific node
// ============================================================================

export interface BetweennessResult {
  node: string;
  label: string;
  centrality: number;
  all_centralities: { id: string; label: string; centrality: number }[];
}

export function computeBetweenness(source: string, targetNode: string): BetweennessResult {
  const actions = parseEN(source);
  const { graph, nodeMap } = buildGraph(actions);

  const centralities = betweennessCentrality(graph, { normalized: true });

  const nodeId = entityId(targetNode);
  const allSorted = Object.entries(centralities)
    .map(([id, c]) => ({ id, label: nodeMap.get(id)?.label ?? id, centrality: Math.round(Number(c) * 10000) / 10000 }))
    .sort((a, b) => b.centrality - a.centrality);

  return {
    node: nodeId,
    label: nodeMap.get(nodeId)?.label ?? targetNode,
    centrality: centralities[nodeId] ?? 0,
    all_centralities: allSorted,
  };
}

// ============================================================================
// SHORTEST PATH / DISTANCE
// ============================================================================

export interface DistanceResult {
  from: string;
  to: string;
  distance: number | null;
  path: { id: string; label: string; subsystem?: string }[] | null;
  subsystem_crossings: number;
}

export function computeDistance(source: string, fromNode: string, toNode: string): DistanceResult {
  const actions = parseEN(source);
  const { graph, nodeMap } = buildGraph(actions);

  const fromId = entityId(fromNode);
  const toId = entityId(toNode);

  if (!graph.hasNode(fromId) || !graph.hasNode(toId)) {
    return { from: fromNode, to: toNode, distance: null, path: null, subsystem_crossings: 0 };
  }

  const path = bidirectional(graph, fromId, toId);

  if (!path) {
    return { from: fromNode, to: toNode, distance: null, path: null, subsystem_crossings: 0 };
  }

  const pathDetails = path.map(id => ({
    id,
    label: nodeMap.get(id)?.label ?? id,
    subsystem: nodeMap.get(id)?.subsystem,
  }));

  // Count subsystem boundary crossings
  let crossings = 0;
  for (let i = 1; i < pathDetails.length; i++) {
    const prev = pathDetails[i - 1].subsystem;
    const curr = pathDetails[i].subsystem;
    if (prev && curr && prev !== curr) crossings++;
  }

  return {
    from: fromNode,
    to: toNode,
    distance: path.length - 1,
    path: pathDetails,
    subsystem_crossings: crossings,
  };
}

// ============================================================================
// TRACE: follow directed flow from A to B
// ============================================================================

export interface TraceResult {
  from: string;
  to: string;
  directed_path: { id: string; label: string; role: NodeRole; subsystem?: string }[] | null;
  undirected_fallback: boolean;
  reverse_edges: { from: string; to: string }[];
}

export function traceFlow(source: string, fromNode: string, toNode: string): TraceResult {
  const actions = parseEN(source);
  const { graph, nodeMap } = buildGraph(actions);
  const roles = classifyNodeRoles(graph, nodeMap);
  const roleMap = new Map(roles.map(r => [r.id, r.role]));

  const fromId = entityId(fromNode);
  const toId = entityId(toNode);

  if (!graph.hasNode(fromId) || !graph.hasNode(toId)) {
    return { from: fromNode, to: toNode, directed_path: null, undirected_fallback: false, reverse_edges: [] };
  }

  // Try directed BFS first
  const directedPath = directedBFS(graph, fromId, toId);

  if (directedPath) {
    return {
      from: fromNode,
      to: toNode,
      directed_path: directedPath.map(id => ({
        id,
        label: nodeMap.get(id)?.label ?? id,
        role: roleMap.get(id) ?? "PIPELINE",
        subsystem: nodeMap.get(id)?.subsystem,
      })),
      undirected_fallback: false,
      reverse_edges: [],
    };
  }

  // Fallback to undirected
  const undirectedPath = bidirectional(graph, fromId, toId);
  if (!undirectedPath) {
    return { from: fromNode, to: toNode, directed_path: null, undirected_fallback: false, reverse_edges: [] };
  }

  // Find reverse edges
  const reverseEdges: { from: string; to: string }[] = [];
  for (let i = 0; i < undirectedPath.length - 1; i++) {
    const a = undirectedPath[i];
    const b = undirectedPath[i + 1];
    if (!graph.hasDirectedEdge(a, b) && graph.hasDirectedEdge(b, a)) {
      reverseEdges.push({
        from: nodeMap.get(a)?.label ?? a,
        to: nodeMap.get(b)?.label ?? b,
      });
    }
  }

  return {
    from: fromNode,
    to: toNode,
    directed_path: undirectedPath.map(id => ({
      id,
      label: nodeMap.get(id)?.label ?? id,
      role: roleMap.get(id) ?? "PIPELINE",
      subsystem: nodeMap.get(id)?.subsystem,
    })),
    undirected_fallback: true,
    reverse_edges: reverseEdges,
  };
}

function directedBFS(graph: Graph, from: string, to: string): string[] | null {
  const visited = new Set<string>();
  const prev = new Map<string, string | null>();
  const queue = [from];
  visited.add(from);
  prev.set(from, null);

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === to) {
      const path: string[] = [];
      let cur: string | null = to;
      while (cur !== null) {
        path.unshift(cur);
        cur = prev.get(cur) ?? null;
      }
      return path;
    }
    for (const neighbor of graph.outNeighbors(node)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        prev.set(neighbor, node);
        queue.push(neighbor);
      }
    }
  }
  return null;
}

// ============================================================================
// IMPACT / BLAST RADIUS
// ============================================================================

export interface ImpactResult {
  removed_node: string;
  removed_label: string;
  original_components: number;
  after_components: number;
  disconnected_nodes: string[];
  topology_before: TopologyType;
  topology_after: TopologyType;
}

export function computeImpact(source: string, targetNode: string): ImpactResult {
  const actions = parseEN(source);
  const { graph, nodeMap } = buildGraph(actions);

  const nodeId = entityId(targetNode);
  if (!graph.hasNode(nodeId)) {
    return {
      removed_node: nodeId,
      removed_label: targetNode,
      original_components: connectedComponents(graph).length,
      after_components: connectedComponents(graph).length,
      disconnected_nodes: [],
      topology_before: classifyTopology(graph),
      topology_after: classifyTopology(graph),
    };
  }

  const topoBefore = classifyTopology(graph);
  const compsBefore = connectedComponents(graph);

  // Remove node and all its edges
  const tempGraph = graph.copy();
  tempGraph.dropNode(nodeId);

  const topoAfter = classifyTopology(tempGraph);
  const compsAfter = connectedComponents(tempGraph);

  // Find nodes that became disconnected (in components that didn't exist before)
  // More precisely: nodes that were reachable from sources but now aren't
  const disconnected: string[] = [];
  if (compsAfter.length > compsBefore.length) {
    // Find the smallest new components (likely the disconnected fragments)
    const sortedComps = compsAfter.sort((a, b) => a.length - b.length);
    // Everything except the largest component is "disconnected"
    for (let i = 0; i < sortedComps.length - 1; i++) {
      for (const n of sortedComps[i]) {
        disconnected.push(nodeMap.get(n)?.label ?? n);
      }
    }
  }

  return {
    removed_node: nodeId,
    removed_label: nodeMap.get(nodeId)?.label ?? targetNode,
    original_components: compsBefore.length,
    after_components: compsAfter.length,
    disconnected_nodes: disconnected,
    topology_before: topoBefore,
    topology_after: topoAfter,
  };
}

// ============================================================================
// DIFF: structural comparison of two systems
// ============================================================================

export interface DiffResult {
  topology_a: TopologyType;
  topology_b: TopologyType;
  topology_changed: boolean;
  nodes_only_in_a: string[];
  nodes_only_in_b: string[];
  nodes_in_both: string[];
  role_changes: { node: string; role_a: NodeRole; role_b: NodeRole }[];
  edge_count_a: number;
  edge_count_b: number;
  bridge_count_a: number;
  bridge_count_b: number;
}

export function structuralDiff(sourceA: string, sourceB: string): DiffResult {
  const actionsA = parseEN(sourceA);
  const actionsB = parseEN(sourceB);
  const gA = buildGraph(actionsA);
  const gB = buildGraph(actionsB);

  const topoA = classifyTopology(gA.graph);
  const topoB = classifyTopology(gB.graph);

  const nodesA = new Set(gA.graph.nodes());
  const nodesB = new Set(gB.graph.nodes());

  const onlyA = [...nodesA].filter(n => !nodesB.has(n)).map(n => gA.nodeMap.get(n)?.label ?? n);
  const onlyB = [...nodesB].filter(n => !nodesA.has(n)).map(n => gB.nodeMap.get(n)?.label ?? n);
  const both = [...nodesA].filter(n => nodesB.has(n));

  const rolesA = classifyNodeRoles(gA.graph, gA.nodeMap);
  const rolesB = classifyNodeRoles(gB.graph, gB.nodeMap);
  const roleMapA = new Map(rolesA.map(r => [r.id, r.role]));
  const roleMapB = new Map(rolesB.map(r => [r.id, r.role]));

  const roleChanges = both
    .filter(n => roleMapA.get(n) !== roleMapB.get(n))
    .map(n => ({
      node: gA.nodeMap.get(n)?.label ?? n,
      role_a: roleMapA.get(n)!,
      role_b: roleMapB.get(n)!,
    }));

  const bridgesA = findBridges(gA.graph, gA.nodeMap);
  const bridgesB = findBridges(gB.graph, gB.nodeMap);

  return {
    topology_a: topoA,
    topology_b: topoB,
    topology_changed: topoA !== topoB,
    nodes_only_in_a: onlyA,
    nodes_only_in_b: onlyB,
    nodes_in_both: both.map(n => gA.nodeMap.get(n)?.label ?? n),
    role_changes: roleChanges,
    edge_count_a: gA.graph.size,
    edge_count_b: gB.graph.size,
    bridge_count_a: bridgesA.length,
    bridge_count_b: bridgesB.length,
  };
}

// ============================================================================
// EVOLVE: dry-run architectural changes
// ============================================================================

export interface EvolveResult {
  diff: DiffResult;
  new_bridges: Bridge[];
  eliminated_bridges: Bridge[];
}

export function evolveSystem(source: string, patch: string): EvolveResult {
  const actionsOrig = parseEN(source);
  const actionsPatch = parseEN(patch);

  // Merge: patch actions with same subject replace originals
  const merged = new Map<string, ENAction>();
  for (const a of actionsOrig) merged.set(entityId(a.subject), a);
  for (const a of actionsPatch) merged.set(entityId(a.subject), a);

  const mergedSource = [...merged.values()]
    .map(a => {
      let line = `${a.subject} do: ${a.action}`;
      if (a.needs.length) line += ` needs: ${a.needs.join(", ")}`;
      if (a.yields.length) line += ` yields: ${a.yields.join(", ")}`;
      return line;
    })
    .join("\n");

  const diff = structuralDiff(source, mergedSource);

  const origBridges = findBridges(buildGraph(actionsOrig).graph, buildGraph(actionsOrig).nodeMap);
  const mergedGraph = buildGraph([...merged.values()]);
  const newBridges = findBridges(mergedGraph.graph, mergedGraph.nodeMap);

  const origBridgeKeys = new Set(origBridges.map(b => `${b.source}->${b.target}`));
  const newBridgeKeys = new Set(newBridges.map(b => `${b.source}->${b.target}`));

  return {
    diff,
    new_bridges: newBridges.filter(b => !origBridgeKeys.has(`${b.source}->${b.target}`)),
    eliminated_bridges: origBridges.filter(b => !newBridgeKeys.has(`${b.source}->${b.target}`)),
  };
}

// ============================================================================
// CATEGORIZE: auto-discover subsystem boundaries via Louvain
// ============================================================================

export interface CategorizeResult {
  subsystems: { name: string; members: string[] }[];
  modularity: number;
}

export function categorizeSystem(source: string): CategorizeResult {
  const actions = parseEN(source);
  const { graph, nodeMap } = buildGraph(actions);

  if (graph.order < 2) {
    return { subsystems: [{ name: "System", members: graph.nodes().map(n => nodeMap.get(n)?.label ?? n) }], modularity: 0 };
  }

  // Louvain needs an undirected graph
  const undirected = new Graph({ type: "undirected" });
  graph.forEachNode((node, attrs) => undirected.addNode(node, attrs));
  graph.forEachEdge((_edge, _attrs, source, target) => {
    if (!undirected.hasEdge(source, target)) {
      undirected.addEdge(source, target);
    }
  });

  try {
    const communities = louvain(undirected, { resolution: 1.0 });

    // Group nodes by community
    const groups = new Map<number, string[]>();
    for (const [node, community] of Object.entries(communities)) {
      const comm = community as number;
      if (!groups.has(comm)) groups.set(comm, []);
      groups.get(comm)!.push(nodeMap.get(node)?.label ?? node);
    }

    // Name subsystems by their most connected node
    const subsystems = Array.from(groups.entries()).map(([id, members]) => ({
      name: `Subsystem-${id}`,
      members,
    }));

    // Compute modularity (approximate)
    const m = undirected.size || 1;
    let Q = 0;
    undirected.forEachEdge((_edge, _attrs, source, target) => {
      if (communities[source] === communities[target]) {
        const ki = undirected.degree(source);
        const kj = undirected.degree(target);
        Q += 1 - (ki * kj) / (2 * m);
      }
    });
    Q /= (2 * m);

    return { subsystems, modularity: Math.round(Q * 10000) / 10000 };
  } catch (e: any) {
    log.warn({ msg: "louvain_failed", error: e.message });
    return { subsystems: [{ name: "System", members: graph.nodes().map(n => nodeMap.get(n)?.label ?? n) }], modularity: 0 };
  }
}

// ============================================================================
// EXTRACT: pull out a subsystem as standalone EN source
// ============================================================================

export interface ExtractResult {
  subsystem: string;
  source: string;
  boundary_inputs: string[];
  boundary_outputs: string[];
  internal_entities: string[];
}

export function extractSubsystem(source: string, subsystemName: string): ExtractResult {
  const actions = parseEN(source);
  const { graph, nodeMap } = buildGraph(actions);

  // Run categorize to find subsystems
  const { subsystems } = categorizeSystem(source);
  const target = subsystems.find(s =>
    s.name.toLowerCase() === subsystemName.toLowerCase() ||
    s.members.some(m => m.toLowerCase().includes(subsystemName.toLowerCase()))
  );

  if (!target) {
    return { subsystem: subsystemName, source: "", boundary_inputs: [], boundary_outputs: [], internal_entities: [] };
  }

  const memberIds = new Set(target.members.map(m => entityId(m)));

  // Find actions in this subsystem
  const subActions = actions.filter(a => memberIds.has(entityId(a.subject)));

  // Find boundary inputs/outputs
  const allNeeds = new Set(subActions.flatMap(a => a.needs.map(n => entityId(n))));
  const allYields = new Set(subActions.flatMap(a => a.yields.map(y => entityId(y))));

  const boundaryInputs = [...allNeeds].filter(n => !memberIds.has(n) && !allYields.has(n))
    .map(n => nodeMap.get(n)?.label ?? n);
  const boundaryOutputs = [...allYields].filter(y => !memberIds.has(y) && !allNeeds.has(y))
    .map(y => nodeMap.get(y)?.label ?? y);
  const internalEntities = [...allNeeds, ...allYields].filter(e => !boundaryInputs.includes(nodeMap.get(e)?.label ?? e) && !boundaryOutputs.includes(nodeMap.get(e)?.label ?? e))
    .map(e => nodeMap.get(e)?.label ?? e);

  // Rebuild EN source for subsystem
  const subSource = subActions
    .map(a => {
      let line = `${a.subject} do: ${a.action}`;
      if (a.needs.length) line += ` needs: ${a.needs.join(", ")}`;
      if (a.yields.length) line += ` yields: ${a.yields.join(", ")}`;
      return line;
    })
    .join("\n");

  return {
    subsystem: target.name,
    source: subSource,
    boundary_inputs: boundaryInputs,
    boundary_outputs: boundaryOutputs,
    internal_entities: [...new Set(internalEntities)],
  };
}

// ============================================================================
// COMPOSE: merge two EN graphs with entity linking
// ============================================================================

export interface ComposeResult {
  merged_source: string;
  node_count: number;
  edge_count: number;
  linked_entities: string[];
}

export function composeSystems(sourceA: string, sourceB: string, linksStr: string): ComposeResult {
  // Parse links: "a.node1=b.node2, a.node3=b.node4"
  const links = new Map<string, string>();
  if (linksStr.trim()) {
    for (const pair of linksStr.split(",")) {
      const [left, right] = pair.split("=").map(s => s.trim());
      if (left && right) {
        // Strip a. / b. prefix
        const leftName = left.replace(/^[ab]\./, "");
        const rightName = right.replace(/^[ab]\./, "");
        links.set(rightName.toLowerCase(), leftName);
      }
    }
  }

  const actionsA = parseEN(sourceA);
  const actionsB = parseEN(sourceB);

  // Rename linked entities in B to A's names
  const renamedB = actionsB.map(a => ({
    ...a,
    subject: links.get(a.subject.toLowerCase()) ?? a.subject,
    needs: a.needs.map(n => links.get(n.toLowerCase()) ?? n),
    yields: a.yields.map(y => links.get(y.toLowerCase()) ?? y),
  }));

  const allActions = [...actionsA, ...renamedB];
  const mergedSource = allActions
    .map(a => {
      let line = `${a.subject} do: ${a.action}`;
      if (a.needs.length) line += ` needs: ${a.needs.join(", ")}`;
      if (a.yields.length) line += ` yields: ${a.yields.join(", ")}`;
      return line;
    })
    .join("\n");

  const { graph } = buildGraph(allActions);

  return {
    merged_source: mergedSource,
    node_count: graph.order,
    edge_count: graph.size,
    linked_entities: [...links.values()],
  };
}

// ============================================================================
// ANALYZE ENGRAM MEMORIES as a structural graph
// Build a dependency graph from Engram's own memory_links and run analysis
// ============================================================================

export function analyzeMemoryGraph(
  memories: { id: number; content: string; category: string; source?: string }[],
  links: { source_id: number; target_id: number; type: string; similarity: number }[]
): AnalysisResult {
  const graph = new Graph({ type: "directed", multi: false });
  const nodeMap = new Map<string, StructuralNode>();

  for (const mem of memories) {
    const id = `m${mem.id}`;
    if (!graph.hasNode(id)) {
      const node: StructuralNode = {
        id,
        type: "action",
        label: mem.content.slice(0, 60),
        subject: mem.category,
      };
      graph.addNode(id, { ...node });
      nodeMap.set(id, node);
    }
  }

  for (const link of links) {
    const sid = `m${link.source_id}`;
    const tid = `m${link.target_id}`;
    if (graph.hasNode(sid) && graph.hasNode(tid) && !graph.hasDirectedEdge(sid, tid)) {
      graph.addDirectedEdge(sid, tid, { type: link.type, weight: link.similarity });
    }
  }

  const nodes = classifyNodeRoles(graph, nodeMap);
  const bridges = findBridges(graph, nodeMap);
  const topology = classifyTopology(graph);
  const components = connectedComponents(graph);

  return {
    topology,
    node_count: graph.order,
    edge_count: graph.size,
    nodes,
    bridges,
    sources: nodes.filter(n => n.role === "SOURCE").map(n => n.label),
    sinks: nodes.filter(n => n.role === "SINK").map(n => n.label),
    hubs: nodes.filter(n => n.role === "HUB").map(n => n.label),
    components: components.length,
  };
}
