// ============================================================================
// EPISODES DOMAIN -- Type definitions and constants
// ============================================================================

/** Shape of an episode row from the database */
export interface EpisodeRow {
  id: number;
  title: string | null;
  session_id: string | null;
  agent: string | null;
  user_id: number;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  memory_count: number;
  embedding: Buffer | null;
}

/** Body for POST /episodes */
export interface CreateEpisodeBody {
  title?: string;
  session_id?: string;
  agent?: string;
  summary?: string;
  conversation?: string;
  started_at?: string;
  ended_at?: string;
}

/** Body for PATCH /episodes/:id */
export interface UpdateEpisodeBody {
  title?: string;
  summary?: string;
  ended_at?: string;
}

/** Body for POST /episodes/:id/memories */
export interface AssignMemoriesBody {
  memory_ids: number[];
}

/** Result from INSERT ... RETURNING */
export interface InsertEpisodeResult {
  id: number;
  started_at: string;
}

/** Memory row shape returned by getEpisodeMemories */
export interface EpisodeMemoryRow {
  id: number;
  content: string;
  category: string;
  source: string;
  importance: number;
  created_at: string;
  tags: string;
  access_count: number;
}
