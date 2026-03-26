// ============================================================================
// Chiasm routes -- task tracking, activity feed
// Prefixes: /tasks/*, /feed
// ============================================================================

import { json, errorResponse } from "../../helpers/index.ts";
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

  // -- Tasks --

  if (path === "/tasks" && method === "GET") {
    return json(listTasks({
      agent: url.searchParams.get("agent") ?? undefined,
      project: url.searchParams.get("project") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 1000, 500),
      offset: bounded(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0),
    }));
  }

  if (path === "/tasks" && method === "POST") {
    const body = await req.json().catch(() => ({})) as any;
    const { agent, project, title, summary } = body;
    if (!agent || !project || !title) return errorResponse("agent, project, and title are required", 400, requestId);
    if (typeof agent !== "string" || typeof project !== "string" || typeof title !== "string") {
      return errorResponse("agent, project, and title must be strings", 400, requestId);
    }
    if (summary !== undefined && typeof summary !== "string") {
      return errorResponse("summary must be a string", 400, requestId);
    }
    return json(createTask({ agent, project, title, summary }), 201);
  }

  // /tasks/stats must come before /tasks/:id
  if (path === "/tasks/stats" && method === "GET") {
    return json(getChiasmStats());
  }

  const taskMatch = path.match(/^\/tasks\/(\d+)$/);

  if (taskMatch && method === "GET") {
    const task = getTask(parseInt(taskMatch[1], 10));
    if (!task) return errorResponse("Task not found", 404, requestId);
    return json(task);
  }

  if (taskMatch && method === "PATCH") {
    const body = await req.json().catch(() => ({})) as any;
    const taskId = parseInt(taskMatch[1], 10);
    const existing = getTask(taskId);
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

    const task = updateTask(taskId, { status: body.status, summary: body.summary });
    if (!task) return errorResponse("Task not found", 404, requestId);
    return json(task);
  }

  if (taskMatch && method === "DELETE") {
    const taskId = parseInt(taskMatch[1], 10);
    const existing = getTask(taskId);
    if (!existing) return errorResponse("Task not found", 404, requestId);
    deleteTask(taskId);
    return json({ ok: true });
  }

  // -- Feed --

  if (path === "/feed" && method === "GET") {
    const limit = bounded(url.searchParams.get("limit"), 1, 200, 50);
    const offset = bounded(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0);
    return json(getFeed(limit, offset));
  }

  return null;
}
