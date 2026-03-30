import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ReflectionPeriod,
  Reflection,
  ReflectionResponse,
  Contradiction,
  ContradictionResolution,
  ConsolidationRow,
  TimeTravelResult,
} from "../src/intelligence/types.ts";
import { registerIntelligenceRoutes } from "../src/intelligence/routes.ts";
import { runConsolidationSweep, consolidateCluster } from "../src/intelligence/consolidation.ts";
import {
  getRecentReflection,
  insertReflection,
  listReflections,
  getPeriodMemories,
  getKnownContradictions,
  listConsolidations,
  db,
} from "../src/intelligence/db.ts";

describe("intelligence/types.ts", () => {
  it("ReflectionPeriod type is importable", () => {
    const period: ReflectionPeriod = "week";
    assert.strictEqual(period, "week");
  });

  it("ContradictionResolution type is importable", () => {
    const res: ContradictionResolution = "keep_both";
    assert.strictEqual(res, "keep_both");
  });
});

describe("intelligence/routes.ts", () => {
  it("registerIntelligenceRoutes is exported as a function", () => {
    assert.strictEqual(typeof registerIntelligenceRoutes, "function");
  });
});

describe("intelligence/consolidation.ts", () => {
  it("runConsolidationSweep is exported as a function", () => {
    assert.strictEqual(typeof runConsolidationSweep, "function");
  });

  it("consolidateCluster is exported as a function", () => {
    assert.strictEqual(typeof consolidateCluster, "function");
  });
});

describe("intelligence/db.ts", () => {
  it("getRecentReflection is a prepared statement object", () => {
    assert.ok(getRecentReflection !== null && typeof getRecentReflection === "object");
    assert.strictEqual(typeof (getRecentReflection as any).all, "function");
  });

  it("insertReflection is a prepared statement object", () => {
    assert.ok(insertReflection !== null && typeof insertReflection === "object");
    assert.strictEqual(typeof (insertReflection as any).run, "function");
  });

  it("listReflections is a prepared statement object", () => {
    assert.ok(listReflections !== null && typeof listReflections === "object");
    assert.strictEqual(typeof (listReflections as any).all, "function");
  });

  it("getPeriodMemories is a prepared statement object", () => {
    assert.ok(getPeriodMemories !== null && typeof getPeriodMemories === "object");
    assert.strictEqual(typeof (getPeriodMemories as any).all, "function");
  });

  it("getKnownContradictions is a prepared statement object", () => {
    assert.ok(getKnownContradictions !== null && typeof getKnownContradictions === "object");
    assert.strictEqual(typeof (getKnownContradictions as any).all, "function");
  });

  it("listConsolidations is a prepared statement object", () => {
    assert.ok(listConsolidations !== null && typeof listConsolidations === "object");
    assert.strictEqual(typeof (listConsolidations as any).all, "function");
  });

  it("db is exported and has a prepare method", () => {
    assert.ok(db !== null && typeof db === "object");
    assert.strictEqual(typeof db.prepare, "function");
  });
});
