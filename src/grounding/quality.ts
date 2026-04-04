// ============================================================================
// TOOL QUALITY MANAGER - Track and score tool execution outcomes
// Ported from OpenSpace grounding/core/quality/manager.py
// ============================================================================

import { log } from "../config/logger.ts";
import {
  upsertToolQuality, getToolQuality, updateToolQualityMetrics,
  incrementToolLLMFlags, getDegradedTools, listToolQuality,
} from "../db/index.ts";
import { parseToolKey, type ToolQualityRecord } from "./types.ts";

const DEFAULT_DEGRADATION_THRESHOLD = 0.7;

export class ToolQualityManager {
  private degradationThreshold: number;

  constructor(threshold: number = DEFAULT_DEGRADATION_THRESHOLD) {
    this.degradationThreshold = threshold;
  }

  // --- Record execution outcome ---

  recordExecution(
    toolKey: string,
    success: boolean,
    executionTimeMs: number,
    errorMessage?: string,
  ): void {
    try {
      const { backend, server, tool_name } = parseToolKey(toolKey);

      // Ensure record exists
      upsertToolQuality.run(toolKey, backend, server, tool_name, "", 1.0);

      // Update metrics atomically
      updateToolQualityMetrics.run(
        success ? 1 : 0,  // success flag for total_successes
        success ? 1 : 0,  // success flag for total_failures (inverted in SQL)
        executionTimeMs,   // for avg calculation
        success ? 1 : 0,  // success flag for quality_score
        toolKey,
      );

      if (!success && errorMessage) {
        log.info({ msg: "tool_execution_failed", tool_key: toolKey, error: errorMessage.slice(0, 200) });
      }
    } catch (e: any) {
      log.warn({ msg: "quality_record_failed", tool_key: toolKey, error: e.message });
    }
  }

  // --- LLM-identified issues ---

  recordLLMToolIssues(toolIssues: string[]): number {
    let flagged = 0;
    for (const issue of toolIssues) {
      // Parse "tool_key -- description" format
      const sepIdx = issue.indexOf(" -- ");
      if (sepIdx === -1) continue;

      const toolKey = issue.slice(0, sepIdx).trim();
      try {
        const { backend, server, tool_name } = parseToolKey(toolKey);
        upsertToolQuality.run(toolKey, backend, server, tool_name, "", 1.0);
        incrementToolLLMFlags.run(toolKey);
        flagged++;
      } catch { /* skip malformed */ }
    }
    return flagged;
  }

  // --- Quality queries ---

  getQualityScore(toolKey: string): number {
    const row = getToolQuality.get(toolKey) as ToolQualityRecord | undefined;
    return row?.quality_score ?? 1.0;
  }

  getRecord(toolKey: string): ToolQualityRecord | null {
    return (getToolQuality.get(toolKey) as ToolQualityRecord) ?? null;
  }

  getDegradedTools(): ToolQualityRecord[] {
    return getDegradedTools.all(this.degradationThreshold) as ToolQualityRecord[];
  }

  getAllRecords(limit: number = 100): ToolQualityRecord[] {
    return listToolQuality.all(limit) as ToolQualityRecord[];
  }

  // --- Tool ranking adjustment ---

  adjustToolRanking(toolKeys: string[]): string[] {
    const scored = toolKeys.map(key => ({
      key,
      score: this.getQualityScore(key),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.key);
  }
}

// --- Singleton ---

let _manager: ToolQualityManager | null = null;

export function getToolQualityManager(threshold?: number): ToolQualityManager {
  if (!_manager) {
    _manager = new ToolQualityManager(threshold);
  }
  return _manager;
}
