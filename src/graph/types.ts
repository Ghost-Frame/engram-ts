// ============================================================================
// GRAPH DOMAIN - Type definitions, constants
// ============================================================================

/** Graph node (memory, entity, or project) */
export type GNode = {
  id: string;
  label: string;
  type: string;
  [k: string]: any;
};

/** Graph edge (link between nodes) */
export type GEdge = {
  source: string;
  target: string;
  type: string;
  weight: number;
};

/** Result envelope returned by the graph builder */
export interface GraphResult {
  nodes: GNode[];
  edges: GEdge[];
  links: GEdge[];
  node_count: number;
  edge_count: number;
}

/** Options for building a graph */
export interface GraphBuildOptions {
  center?: string | null;
  depth: number;
  maxNodes: number;
  includeEntities: boolean;
  context?: string | null;
  userId: number;
  cacheKey: string;
}

/** Valid entity type values */
export const VALID_ENTITY_TYPES = [
  "person", "organization", "team", "device", "product", "service", "generic",
] as const;

export type EntityType = (typeof VALID_ENTITY_TYPES)[number];

/** SQLite bind-parameter chunk size (stay under the 999 limit) */
export const CHUNK_SIZE = 900;
