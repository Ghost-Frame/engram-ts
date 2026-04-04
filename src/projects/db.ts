// ============================================================================
// PROJECTS DOMAIN - Database prepared statements
// ============================================================================

import { db } from "../db/connection.ts";

// -- Core CRUD ---------------------------------------------------------------

export const insertProject = db.prepare(
  `INSERT INTO projects (name, description, status, metadata, user_id)
   VALUES (?, ?, ?, ?, ?) RETURNING id, created_at`
);

export const getProject = db.prepare(
  `SELECT p.*, GROUP_CONCAT(DISTINCT mp.memory_id) as memory_ids
   FROM projects p LEFT JOIN memory_projects mp ON mp.project_id = p.id
   WHERE p.id = ? GROUP BY p.id`
);

export const getProjectForUser = db.prepare(
  `SELECT p.*, GROUP_CONCAT(DISTINCT mp.memory_id) as memory_ids
   FROM projects p LEFT JOIN memory_projects mp ON mp.project_id = p.id
   WHERE p.id = ? AND p.user_id = ? GROUP BY p.id`
);

export const listProjects = db.prepare(
  `SELECT p.id, p.name, p.description, p.status, p.created_at,
     (SELECT COUNT(*) FROM memory_projects WHERE project_id = p.id) as memory_count
   FROM projects p WHERE p.user_id = ? ORDER BY p.status = 'active' DESC, p.name COLLATE NOCASE`
);

export const listProjectsByStatus = db.prepare(
  `SELECT p.id, p.name, p.description, p.status, p.created_at,
     (SELECT COUNT(*) FROM memory_projects WHERE project_id = p.id) as memory_count
   FROM projects p WHERE p.user_id = ? AND p.status = ? ORDER BY p.name COLLATE NOCASE`
);

// -- Update + Delete ---------------------------------------------------------

export const updateProject = db.prepare(
  `UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description),
   status = COALESCE(?, status), metadata = COALESCE(?, metadata),
   updated_at = datetime('now') WHERE id = ? AND user_id = ?`
);

export const deleteProject = db.prepare(
  `DELETE FROM projects WHERE id = ? AND user_id = ?`
);

// -- Memory linking ----------------------------------------------------------

export const linkMemoryProject = db.prepare(
  `INSERT OR IGNORE INTO memory_projects (memory_id, project_id) VALUES (?, ?)`
);

export const unlinkMemoryProject = db.prepare(
  `DELETE FROM memory_projects WHERE memory_id = ? AND project_id = ?`
);

export const getProjectMemories = db.prepare(
  `SELECT m.id, m.content, m.category, m.importance, m.tags, m.created_at, m.decay_score, m.confidence
   FROM memories m JOIN memory_projects mp ON mp.memory_id = m.id
   WHERE mp.project_id = ? AND m.user_id = ? AND m.is_forgotten = 0 AND m.is_archived = 0
   ORDER BY m.created_at DESC LIMIT ?`
);

// -- Scoped search helper ----------------------------------------------------

export const getProjectMemoryIds = db.prepare(
  `SELECT mp.memory_id FROM memory_projects mp
   JOIN memories m ON m.id = mp.memory_id
   WHERE mp.project_id = ? AND m.user_id = ?`
);

// Re-export db for cases where routes need raw db access
export { db } from "../db/connection.ts";
