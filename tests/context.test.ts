import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Type imports
import type {
  ContextOptions,
  ContextResult,
  ContextBlock,
  ContextBreakdown,
  ContextTiming,
  ContextStrategy,
  ContextMode,
  ContextDepth,
  ContextBlockSource,
  ContextLayerConfig,
} from "../src/context/types.ts";

// Value exports from types
import {
  DEFAULT_TOKEN_BUDGET,
  MAX_TOKEN_BUDGET,
  DEFAULT_MAX_MEMORY_TOKENS,
  DEFAULT_DEDUP_THRESHOLD,
  DEFAULT_MIN_RELEVANCE,
  RECENCY_BOOST_MS,
  STATIC_BUDGET_BALANCED,
  STATIC_BUDGET_PRECISION,
} from "../src/context/types.ts";

// Function exports from index
import {
  applyContextMode,
  estimateTokens,
  truncateToTokenBudget,
  cosineSimilarity,
  buildAttribution,
  assembleContextString,
  resolveLayerFlags,
  resolveSemanticCeiling,
  resolveSemanticLimit,
  resolveStaticBudgetFraction,
  assembleContext,
} from "../src/context/index.ts";

// Route export
import { registerContextRoutes } from "../src/context/routes.ts";

// ---- Constants ----

describe("context constants", () => {
  it("DEFAULT_TOKEN_BUDGET is 8000", () => {
    assert.strictEqual(DEFAULT_TOKEN_BUDGET, 8000);
  });
  it("MAX_TOKEN_BUDGET is 64000", () => {
    assert.strictEqual(MAX_TOKEN_BUDGET, 64000);
  });
  it("DEFAULT_MAX_MEMORY_TOKENS is 1500", () => {
    assert.strictEqual(DEFAULT_MAX_MEMORY_TOKENS, 1500);
  });
  it("DEFAULT_DEDUP_THRESHOLD is 0.88", () => {
    assert.strictEqual(DEFAULT_DEDUP_THRESHOLD, 0.88);
  });
  it("DEFAULT_MIN_RELEVANCE is 0.55", () => {
    assert.strictEqual(DEFAULT_MIN_RELEVANCE, 0.55);
  });
  it("RECENCY_BOOST_MS is 48h in ms", () => {
    assert.strictEqual(RECENCY_BOOST_MS, 48 * 60 * 60 * 1000);
  });
  it("STATIC_BUDGET_BALANCED is 0.3", () => {
    assert.strictEqual(STATIC_BUDGET_BALANCED, 0.3);
  });
  it("STATIC_BUDGET_PRECISION is 0.2", () => {
    assert.strictEqual(STATIC_BUDGET_PRECISION, 0.2);
  });
});

// ---- applyContextMode ----

describe("applyContextMode", () => {
  it("fast preset sets depth=1 and max_tokens=2000", () => {
    const opts: Record<string, any> = {};
    applyContextMode(opts, "fast");
    assert.strictEqual(opts.depth, 1);
    assert.strictEqual(opts.max_tokens, 2000);
  });

  it("balanced preset sets depth=2 and max_tokens=6000", () => {
    const opts: Record<string, any> = {};
    applyContextMode(opts, "balanced");
    assert.strictEqual(opts.depth, 2);
    assert.strictEqual(opts.max_tokens, 6000);
  });

  it("deep preset sets depth=3, max_tokens=16000, include_inference=true", () => {
    const opts: Record<string, any> = {};
    applyContextMode(opts, "deep");
    assert.strictEqual(opts.depth, 3);
    assert.strictEqual(opts.max_tokens, 16000);
    assert.strictEqual(opts.include_inference, true);
  });

  it("decision preset sets depth=3, max_tokens=10000, include_linked=true, include_structured_facts=true", () => {
    const opts: Record<string, any> = {};
    applyContextMode(opts, "decision");
    assert.strictEqual(opts.depth, 3);
    assert.strictEqual(opts.max_tokens, 10000);
    assert.strictEqual(opts.include_linked, true);
    assert.strictEqual(opts.include_structured_facts, true);
  });

  it("does not overwrite existing values", () => {
    const opts: Record<string, any> = { depth: 1 };
    applyContextMode(opts, "deep");
    assert.strictEqual(opts.depth, 1); // not overwritten
    assert.strictEqual(opts.max_tokens, 16000);
  });

  it("does nothing for unknown mode", () => {
    const opts: Record<string, any> = {};
    applyContextMode(opts, "nonexistent");
    assert.deepStrictEqual(opts, {});
  });

  it("does nothing for undefined mode", () => {
    const opts: Record<string, any> = {};
    applyContextMode(opts, undefined);
    assert.deepStrictEqual(opts, {});
  });
});

// ---- estimateTokens ----

describe("estimateTokens", () => {
  it("returns ceil(length/4)", () => {
    assert.strictEqual(estimateTokens("aaaa"), 1);
    assert.strictEqual(estimateTokens("aaaaa"), 2);
    assert.strictEqual(estimateTokens(""), 0);
    assert.strictEqual(estimateTokens("a".repeat(100)), 25);
  });
});

// ---- truncateToTokenBudget ----

describe("truncateToTokenBudget", () => {
  it("returns content unchanged when within budget", () => {
    const content = "Hello world.";
    assert.strictEqual(truncateToTokenBudget(content, 100), content);
  });

  it("truncates at sentence boundary when possible", () => {
    const sentence1 = "a".repeat(20) + ". ";
    const sentence2 = "b".repeat(100);
    const content = sentence1 + sentence2;
    const result = truncateToTokenBudget(content, 6); // maxChars=24
    assert.ok(result.endsWith("[truncated]"));
    assert.ok(result.startsWith("a".repeat(20) + "."));
  });

  it("falls back to hard cut when no sentence boundary found", () => {
    const content = "a".repeat(200);
    const result = truncateToTokenBudget(content, 10); // maxChars=40
    assert.ok(result.endsWith("... [truncated]"));
    assert.strictEqual(result.length, 40 + "... [truncated]".length);
  });
});

// ---- cosineSimilarity ----

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 0.0001);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 0.0001);
  });

  it("returns 0 for zero vectors", () => {
    const zero = new Float32Array([0, 0, 0]);
    const v = new Float32Array([1, 2, 3]);
    assert.strictEqual(cosineSimilarity(zero, v), 0);
    assert.strictEqual(cosineSimilarity(v, zero), 0);
  });
});

// ---- buildAttribution ----

describe("buildAttribution", () => {
  const base: ContextBlock = {
    id: 1, content: "x", category: "fact", score: 0.9,
    source: "static", tokens: 5,
  };

  it("returns empty string when no model or origin", () => {
    assert.strictEqual(buildAttribution({ ...base }), "");
    assert.strictEqual(buildAttribution({ ...base, model: null, origin: null }), "");
  });

  it("includes model when present", () => {
    assert.strictEqual(buildAttribution({ ...base, model: "gpt-4" }), " (by gpt-4)");
  });

  it("includes origin when present and not 'unknown'", () => {
    assert.strictEqual(buildAttribution({ ...base, origin: "claude" }), " (by via claude)");
  });

  it("includes both model and origin", () => {
    assert.strictEqual(buildAttribution({ ...base, model: "gpt-4", origin: "openai" }), " (by gpt-4 via openai)");
  });

  it("skips origin when it is 'unknown'", () => {
    assert.strictEqual(buildAttribution({ ...base, model: "gpt-4", origin: "unknown" }), " (by gpt-4)");
  });
});

// ---- resolveLayerFlags ----

describe("resolveLayerFlags", () => {
  it("depth=1 enables static and current_state, disables recent and deeper", () => {
    const flags = resolveLayerFlags({} as ContextOptions, 1);
    assert.strictEqual(flags.includeStatic, true);
    assert.strictEqual(flags.includeCurrentState, true);
    assert.strictEqual(flags.includeRecent, false);
    assert.strictEqual(flags.includePersonality, false);
    assert.strictEqual(flags.includeEpisodes, false);
  });

  it("depth=2 enables static, recent, personality, preferences, structured facts", () => {
    const flags = resolveLayerFlags({} as ContextOptions, 2);
    assert.strictEqual(flags.includeStatic, true);
    assert.strictEqual(flags.includeRecent, true);
    assert.strictEqual(flags.includePersonality, true);
    assert.strictEqual(flags.includePreferences, true);
    assert.strictEqual(flags.includeStructuredFacts, true);
    assert.strictEqual(flags.includeEpisodes, false);
    assert.strictEqual(flags.includeLinked, false);
  });

  it("depth=3 enables all layers (inference still requires explicit opt-in)", () => {
    const flags = resolveLayerFlags({} as ContextOptions, 3);
    assert.strictEqual(flags.includeEpisodes, true);
    assert.strictEqual(flags.includeLinked, true);
    assert.strictEqual(flags.includeWorkingMemory, true);
    // inference requires include_inference=true even at depth 3
    assert.strictEqual(flags.includeInference, false);
  });

  it("explicit include_inference=true at depth 3 enables inference", () => {
    const flags = resolveLayerFlags({ include_inference: true } as ContextOptions, 3);
    assert.strictEqual(flags.includeInference, true);
  });

  it("explicit include_static=false overrides depth", () => {
    const flags = resolveLayerFlags({ include_static: false } as ContextOptions, 3);
    assert.strictEqual(flags.includeStatic, false);
  });
});

// ---- resolveSemanticCeiling / resolveSemanticLimit ----

describe("resolveSemanticCeiling", () => {
  it("balanced returns 0.80", () => {
    assert.strictEqual(resolveSemanticCeiling("balanced"), 0.80);
  });
  it("precision returns 0.82", () => {
    assert.strictEqual(resolveSemanticCeiling("precision"), 0.82);
  });
  it("breadth returns 0.90", () => {
    assert.strictEqual(resolveSemanticCeiling("breadth"), 0.90);
  });
  it("override takes precedence", () => {
    assert.strictEqual(resolveSemanticCeiling("balanced", 0.99), 0.99);
  });
});

describe("resolveSemanticLimit", () => {
  it("balanced returns 50", () => {
    assert.strictEqual(resolveSemanticLimit("balanced"), 50);
  });
  it("precision returns 30", () => {
    assert.strictEqual(resolveSemanticLimit("precision"), 30);
  });
  it("breadth returns 80", () => {
    assert.strictEqual(resolveSemanticLimit("breadth"), 80);
  });
  it("override takes precedence", () => {
    assert.strictEqual(resolveSemanticLimit("balanced", 15), 15);
  });
});

describe("resolveStaticBudgetFraction", () => {
  it("balanced returns 0.3", () => {
    assert.strictEqual(resolveStaticBudgetFraction("balanced"), 0.3);
  });
  it("breadth returns 0.3", () => {
    assert.strictEqual(resolveStaticBudgetFraction("breadth"), 0.3);
  });
  it("precision returns 0.2", () => {
    assert.strictEqual(resolveStaticBudgetFraction("precision"), 0.2);
  });
});

// ---- assembleContextString ----

describe("assembleContextString", () => {
  it("returns empty string when no blocks and no supplementary", () => {
    const result = assembleContextString([], []);
    assert.strictEqual(result, "");
  });

  it("includes Permanent Facts section for static blocks", () => {
    const blocks: ContextBlock[] = [{
      id: 1, content: "Master is Zan", category: "identity",
      score: 90, source: "static", tokens: 4,
    }];
    const result = assembleContextString(blocks, []);
    assert.ok(result.includes("## Permanent Facts"));
    assert.ok(result.includes("Master is Zan"));
  });

  it("includes Relevant Memories section for semantic blocks", () => {
    const blocks: ContextBlock[] = [{
      id: 2, content: "loves tacos", category: "preference",
      score: 80, source: "semantic", tokens: 3,
    }];
    const result = assembleContextString(blocks, []);
    assert.ok(result.includes("## Relevant Memories"));
    assert.ok(result.includes("[preference] loves tacos"));
  });

  it("supplementary sections appear before memory sections", () => {
    const blocks: ContextBlock[] = [{
      id: 1, content: "fact", category: "general",
      score: 70, source: "static", tokens: 1,
    }];
    const supplementary = [{ label: "current_state", content: "## Current State\n- mood: excited" }];
    const result = assembleContextString(blocks, supplementary);
    const stateIdx = result.indexOf("## Current State");
    const factsIdx = result.indexOf("## Permanent Facts");
    assert.ok(stateIdx < factsIdx, "supplementary should appear before memory blocks");
  });

  it("includes all 7 block source sections when populated", () => {
    const sources: ContextBlockSource[] = ["static", "semantic", "evolution", "episode", "linked", "recent", "inference"];
    const blocks: ContextBlock[] = sources.map((source, i) => ({
      id: i + 1, content: `content-${source}`, category: "general",
      score: 50, source, tokens: 3,
    }));
    const result = assembleContextString(blocks, []);
    assert.ok(result.includes("## Permanent Facts"));
    assert.ok(result.includes("## Relevant Memories"));
    assert.ok(result.includes("## Preference/Fact Evolution"));
    assert.ok(result.includes("## Episode Context"));
    assert.ok(result.includes("## Related Context"));
    assert.ok(result.includes("## Recent Activity"));
    assert.ok(result.includes("## Implicit Connections"));
  });
});

// ---- registerContextRoutes export ----

describe("registerContextRoutes", () => {
  it("is a function", () => {
    assert.strictEqual(typeof registerContextRoutes, "function");
  });
});

// ---- assembleContext -- pure function integration test (no DB) ----

describe("assembleContext", () => {
  /** Build a minimal stub ContextDeps */
  function makeDeps(overrides: Partial<import("../src/context/index.ts").ContextDeps> = {}): import("../src/context/index.ts").ContextDeps {
    return {
      embed: async () => null,
      hybridSearch: async () => [],
      isRerankerReady: () => false,
      getCachedEmbeddings: () => [],
      getStaticMemories: () => [],
      getMemoryWithoutEmbedding: () => null,
      getVersionChain: () => [],
      getEpisode: () => null,
      getLinks: () => [],
      getRecentDynamic: () => [],
      isLLMAvailable: () => false,
      listScratchEntriesForContext: () => [],
      buildWorkingMemoryBlock: () => null,
      getCurrentState: () => [],
      getProfileForInjection: () => null,
      queueResynthesisIfStale: () => {},
      getUserPreferences: () => [],
      getStructuredFacts: () => [],
      trackAccess: () => {},
      ...overrides,
    };
  }

  it("returns a ContextResult with all required fields", async () => {
    const result = await assembleContext({ query: "test" }, 1, makeDeps());
    assert.ok(typeof result.context === "string");
    assert.ok(Array.isArray(result.blocks));
    assert.ok(typeof result.token_estimate === "number");
    assert.ok(typeof result.token_budget === "number");
    assert.ok(typeof result.utilization === "number");
    assert.ok(typeof result.strategy === "string");
    assert.ok(result.breakdown);
    assert.ok(result.timing);
  });

  it("caps token_budget at MAX_TOKEN_BUDGET", async () => {
    const result = await assembleContext({ query: "test", max_tokens: 999999 }, 1, makeDeps());
    assert.strictEqual(result.token_budget, MAX_TOKEN_BUDGET);
  });

  it("uses DEFAULT_TOKEN_BUDGET when no budget specified", async () => {
    const result = await assembleContext({ query: "test" }, 1, makeDeps());
    assert.strictEqual(result.token_budget, DEFAULT_TOKEN_BUDGET);
  });

  it("strategy defaults to balanced", async () => {
    const result = await assembleContext({ query: "test" }, 1, makeDeps());
    assert.strictEqual(result.strategy, "balanced");
  });

  it("includes static blocks from deps.getStaticMemories", async () => {
    const deps = makeDeps({
      getStaticMemories: () => [{
        id: 42, content: "I am static", category: "fact",
        source_count: 1, model: null, source: null,
      }],
    });
    const result = await assembleContext({ query: "test" }, 1, deps);
    assert.ok(result.context.includes("I am static"));
    assert.strictEqual(result.breakdown.static, 1);
  });

  it("deduplicates blocks by id via seenIds", async () => {
    // Return the same item from both static and semantic
    const deps = makeDeps({
      getStaticMemories: () => [{
        id: 7, content: "deduplicated content here", category: "fact",
        source_count: 1, model: null, source: null,
      }],
      hybridSearch: async () => [{
        id: 7, content: "deduplicated content here", category: "fact",
        semantic_score: 0.9, combined_score: 0.9,
        model: null, source: null, created_at: null,
      }],
    });
    const result = await assembleContext({ query: "test" }, 1, deps);
    const blocksWith7 = result.blocks.filter(b => b.id === 7);
    assert.strictEqual(blocksWith7.length, 1);
  });

  it("applies fast mode preset (depth=1, max_tokens=2000)", async () => {
    const result = await assembleContext({ query: "test", mode: "fast" }, 1, makeDeps());
    assert.strictEqual(result.token_budget, 2000);
  });

  it("applies decision mode preset (include_linked forced true at depth 3)", async () => {
    // At depth 3, linked layer is enabled. With no semantic results, linked won't fire,
    // but we can verify token_budget was set from the preset.
    const result = await assembleContext({ query: "test", mode: "decision" }, 1, makeDeps());
    assert.strictEqual(result.token_budget, 10000);
  });

  it("timing object has total_ms", async () => {
    const result = await assembleContext({ query: "test" }, 1, makeDeps());
    assert.ok(typeof result.timing.total_ms === "number");
    assert.ok(result.timing.total_ms >= 0);
  });
});
