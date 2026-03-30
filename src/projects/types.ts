// ============================================================================
// PROJECTS DOMAIN -- Type definitions and constants
// ============================================================================

/** Valid project status values */
export const VALID_PROJECT_STATUSES = ["active", "paused", "completed", "archived"] as const;

/** Union type derived from the valid statuses array */
export type ProjectStatus = (typeof VALID_PROJECT_STATUSES)[number];

/** Shape of a project row from the database */
export interface ProjectRow {
  id: number;
  name: string;
  description: string | null;
  status: ProjectStatus;
  metadata: string | null;
  user_id: number;
  created_at: string;
  updated_at: string | null;
  memory_ids: string | null;
}

/** Body for POST /projects */
export interface CreateProjectBody {
  name?: string;
  description?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

/** Body for PUT /projects/:id */
export interface UpdateProjectBody {
  name?: string;
  description?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

/** Result from INSERT ... RETURNING */
export interface InsertProjectResult {
  id: number;
  created_at: string;
}

/** Memory row shape returned by getProjectMemories */
export interface ProjectMemoryRow {
  id: number;
  content: string;
  category: string;
  importance: number;
  tags: string;
  created_at: string;
  decay_score: number | null;
  confidence: number | null;
}
