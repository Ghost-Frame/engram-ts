// ============================================================================
// PROJECTS DOMAIN - Route handlers (thin wrappers)
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope, canAccessOwnedRow } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import {
  insertProject,
  getProjectForUser,
  listProjects,
  listProjectsByStatus,
  getProjectMemories,
  updateProject,
  deleteProject,
  linkMemoryProject,
  unlinkMemoryProject,
  getProjectMemoryIds,
} from "./db.ts";
import type {
  CreateProjectBody,
  UpdateProjectBody,
  InsertProjectResult,
  ProjectMemoryRow,
} from "./types.ts";
import { VALID_PROJECT_STATUSES } from "./types.ts";
import { getMemoryWithoutEmbedding } from "../db/index.ts";
import { hybridSearch } from "../memory/search.ts";
import { trackAccessWithFSRS } from "../db/index.ts";

export function registerProjectRoutes(router: Router): void {

  // POST /projects - create a new project
  router.post("/projects", async (req) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const body = (getContext(req)).body as CreateProjectBody;
      if (!body.name?.trim()) return errorResponse("name is required");
      const status = VALID_PROJECT_STATUSES.includes(body.status as any) ? body.status : "active";
      const result = insertProject.get(
        body.name.trim(), body.description || null, status,
        body.metadata ? JSON.stringify(body.metadata) : null, auth.user_id,
      ) as InsertProjectResult;
      return json({ created: true, id: result.id, name: body.name.trim(), status, created_at: result.created_at });
    } catch (e: any) {
      return safeError("create project", e);
    }
  });

  // GET /projects - list projects, optionally filtered by status
  router.get("/projects", async (req) => {
    const { auth, url } = getContext(req);
    const status = url.searchParams.get("status");
    const projects = status
      ? listProjectsByStatus.all(auth.user_id, status) as any[]
      : listProjects.all(auth.user_id) as any[];
    for (const p of projects) {
      try { if (p.metadata) p.metadata = JSON.parse(p.metadata); } catch {}
    }
    return json({ projects, count: projects.length });
  });

  // GET /projects/:id - get single project with its memories
  router.get("/projects/:id", async (req, params) => {
    const { auth, url } = getContext(req);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    const project = getProjectForUser.get(id, auth.user_id) as any;
    if (!project) return errorResponse("Project not found", 404);
    try { if (project.metadata) project.metadata = JSON.parse(project.metadata); } catch {}
    project.memory_ids = project.memory_ids ? project.memory_ids.split(",").map(Number) : [];
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    project.memories = getProjectMemories.all(id, auth.user_id, limit) as ProjectMemoryRow[];
    for (const m of project.memories as any[]) {
      try { if (m.tags) m.tags = JSON.parse(m.tags); } catch { m.tags = []; }
    }
    return json(project);
  });

  // PUT /projects/:id - update project fields
  router.put("/projects/:id", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    try {
      const id = Number(params.id);
      if (isNaN(id)) return errorResponse("Invalid id");
      const body = (getContext(req)).body as UpdateProjectBody;
      updateProject.run(
        body.name || null, body.description || null,
        body.status || null, body.metadata ? JSON.stringify(body.metadata) : null,
        id, auth.user_id,
      );
      return json({ updated: true, id });
    } catch (e: any) {
      return safeError("Update", e);
    }
  });

  // DELETE /projects/:id - delete a project
  router.delete("/projects/:id", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const id = Number(params.id);
    if (isNaN(id)) return errorResponse("Invalid id");
    deleteProject.run(id, auth.user_id);
    return json({ deleted: true, id });
  });

  // PUT /projects/:id/memories/:mid - link a memory to a project
  router.put("/projects/:id/memories/:mid", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const projectId = Number(params.id);
    const memoryId = Number(params.mid);
    if (isNaN(projectId) || isNaN(memoryId)) return errorResponse("Invalid id");
    if (!getProjectForUser.get(projectId, auth.user_id)) return errorResponse("Project not found", 404);
    const mem = getMemoryWithoutEmbedding.get(memoryId) as any;
    if (!canAccessOwnedRow(mem, auth)) return errorResponse("Memory not found", 404);
    linkMemoryProject.run(memoryId, projectId);
    return json({ linked: true, project_id: projectId, memory_id: memoryId });
  });

  // DELETE /projects/:id/memories/:mid - unlink a memory from a project
  router.delete("/projects/:id/memories/:mid", async (req, params) => {
    const { auth } = getContext(req);
    if (!hasScope(auth, "write")) return errorResponse("Write scope required", 403);
    const projectId = Number(params.id);
    const memoryId = Number(params.mid);
    if (isNaN(projectId) || isNaN(memoryId)) return errorResponse("Invalid id");
    if (!getProjectForUser.get(projectId, auth.user_id)) return errorResponse("Project not found", 404);
    const mem = getMemoryWithoutEmbedding.get(memoryId) as any;
    if (!canAccessOwnedRow(mem, auth)) return errorResponse("Memory not found", 404);
    unlinkMemoryProject.run(memoryId, projectId);
    return json({ unlinked: true, project_id: projectId, memory_id: memoryId });
  });

  // POST /projects/:id/search - search memories within a project
  router.post("/projects/:id/search", async (req, params) => {
    const { auth } = getContext(req);
    try {
      const projectId = Number(params.id);
      if (isNaN(projectId)) return errorResponse("Invalid id");
      if (!getProjectForUser.get(projectId, auth.user_id)) return errorResponse("Project not found", 404);
      const body = (getContext(req)).body as { query?: string; limit?: number };
      const query = body.query;
      if (!query) return errorResponse("query is required");
      const limit = Math.min(Number(body.limit || 20), 100);

      // Get all memory IDs in this project
      const projectMemIds = (getProjectMemoryIds.all(projectId, auth.user_id) as any[]).map(r => r.memory_id);
      if (projectMemIds.length === 0) return json({ results: [], count: 0, project_id: projectId });

      // Run normal search then filter to project scope
      const allResults = await hybridSearch(query, limit * 3, false, true, true, auth.user_id);
      const scoped = allResults.filter(r => projectMemIds.includes(r.id)).slice(0, limit);
      for (const r of scoped) trackAccessWithFSRS(r.id);
      return json({ results: scoped, count: scoped.length, project_id: projectId });
    } catch (e: any) {
      return safeError("Project search", e);
    }
  });

} // end registerProjectRoutes
