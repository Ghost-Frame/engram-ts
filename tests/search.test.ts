import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_MODES } from "../src/search/types.ts";
import { applySearchMode, buildRecallLayers, capStaticMemories, buildExplainObject, applyTemporalSort } from "../src/search/index.ts";
import { registerSearchRoutes } from "../src/search/routes.ts";

describe("SEARCH_MODES", () => {
  it("exports all 5 mode presets", () => {
    const modes = Object.keys(SEARCH_MODES);
    assert.deepStrictEqual(modes.sort(), ["decision", "fact", "preference", "recent", "timeline"]);
  });

  it("timeline has vector_floor, limit, temporal_sort", () => {
    const t = SEARCH_MODES.timeline;
    assert.strictEqual(t.vector_floor, 0.15);
    assert.strictEqual(t.limit, 20);
    assert.strictEqual(t.temporal_sort, "desc");
  });

  it("preference has vector_floor and include_episodes", () => {
    const p = SEARCH_MODES.preference;
    assert.strictEqual(p.vector_floor, 0.10);
    assert.strictEqual(p.include_episodes, true);
  });

  it("decision has expand_relationships and include_links", () => {
    const d = SEARCH_MODES.decision;
    assert.strictEqual(d.expand_relationships, true);
    assert.strictEqual(d.include_links, true);
  });

  it("recent has temporal_sort and limit", () => {
    const r = SEARCH_MODES.recent;
    assert.strictEqual(r.temporal_sort, "desc");
    assert.strictEqual(r.limit, 15);
  });

  it("fact has no overrides (all undefined)", () => {
    const f = SEARCH_MODES.fact;
    assert.strictEqual(f.vector_floor, undefined);
    assert.strictEqual(f.limit, undefined);
    assert.strictEqual(f.temporal_sort, undefined);
  });
});

describe("applySearchMode", () => {
  it("applies timeline defaults without overwriting existing values", () => {
    const body: Record<string, any> = { limit: 5 };
    applySearchMode(body, "timeline");
    assert.strictEqual(body.limit, 5);
    assert.strictEqual(body.temporal_sort, "desc");
    assert.strictEqual(body.vector_floor, 0.15);
  });

  it("does nothing for unknown mode", () => {
    const body: Record<string, any> = {};
    applySearchMode(body, "nonexistent");
    assert.deepStrictEqual(body, {});
  });

  it("does nothing for undefined mode", () => {
    const body: Record<string, any> = {};
    applySearchMode(body, undefined);
    assert.deepStrictEqual(body, {});
  });
});

describe("capStaticMemories", () => {
  it("caps to 25% of limit", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const result = capStaticMemories(items, 20);
    assert.strictEqual(result.length, 5);
  });

  it("returns all if under cap", () => {
    const items = [{ id: 1 }, { id: 2 }];
    const result = capStaticMemories(items, 20);
    assert.strictEqual(result.length, 2);
  });

  it("always allows at least 1", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = capStaticMemories(items, 1);
    assert.strictEqual(result.length, 1);
  });
});

describe("buildRecallLayers", () => {
  it("is exported as a function", () => {
    assert.strictEqual(typeof buildRecallLayers, "function");
  });

  it("deduplicates by id across layers", () => {
    const { sorted } = buildRecallLayers({
      staticFacts: [{ id: 1, source: "a" }],
      semanticResults: [{ id: 1, score: 0.9, importance: 5 }],
      importantResults: [],
      recentResults: [],
      limit: 10,
      getMemoryWithoutEmbedding: () => null,
    });
    assert.strictEqual(sorted.length, 1);
    assert.strictEqual(sorted[0].source, "static");
  });

  it("caps static facts to 25% of limit", () => {
    const statics = Array.from({ length: 20 }, (_, i) => ({ id: i, source: "a" }));
    const { sorted, breakdown } = buildRecallLayers({
      staticFacts: statics,
      semanticResults: [],
      importantResults: [],
      recentResults: [],
      limit: 20,
      getMemoryWithoutEmbedding: () => null,
    });
    assert.ok(breakdown.static <= 5, "static should be capped to 25% of limit (5)");
  });

  it("returns correct breakdown", () => {
    const { breakdown } = buildRecallLayers({
      staticFacts: [{ id: 1, source: "a" }],
      semanticResults: [{ id: 2, score: 0.8, importance: 5 }],
      importantResults: [{ id: 3, importance: 7 }],
      recentResults: [{ id: 4 }],
      limit: 10,
      getMemoryWithoutEmbedding: () => null,
    });
    assert.strictEqual(breakdown.static, 1);
    assert.strictEqual(breakdown.semantic, 1);
    assert.strictEqual(breakdown.important, 1);
    assert.strictEqual(breakdown.recent, 1);
  });
});

describe("buildExplainObject", () => {
  it("strips internal fields", () => {
    const { result, explain } = buildExplainObject({
      id: 1,
      content: "test",
      score: 0.8,
      semantic_score: 0.75,
      _channels: ["ch1"],
      _pagerank_score: 0.6,
      fts_score: 0.5,
      graph_score: 0.3,
      temporal_boost: 1.2,
      importance: 9,
    });
    assert.strictEqual(result._channels, undefined);
    assert.strictEqual(result._pagerank_score, undefined);
    assert.strictEqual(result.fts_score, undefined);
    assert.strictEqual(explain.vector, 0.75);
    assert.strictEqual(explain.fts, 0.5);
    assert.ok(explain.reasons.includes("high importance"));
  });
});

describe("applyTemporalSort", () => {
  it("sorts ascending by created_at", () => {
    const results = [
      { id: 1, created_at: "2025-01-03" },
      { id: 2, created_at: "2025-01-01" },
      { id: 3, created_at: "2025-01-02" },
    ];
    applyTemporalSort(results, "asc");
    assert.strictEqual(results[0].id, 2);
    assert.strictEqual(results[1].id, 3);
    assert.strictEqual(results[2].id, 1);
  });

  it("sorts descending by created_at", () => {
    const results = [
      { id: 1, created_at: "2025-01-01" },
      { id: 2, created_at: "2025-01-03" },
    ];
    applyTemporalSort(results, "desc");
    assert.strictEqual(results[0].id, 2);
  });
});

describe("registerSearchRoutes", () => {
  it("is exported as a function", () => {
    assert.strictEqual(typeof registerSearchRoutes, "function");
  });
});
