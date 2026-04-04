import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  BrainCommand,
  BrainContradiction,
  BrainMemory,
  BrainQueryResult,
  OracleResult,
} from "../src/services/brain/types.ts";

const BRAINS_DIR = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "../src/services/brain");

describe("brain service surface", () => {
  it("imports the shared types module", async () => {
    const mod = await import("../src/services/brain/types.ts");
    assert.equal(typeof mod, "object");
  });

  it("manager uses literal brain command identifiers", () => {
    const src = readFileSync(join(BRAINS_DIR, "manager.ts"), "utf8");
    assert.ok(src.includes('cmd: "dream_cycle"'), 'manager.ts must send cmd: "dream_cycle"');
    assert.ok(src.includes('cmd: "feedback_signal"'), 'manager.ts must send cmd: "feedback_signal"');
    assert.ok(src.includes('cmd: "evolution_train"'), 'manager.ts must send cmd: "evolution_train"');
  });

  it("oracle and manager share the brain types module", () => {
    const managerSrc = readFileSync(join(BRAINS_DIR, "manager.ts"), "utf8");
    const oracleSrc = readFileSync(join(BRAINS_DIR, "oracle.ts"), "utf8");

    assert.ok(managerSrc.includes('from "./types.ts"'));
    assert.ok(oracleSrc.includes('from "./types.ts"'));
  });

  it("accepts the shared command and result shapes", () => {
    const commands: BrainCommand[] = [
      { cmd: "init", db_path: "/tmp/brain.db", data_dir: "/tmp" },
      { cmd: "query", embedding: [0.1, 0.2], top_k: 3, beta: 0.5, spread_hops: 2 },
      {
        cmd: "absorb",
        id: 1,
        content: "brain memory",
        category: "general",
        source: "test",
        importance: 7,
        created_at: "2026-03-30T00:00:00.000Z",
        embedding: [0.3, 0.4],
        tags: ["tag"],
      },
      { cmd: "decay_tick", ticks: 1 },
      { cmd: "get_stats" },
      { cmd: "shutdown" },
      { cmd: "dream_cycle" },
      { cmd: "feedback_signal", memory_ids: [1, 2], edge_pairs: [[1, 2]], useful: true },
      { cmd: "evolution_train" },
    ];

    const activated: BrainMemory[] = [
      {
        id: 1,
        content: "brain memory",
        category: "general",
        source: "test",
        importance: 7,
        activation: 0.75,
        created_at: "2026-03-30T00:00:00.000Z",
      },
    ];

    const contradictions: BrainContradiction[] = [
      {
        winner_id: 2,
        winner_activation: 0.9,
        loser_id: 1,
        loser_activation: 0.1,
        reason: "newer memory supersedes older one",
      },
    ];

    const queryResult: BrainQueryResult = { activated, contradictions };
    const oracleResult: OracleResult = {
      answer: "ok",
      sources: [1],
      confidence: 0.75,
      contradictions,
      hallucination_flags: [],
      fallback: false,
    };

    assert.equal(commands.length, 9);
    assert.equal(queryResult.activated[0].id, 1);
    assert.equal(oracleResult.sources[0], 1);
  });
});
