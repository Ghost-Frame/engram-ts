// ============================================================================
// SKILLS TYPES - Full OpenSpace schema (ported from Python)
// ============================================================================

// --- Enums ---

export type SkillCategory = "tool_guide" | "workflow" | "reference";
export type SkillVisibility = "private" | "public";
export type SkillOrigin = "imported" | "captured" | "derived" | "fixed";
export type EvolutionType = "fix" | "derived" | "captured";
export type EvolutionTrigger = "analysis" | "tool_degradation" | "metric_monitor";
export type PatchType = "full" | "diff" | "patch";

// --- Core Interfaces ---

export interface SkillMeta {
  name: string;
  description: string;
  category?: SkillCategory;
  tags?: string[];
}

export interface SkillLineage {
  origin: SkillOrigin;
  generation: number;
  parent_skill_ids: string[];
  source_task_id: string | null;
  change_summary: string;
  content_diff: string;
  content_snapshot: Record<string, string>;
  created_at: string;
  created_by: string;
}

export interface SkillRecord {
  skill_id: string;
  name: string;
  description: string;
  path: string;
  content: string;
  category: SkillCategory;
  origin: SkillOrigin;
  visibility: SkillVisibility;
  generation: number;
  lineage_change_summary: string | null;
  lineage_source_task_id: string | null;
  lineage_content_diff: string;
  lineage_content_snapshot: string; // JSON string of Record<string, string>
  creator_id: string | null;
  is_active: number;
  total_selections: number;
  total_applied: number;
  total_completions: number;
  total_fallbacks: number;
  first_seen: string;
  last_updated: string;
}

export interface SkillSearchResult {
  skill_id: string;
  name: string;
  description: string;
  path: string;
  category: string;
  origin: string;
  score: number;
  source: "local" | "cloud";
}

export interface CloudSkillCandidate {
  skill_id: string;
  name: string;
  description: string;
  content: string;
  category: string;
  origin: string;
  tags: string[];
  embedding?: number[];
}

export interface UploadMeta {
  origin: string;
  parent_skill_ids: string[];
  tags: string[];
  created_by: string;
  change_summary: string;
}

// --- Execution Analysis ---

export interface SkillJudgment {
  skill_id: string;
  skill_applied: boolean;
  note: string;
}

export interface EvolutionSuggestion {
  evolution_type: EvolutionType;
  target_skill_ids: string[];
  category: SkillCategory | null;
  direction: string;
}

export interface ExecutionAnalysis {
  task_id: string;
  timestamp: string;
  task_completed: boolean;
  execution_note: string;
  tool_issues: string[];
  skill_judgments: SkillJudgment[];
  evolution_suggestions: EvolutionSuggestion[];
  analyzed_by: string;
  analyzed_at: string;
}

// --- Evolution ---

export interface EvolutionContext {
  trigger: EvolutionTrigger;
  suggestion: EvolutionSuggestion;
  skill_records: SkillRecord[];
  skill_contents: string[];
  skill_dirs: string[];
  source_task_id: string | null;
  recent_analyses: ExecutionAnalysis[];
  tool_issue_summary: string;
  metric_summary: string;
}

export interface SkillEditResult {
  success: boolean;
  skill_dir: string;
  content: string;
  snapshot: Record<string, string>;
  diff: string;
  error?: string;
}

// --- Grounding (used by grounding module, defined here for cross-reference) ---

export interface ToolDependency {
  skill_id: string;
  tool_key: string;
  critical: boolean;
}

// --- Quality Metrics ---

export interface SkillQualityMetrics {
  skill_id: string;
  total_selections: number;
  total_applied: number;
  total_completions: number;
  total_fallbacks: number;
  applied_rate: number;    // applied / selections
  completion_rate: number; // completions / applied
  effective_rate: number;  // completions / selections
  fallback_rate: number;   // fallbacks / selections
}

// --- Dashboard ---

export interface PipelineStage {
  id: string;
  name: string;
  description: string;
  order: number;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  { id: "initialize", name: "Initialize", description: "Load grounding client and skill registry", order: 0 },
  { id: "select-skills", name: "Skill Selection", description: "Hybrid search for matching skills, rank", order: 1 },
  { id: "skill-phase", name: "Skill Phase", description: "Execute task with skill context via LLM", order: 2 },
  { id: "tool-fallback", name: "Tool Fallback", description: "Retry with tools only if skill phase fails", order: 3 },
  { id: "analysis", name: "Analysis", description: "Run execution analyzer, persist results", order: 4 },
  { id: "evolution", name: "Evolution", description: "Trigger FIX/DERIVED/CAPTURED based on analysis", order: 5 },
];
