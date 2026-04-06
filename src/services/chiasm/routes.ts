// ============================================================================
// Chiasm routes - task tracking, activity feed
// Prefixes: /tasks/*, /feed
// ============================================================================

import { json, errorResponse } from "../../helpers/index.ts";
import { getContext } from "../../middleware/auth.ts";
import { bounded } from "../types.ts";
import {
  listTasks, getTask, createTask, updateTask, deleteTask,
  getFeed, getChiasmStats,
  VALID_STATUSES,
} from "./engine.ts";

export async function handleChiasmRoutes(
  method: string,
  url: URL,
  req: Request,
  requestId: string,
): Promise<Response | null> {
  const path = url.pathname;

  // Only handle /tasks*, /feed, nothing else
  if (!path.startsWith("/tasks") && path !== "/feed") return null;

  // - Tasks --

  if (path === "/tasks" && method === "GET") {
    const { auth } = getContext(req);
    return json(listTasks(auth.user_id, {
      agent: url.searchParams.get("agent") ?? undefined,
      project: url.searchParams.get("project") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 1000, 500),
      offset: bounded(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0),
    }));
  }

  if (path === "/tasks" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const { agent, project, title, summary } = body;
    if (!agent || !project || !title) return errorResponse("agent, project, and title are required", 400, requestId);
    if (typeof agent !== "string" || typeof project !== "string" || typeof title !== "string") {
      return errorResponse("agent, project, and title must be strings", 400, requestId);
    }
    if (summary !== undefined && typeof summary !== "string") {
      return errorResponse("summary must be a string", 400, requestId);
    }
    return json(createTask(auth.user_id, { agent, project, title, summary }), 201);
  }

  // /tasks/stats must come before /tasks/:id
  if (path === "/tasks/stats" && method === "GET") {
    const { auth } = getContext(req);
    return json(getChiasmStats(auth.is_admin ? undefined : auth.user_id));
  }

  const taskMatch = path.match(/^\/tasks\/(\d+)$/);

  if (taskMatch && method === "GET") {
    const { auth } = getContext(req);
    const task = getTask(parseInt(taskMatch[1], 10), auth.user_id);
    if (!task) return errorResponse("Task not found", 404, requestId);
    return json(task);
  }

  if (taskMatch && method === "PATCH") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const taskId = parseInt(taskMatch[1], 10);
    const existing = getTask(taskId, auth.user_id);
    if (!existing) return errorResponse("Task not found", 404, requestId);

    if (body.agent !== undefined) return errorResponse("agent cannot be updated", 400, requestId);
    if (body.status !== undefined && typeof body.status !== "string") {
      return errorResponse("status must be a string", 400, requestId);
    }
    if (body.summary !== undefined && typeof body.summary !== "string") {
      return errorResponse("summary must be a string", 400, requestId);
    }
    if (typeof body.status === "string" && !VALID_STATUSES.has(body.status)) {
      return errorResponse(`Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}`, 400, requestId);
    }

    const task = updateTask(taskId, auth.user_id, { status: body.status, summary: body.summary });
    if (!task) return errorResponse("Task not found", 404, requestId);
    return json(task);
  }

  if (taskMatch && method === "DELETE") {
    const { auth } = getContext(req);
    const taskId = parseInt(taskMatch[1], 10);
    const existing = getTask(taskId, auth.user_id);
    if (!existing) return errorResponse("Task not found", 404, requestId);
    deleteTask(taskId, auth.user_id);
    return json({ ok: true });
  }

  // - Feed --

  if (path === "/feed" && method === "GET") {
    const { auth } = getContext(req);
    const limit = bounded(url.searchParams.get("limit"), 1, 200, 50);
    const offset = bounded(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0);
    return json(getFeed(auth.user_id, limit, offset));
  }

  return null;
}
