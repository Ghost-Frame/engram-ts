export interface SkillMeta {
  name: string;
  description: string;
  category?: string;
  tags?: string[];
}

export interface SkillRecord {
  skill_id: string;
  name: string;
  description: string;
  path: string;
  content: string;
  category: string;
  origin: string;
  generation: number;
  lineage_change_summary: string | null;
  creator_id: string | null;
  is_active: number;
  total_selections: number;
  total_applied: number;
  total_completions: number;
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
