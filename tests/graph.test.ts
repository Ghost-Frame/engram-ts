import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VALID_ENTITY_TYPES, CHUNK_SIZE } from "../src/graph/types.ts";
import type { EntityType, GNode, GEdge, GraphResult, GraphBuildOptions } from "../src/graph/types.ts";
import { registerGraphRoutes } from "../src/graph/routes.ts";
import { buildGraphData } from "../src/graph/builder.ts";
import {
  insertEntity,
  getEntity,
  getEntityForUser,
  listEntities,
  listEntitiesByType,
  searchEntities,
  updateEntity,
  deleteEntity,
  linkMemoryEntity,
  unlinkMemoryEntity,
  getEntityMemories,
  getEntityRelationships,
  insertEntityRelationship,
  deleteEntityRelationship,
  getAllMemoriesForGraph,
  getAllLinksForGraph,
  getEntityMemoryIds,
} from "../src/graph/db.ts";

// ============================================================================
// VALID_ENTITY_TYPES constant
// ============================================================================

describe("VALID_ENTITY_TYPES", () => {
  it("exports exactly 7 entity types", () => {
    assert.strictEqual(VALID_ENTITY_TYPES.length, 7);
  });

  it("contains all expected types", () => {
    assert.deepStrictEqual(
      [...VALID_ENTITY_TYPES].sort(),
      ["device", "generic", "organization", "person", "product", "service", "team"],
    );
  });

  it("has person as the first entry", () => {
    assert.strictEqual(VALID_ENTITY_TYPES[0], "person");
  });
});

// ============================================================================
// CHUNK_SIZE constant
// ============================================================================

describe("CHUNK_SIZE", () => {
  it("equals 900 (under SQLite 999 bind limit)", () => {
    assert.strictEqual(CHUNK_SIZE, 900);
  });
});

// ============================================================================
// Type-level checks (compile-time verification via assignment)
// ============================================================================

describe("EntityType type", () => {
  it("accepts valid entity type values", () => {
    const types: EntityType[] = ["person", "organization", "team", "device", "product", "service", "generic"];
    assert.strictEqual(types.length, 7);
  });
});

describe("GNode type", () => {
  it("has expected shape", () => {
    const node: GNode = { id: "m1", label: "test", type: "memory" };
    assert.strictEqual(node.id, "m1");
    assert.strictEqual(node.label, "test");
    assert.strictEqual(node.type, "memory");
  });

  it("allows extra properties via index signature", () => {
    const node: GNode = { id: "e1", label: "entity", type: "entity", group: "person", size: 8 };
    assert.strictEqual(node.group, "person");
    assert.strictEqual(node.size, 8);
  });
});

describe("GEdge type", () => {
  it("has expected shape", () => {
    const edge: GEdge = { source: "m1", target: "m2", type: "related", weight: 0.85 };
    assert.strictEqual(edge.source, "m1");
    assert.strictEqual(edge.target, "m2");
    assert.strictEqual(edge.type, "related");
    assert.strictEqual(edge.weight, 0.85);
  });
});

describe("GraphResult type", () => {
  it("has expected shape", () => {
    const result: GraphResult = { nodes: [], edges: [], links: [], node_count: 0, edge_count: 0 };
    assert.strictEqual(result.node_count, 0);
    assert.strictEqual(result.edge_count, 0);
    assert.ok(Array.isArray(result.nodes));
    assert.ok(Array.isArray(result.edges));
    assert.ok(Array.isArray(result.links));
  });
});

describe("GraphBuildOptions type", () => {
  it("has expected shape with required fields", () => {
    const opts: GraphBuildOptions = {
      depth: 2,
      maxNodes: 1000,
      includeEntities: true,
      userId: 1,
      cacheKey: "test",
    };
    assert.strictEqual(opts.depth, 2);
    assert.strictEqual(opts.maxNodes, 1000);
    assert.strictEqual(opts.includeEntities, true);
    assert.strictEqual(opts.userId, 1);
    assert.strictEqual(opts.cacheKey, "test");
  });

  it("accepts optional center and context", () => {
    const opts: GraphBuildOptions = {
      center: "42",
      depth: 2,
      maxNodes: 500,
      includeEntities: false,
      context: "search query",
      userId: 1,
      cacheKey: "test2",
    };
    assert.strictEqual(opts.center, "42");
    assert.strictEqual(opts.context, "search query");
  });
});

// ============================================================================
// Function exports
// ============================================================================

describe("registerGraphRoutes", () => {
  it("is exported as a function", () => {
    assert.strictEqual(typeof registerGraphRoutes, "function");
  });
});

describe("buildGraphData", () => {
  it("is exported as a function", () => {
    assert.strictEqual(typeof buildGraphData, "function");
  });
});

// ============================================================================
// Prepared statement exports from db.ts
// ============================================================================

describe("graph/db.ts prepared statements", () => {
  const stmts: Record<string, any> = {
    insertEntity,
    getEntity,
    getEntityForUser,
    listEntities,
    listEntitiesByType,
    searchEntities,
    updateEntity,
    deleteEntity,
    linkMemoryEntity,
    unlinkMemoryEntity,
    getEntityMemories,
    getEntityRelationships,
    insertEntityRelationship,
    deleteEntityRelationship,
    getAllMemoriesForGraph,
    getAllLinksForGraph,
    getEntityMemoryIds,
  };

  for (const [name, stmt] of Object.entries(stmts)) {
    it(name + " is a prepared statement object", () => {
      assert.ok(stmt != null, name + " should not be null/undefined");
      assert.strictEqual(typeof stmt, "object", name + " should be an object");
    });
  }

  // Statements that return rows should have .all and .get
  for (const name of [
    "insertEntity", "getEntity", "getEntityForUser", "listEntities",
    "listEntitiesByType", "searchEntities", "getEntityMemories",
    "getEntityRelationships", "getAllMemoriesForGraph", "getAllLinksForGraph",
    "getEntityMemoryIds",
  ]) {
    it(name + " has .all() method", () => {
      assert.strictEqual(typeof stmts[name].all, "function");
    });
  }

  // Statements that modify rows should have .run
  for (const name of [
    "updateEntity", "deleteEntity", "linkMemoryEntity", "unlinkMemoryEntity",
    "insertEntityRelationship", "deleteEntityRelationship",
  ]) {
    it(name + " has .run() method", () => {
      assert.strictEqual(typeof stmts[name].run, "function");
    });
  }
});
