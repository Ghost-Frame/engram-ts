import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  SkillMeta,
  SkillRecord,
  SkillSearchResult,
  CloudSkillCandidate,
  UploadMeta,
} from "../src/skills/types.ts";
import { registerSkillRoutes } from "../src/skills/routes.ts";

describe("SkillMeta type", () => {
  it("has required name and description fields", () => {
    const meta: SkillMeta = { name: "test-skill", description: "A test skill" };
    assert.strictEqual(meta.name, "test-skill");
    assert.strictEqual(meta.description, "A test skill");
    assert.strictEqual(meta.category, undefined);
    assert.deepStrictEqual(meta.tags, undefined);
  });

  it("accepts optional category and tags", () => {
    const meta: SkillMeta = {
      name: "full-skill",
      description: "A full skill",
      category: "workflow",
      tags: ["tag1", "tag2"],
    };
    assert.strictEqual(meta.category, "workflow");
    assert.deepStrictEqual(meta.tags, ["tag1", "tag2"]);
  });
});

describe("SkillRecord type", () => {
  it("has expected shape", () => {
    const record: SkillRecord = {
      skill_id: "abc123",
      name: "my-skill",
      description: "Does things",
      path: "/skills/my-skill",
      content: "## My Skill\n\nDoes things.",
      category: "workflow",
      origin: "imported",
      generation: 1,
      lineage_change_summary: null,
      creator_id: null,
      is_active: 1,
      total_selections: 0,
      total_applied: 0,
      total_completions: 0,
      first_seen: "2025-01-01T00:00:00.000Z",
      last_updated: "2025-01-01T00:00:00.000Z",
    };
    assert.strictEqual(record.skill_id, "abc123");
    assert.strictEqual(record.name, "my-skill");
    assert.strictEqual(record.is_active, 1);
    assert.strictEqual(record.generation, 1);
  });
});

describe("SkillSearchResult type", () => {
  it("has local source variant", () => {
    const result: SkillSearchResult = {
      skill_id: "abc123",
      name: "my-skill",
      description: "Does things",
      path: "/skills/my-skill",
      category: "workflow",
      origin: "imported",
      score: 0.95,
      source: "local",
    };
    assert.strictEqual(result.source, "local");
    assert.strictEqual(result.score, 0.95);
  });

  it("has cloud source variant", () => {
    const result: SkillSearchResult = {
      skill_id: "xyz789",
      name: "cloud-skill",
      description: "From cloud",
      path: "",
      category: "utility",
      origin: "cloud",
      score: 0.5,
      source: "cloud",
    };
    assert.strictEqual(result.source, "cloud");
    assert.strictEqual(result.path, "");
  });
});

describe("CloudSkillCandidate type", () => {
  it("has required fields", () => {
    const candidate: CloudSkillCandidate = {
      skill_id: "cloud-1",
      name: "cloud-skill",
      description: "A cloud skill",
      content: "## Cloud Skill\n\nContent here.",
      category: "workflow",
      origin: "cloud",
      tags: ["productivity", "automation"],
    };
    assert.strictEqual(candidate.skill_id, "cloud-1");
    assert.deepStrictEqual(candidate.tags, ["productivity", "automation"]);
    assert.strictEqual(candidate.embedding, undefined);
  });

  it("accepts optional embedding", () => {
    const candidate: CloudSkillCandidate = {
      skill_id: "cloud-2",
      name: "emb-skill",
      description: "With embedding",
      content: "Content",
      category: "utility",
      origin: "cloud",
      tags: [],
      embedding: [0.1, 0.2, 0.3],
    };
    assert.deepStrictEqual(candidate.embedding, [0.1, 0.2, 0.3]);
  });
});

describe("UploadMeta type", () => {
  it("has expected fields", () => {
    const meta: UploadMeta = {
      origin: "local",
      parent_skill_ids: ["parent-1"],
      tags: ["tag1"],
      created_by: "user-123",
      change_summary: "Initial upload",
    };
    assert.strictEqual(meta.origin, "local");
    assert.deepStrictEqual(meta.parent_skill_ids, ["parent-1"]);
    assert.strictEqual(meta.change_summary, "Initial upload");
  });
});

describe("registerSkillRoutes export", () => {
  it("is a function", () => {
    assert.strictEqual(typeof registerSkillRoutes, "function");
  });
});
