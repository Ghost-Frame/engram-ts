// ============================================================================
// EXECUTION ANALYZER - Post-execution LLM analysis of task outcomes
// Ported from OpenSpace skill_engine/analyzer.py
// ============================================================================

import { callLLM, isLLMAvailable, repairAndParseJSON } from "../llm/index.ts";
import { log } from "../config/logger.ts";
import {
  insertExecutionAnalysis, getExecutionAnalysis,
  insertSkillJudgment, incrementSkillApplied, incrementSkillCompletions,
  incrementSkillFallbacks, incrementSkillSelectionsStmt,
} from "../db/index.ts";
import { db } from "../db/connection.ts";
import { formatConversation, formatToolResults } from "./conversation-formatter.ts";
import type {
  ExecutionAnalysis, SkillJudgment, EvolutionSuggestion,
  SkillSearchResult,
} from "./types.ts";
import type { ConversationMessage } from "./conversation-formatter.ts";

// Re-export ConversationMessage from formatter for external use
export type { ConversationMessage } from "./conversation-formatter.ts";

const ANALYSIS_SYSTEM_PROMPT = `You are an execution analysis engine for a skill-based agent system. Your job is to analyze a completed task execution and assess:

1. **Task Completion**: Did the agent actually complete the task? Judge based on evidence in the conversation, not the agent's self-report.
2. **Skill Application**: For each selected skill, did the agent actually follow its instructions? Note deviations.
3. **Tool Issues**: Identify tools that malfunctioned, timed out, or produced unexpected results. Format: "tool_key -- description of issue".
4. **Evolution Suggestions**: Should any skill be improved (FIX), should a new enhanced skill be created (DERIVED), or should a novel pattern be captured (CAPTURED)?

Respond with ONLY valid JSON (no markdown, no backticks):
{
  "task_completed": true/false,
  "execution_note": "Brief observation about the execution",
  "tool_issues": ["tool_key -- description", ...],
  "skill_judgments": [
    {
      "skill_id": "exact skill_id from the selected skills list",
      "skill_applied": true/false,
      "note": "How the skill was used or why it was ignored"
    }
  ],
  "evolution_suggestions": [
    {
      "evolution_type": "fix|derived|captured",
      "target_skill_ids": ["skill_id"],
      "category": "tool_guide|workflow|reference|null",
      "direction": "What to fix/derive/capture and why"
    }
  ]
}

Rules:
- skill_judgments must include exactly one entry per selected skill
- evolution_suggestions can be empty if no improvements are needed
- tool_issues should only include genuine problems, not normal tool behavior
- For FIX: target_skill_ids has exactly 1 entry
- For DERIVED: target_skill_ids has 1+ entries (enhancement or merge)
- For CAPTURED: target_skill_ids is empty (brand new skill)`;

// --- Skill ID correction (handle LLM hallucinations) ---

function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return matrix[a.length][b.length];
}

function correctSkillId(hallucinated: string, validIds: string[]): string {
  // Exact match
  if (validIds.includes(hallucinated)) return hallucinated;

  // Edit distance <= 3
  let bestId = hallucinated;
  let bestDist = Infinity;
  for (const valid of validIds) {
    const dist = editDistance(hallucinated, valid);
    if (dist < bestDist && dist <= 3) {
      bestDist = dist;
      bestId = valid;
    }
  }

  // Name prefix match as fallback
  if (bestId === hallucinated) {
    const prefix = hallucinated.split("__")[0];
    const match = validIds.find(id => id.startsWith(prefix));
    if (match) bestId = match;
  }

  if (bestId !== hallucinated) {
    log.info({ msg: "skill_id_corrected", from: hallucinated, to: bestId });
  }
  return bestId;
}

// --- Main analyzer ---

export interface AnalyzeInput {
  task_id: string;
  task_description: string;
  conversation: ConversationMessage[];
  selected_skills: SkillSearchResult[];
  tool_results?: Array<{ tool: string; success: boolean; output: string; error?: string; duration_ms?: number }>;
  model?: string;
}

export async function analyzeExecution(input: AnalyzeInput): Promise<ExecutionAnalysis | null> {
  if (!isLLMAvailable()) {
    log.warn({ msg: "analyzer_skipped", reason: "no_llm" });
    return null;
  }

  // Check for existing analysis
  const existing = getExecutionAnalysis.get(input.task_id) as any;
  if (existing) {
    log.info({ msg: "analysis_exists", task_id: input.task_id });
    return deserializeAnalysis(existing);
  }

  // Build prompt
  const conversationText = formatConversation(input.conversation, 40000);
  const toolText = input.tool_results ? formatToolResults(input.tool_results) : "(no tool results provided)";

  const skillsSection = input.selected_skills.length > 0
    ? input.selected_skills.map(s =>
        `- skill_id: "${s.skill_id}", name: "${s.name}", score: ${s.score.toFixed(3)}`
      ).join("\n")
    : "(no skills selected)";

  const userPrompt = `## Task
${input.task_description}

## Selected Skills
${skillsSection}

## Conversation Log
${conversationText}

## Tool Execution Results
${toolText}`;

  try {
    const response = await callLLM(ANALYSIS_SYSTEM_PROMPT, userPrompt, input.model);
    const parsed = repairAndParseJSON(response);
    if (!parsed || typeof parsed !== "object") {
      log.error({ msg: "analysis_parse_failed", task_id: input.task_id });
      return null;
    }

    const raw = parsed as any;
    const validSkillIds = input.selected_skills.map(s => s.skill_id);

    // Build analysis
    const analysis: ExecutionAnalysis = {
      task_id: input.task_id,
      timestamp: new Date().toISOString(),
      task_completed: !!raw.task_completed,
      execution_note: String(raw.execution_note || ""),
      tool_issues: Array.isArray(raw.tool_issues) ? raw.tool_issues.map(String) : [],
      skill_judgments: Array.isArray(raw.skill_judgments)
        ? raw.skill_judgments.map((j: any) => ({
            skill_id: correctSkillId(String(j.skill_id || ""), validSkillIds),
            skill_applied: !!j.skill_applied,
            note: String(j.note || ""),
          }))
        : [],
      evolution_suggestions: Array.isArray(raw.evolution_suggestions)
        ? raw.evolution_suggestions.map((s: any) => ({
            evolution_type: (["fix", "derived", "captured"].includes(s.evolution_type) ? s.evolution_type : "fix") as any,
            target_skill_ids: Array.isArray(s.target_skill_ids)
              ? s.target_skill_ids.map((id: string) => correctSkillId(String(id), validSkillIds))
              : [],
            category: s.category || null,
            direction: String(s.direction || ""),
          }))
        : [],
      analyzed_by: input.model || "default",
      analyzed_at: new Date().toISOString(),
    };

    // Persist
    persistAnalysis(analysis, input.selected_skills);

    return analysis;
  } catch (e: any) {
    log.error({ msg: "analysis_failed", task_id: input.task_id, error: e.message });
    return null;
  }
}

// --- Persistence ---

function persistAnalysis(analysis: ExecutionAnalysis, selectedSkills: SkillSearchResult[]): void {
  try {
    const hasSuggestions = analysis.evolution_suggestions.length > 0;

    const result = insertExecutionAnalysis.run(
      analysis.task_id,
      analysis.timestamp,
      analysis.task_completed ? 1 : 0,
      analysis.execution_note,
      JSON.stringify(analysis.tool_issues),
      hasSuggestions ? 1 : 0,
      JSON.stringify(analysis.evolution_suggestions),
      analysis.analyzed_by,
      analysis.analyzed_at,
    );

    const analysisId = (result as any).lastInsertRowid ?? (result as any).changes;
    if (!analysisId) return;

    // Insert skill judgments
    for (const judgment of analysis.skill_judgments) {
      insertSkillJudgment.run(
        analysisId, judgment.skill_id,
        judgment.skill_applied ? 1 : 0, judgment.note,
      );

      // Update skill counters
      if (judgment.skill_applied) {
        incrementSkillApplied.run(judgment.skill_id);
      }
    }

    // Update completion/fallback counters
    for (const skill of selectedSkills) {
      if (analysis.task_completed) {
        incrementSkillCompletions.run(skill.skill_id);
      } else {
        incrementSkillFallbacks.run(skill.skill_id);
      }
    }

    log.info({
      msg: "analysis_persisted",
      task_id: analysis.task_id,
      completed: analysis.task_completed,
      judgments: analysis.skill_judgments.length,
      suggestions: analysis.evolution_suggestions.length,
    });
  } catch (e: any) {
    log.error({ msg: "analysis_persist_failed", task_id: analysis.task_id, error: e.message });
  }
}

// --- Deserialization ---

function deserializeAnalysis(row: any): ExecutionAnalysis {
  return {
    task_id: row.task_id,
    timestamp: row.timestamp,
    task_completed: !!row.task_completed,
    execution_note: row.execution_note || "",
    tool_issues: safeParseArray(row.tool_issues),
    skill_judgments: [], // Would need separate query to hydrate
    evolution_suggestions: safeParseArray(row.evolution_suggestions),
    analyzed_by: row.analyzed_by || "",
    analyzed_at: row.analyzed_at || "",
  };
}

function safeParseArray(json: string): any[] {
  try { const r = JSON.parse(json); return Array.isArray(r) ? r : []; }
  catch { return []; }
}
