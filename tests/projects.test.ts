import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VALID_PROJECT_STATUSES } from "../src/projects/types.ts";
import type { ProjectStatus, ProjectRow, CreateProjectBody, UpdateProjectBody, InsertProjectResult, ProjectMemoryRow } from "../src/projects/types.ts";
import { registerProjectRoutes } from "../src/projects/routes.ts";

describe("VALID_PROJECT_STATUSES", () => {
  it("exports exactly 4 statuses", () => {
    assert.strictEqual(VALID_PROJECT_STATUSES.length, 4);
  });

  it("contains active, paused, completed, archived", () => {
    assert.deepStrictEqual(
      [...VALID_PROJECT_STATUSES].sort(),
      ["active", "archived", "completed", "paused"],
    );
  });

  it("active is the first entry (default)", () => {
    assert.strictEqual(VALID_PROJECT_STATUSES[0], "active");
  });
});

describe("ProjectStatus type", () => {
  it("accepts valid status values", () => {
    const statuses: ProjectStatus[] = ["active", "paused", "completed", "archived"];
    assert.strictEqual(statuses.length, 4);
  });
});

describe("type exports", () => {
  it("ProjectRow has expected shape via type-level check", () => {
    const row: ProjectRow = {
      id: 1,
      name: "test",
      description: null,
      status: "active",
      metadata: null,
      user_id: 1,
      created_at: "2025-01-01",
      updated_at: null,
      memory_ids: null,
    };
    assert.strictEqual(row.id, 1);
    assert.strictEqual(row.name, "test");
  });

  it("CreateProjectBody allows partial fields", () => {
    const body: CreateProjectBody = { name: "proj" };
    assert.strictEqual(body.name, "proj");
    assert.strictEqual(body.description, undefined);
  });

  it("UpdateProjectBody allows partial fields", () => {
    const body: UpdateProjectBody = { status: "paused" };
    assert.strictEqual(body.status, "paused");
  });

  it("InsertProjectResult has id and created_at", () => {
    const result: InsertProjectResult = { id: 42, created_at: "2025-01-01" };
    assert.strictEqual(result.id, 42);
  });

  it("ProjectMemoryRow has expected fields", () => {
    const row: ProjectMemoryRow = {
      id: 1,
      content: "test",
      category: "fact",
      importance: 5,
      tags: "[]",
      created_at: "2025-01-01",
      decay_score: 0.8,
      confidence: 0.9,
    };
    assert.strictEqual(row.id, 1);
    assert.strictEqual(row.decay_score, 0.8);
  });
});

describe("registerProjectRoutes", () => {
  it("is exported as a function", () => {
    assert.strictEqual(typeof registerProjectRoutes, "function");
  });
});
