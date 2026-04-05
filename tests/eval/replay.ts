#!/usr/bin/env npx tsx
// ============================================================================
// EVAL REPLAY - Replay golden dataset through local model, score responses
// Usage: npx tsx tests/eval/replay.ts [--threshold 0.8] [--limit 100] [--site filter]
// ============================================================================

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { callLocalModel, isLocalModelAvailable } from "../../src/llm/local.ts";
import { scoreResponse } from "./scoring.ts";
import type { GoldenEntry } from "./collect.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(__dirname, "../../data/eval-golden.jsonl");

interface SiteStats {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  avgJson: number;
  avgSemantic: number;
  avgKeyword: number;
}

function parseArgs(): { threshold: number; limit: number; siteFilter: string | null } {
  const args = process.argv.slice(2);
  let threshold = 0.8;
  let limit = 0;
  let siteFilter: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threshold" && args[i + 1]) threshold = parseFloat(args[++i]);
    if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
    if (args[i] === "--site" && args[i + 1]) siteFilter = args[++i];
  }

  return { threshold, limit, siteFilter };
}

async function main(): Promise<void> {
  const { threshold, limit, siteFilter } = parseArgs();

  if (!existsSync(GOLDEN_PATH)) {
    console.error(`Golden dataset not found: ${GOLDEN_PATH}`);
    console.error("Run with ENGRAM_EVAL_COLLECT=1 to collect golden data first.");
    process.exit(1);
  }

  const raw = readFileSync(GOLDEN_PATH, "utf-8").trim();
  if (!raw) {
    console.error("Golden dataset is empty.");
    process.exit(1);
  }

  let entries: GoldenEntry[] = raw.split("\n").map((line, i) => {
    try { return JSON.parse(line); }
    catch { console.warn(`Skipping malformed line ${i + 1}`); return null; }
  }).filter(Boolean);

  if (siteFilter) {
    entries = entries.filter(e => e.call_site.includes(siteFilter));
  }

  entries = entries.filter(e => !e.error && e.response);

  if (entries.length === 0) {
    console.error("No valid entries to replay.");
    process.exit(1);
  }

  if (limit > 0 && entries.length > limit) {
    entries = entries.slice(0, limit);
  }

  if (!isLocalModelAvailable()) {
    console.error("Local model not available. Start Ollama first.");
    process.exit(1);
  }

  console.log(`Replaying ${entries.length} entries...`);
  console.log(`Threshold: ${(threshold * 100).toFixed(0)}% pass rate per site\n`);

  const siteStats = new Map<string, SiteStats>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const site = entry.call_site;

    if (!siteStats.has(site)) {
      siteStats.set(site, { total: 0, passed: 0, failed: 0, errors: 0, avgJson: 0, avgSemantic: 0, avgKeyword: 0 });
    }
    const stats = siteStats.get(site)!;
    stats.total++;

    try {
      const candidate = await callLocalModel(
        entry.system_prompt,
        entry.user_prompt,
        { priority: "background" }
      );

      const score = await scoreResponse(entry.response, candidate);

      if (score.pass) {
        stats.passed++;
      } else {
        stats.failed++;
      }

      stats.avgJson += score.jsonMatch;
      stats.avgSemantic += score.semantic ?? 0;
      stats.avgKeyword += score.keywordRecall;

      const status = score.pass ? "PASS" : "FAIL";
      const pct = ((i + 1) / entries.length * 100).toFixed(0);
      process.stdout.write(`\r[${pct}%] ${i + 1}/${entries.length} -- ${site} ${status}  `);

    } catch (e: any) {
      stats.errors++;
      process.stdout.write(`\r[${((i + 1) / entries.length * 100).toFixed(0)}%] ${i + 1}/${entries.length} -- ${site} ERROR  `);
    }
  }

  console.log("\n");

  console.log("=".repeat(80));
  console.log("EVALUATION REPORT");
  console.log("=".repeat(80));

  let allPassed = true;
  const sites = [...siteStats.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [site, stats] of sites) {
    const passRate = stats.total > 0 ? stats.passed / stats.total : 0;
    const sitePassed = passRate >= threshold;
    if (!sitePassed) allPassed = false;

    const avgJson = stats.total > 0 ? stats.avgJson / stats.total : 0;
    const avgSemantic = stats.total > 0 ? stats.avgSemantic / stats.total : 0;
    const avgKeyword = stats.total > 0 ? stats.avgKeyword / stats.total : 0;

    const icon = sitePassed ? "PASS" : "FAIL";
    console.log(`\n[${icon}] ${site}`);
    console.log(`  Samples: ${stats.total} | Passed: ${stats.passed} | Failed: ${stats.failed} | Errors: ${stats.errors}`);
    console.log(`  Pass rate: ${(passRate * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(0)}%)`);
    console.log(`  Avg JSON match: ${avgJson.toFixed(3)} | Avg semantic: ${avgSemantic.toFixed(3)} | Avg keyword: ${avgKeyword.toFixed(3)}`);
  }

  console.log("\n" + "=".repeat(80));
  const totalEntries = [...siteStats.values()].reduce((s, v) => s + v.total, 0);
  const totalPassed = [...siteStats.values()].reduce((s, v) => s + v.passed, 0);
  console.log(`OVERALL: ${totalPassed}/${totalEntries} passed (${(totalPassed / totalEntries * 100).toFixed(1)}%)`);
  console.log(`SITES: ${sites.filter(([, s]) => s.total > 0 && s.passed / s.total >= threshold).length}/${sites.length} passed threshold`);
  console.log(`VERDICT: ${allPassed ? "ALL SITES PASS" : "SOME SITES BELOW THRESHOLD"}`);
  console.log("=".repeat(80));

  process.exit(allPassed ? 0 : 1);
}

main().catch(e => {
  console.error("Replay failed:", e.message);
  process.exit(1);
});
