// ============================================================================
// Loom routes -- workflow orchestration, runs, steps, logs
// Prefix: /loom/*
// ============================================================================

import { json, errorResponse } from "../../helpers/index.ts";
import { getContext } from "../../middleware/auth.ts";
import { bounded } from "../types.ts";
import {
  createWorkflow, getWorkflow, getWorkflowByName, listWorkflows, updateWorkflow, deleteWorkflow,
  createRun, getRun, listRuns, cancelRun,
  getSteps, getStep, completeStep, failStep,
  getLogs,
  getStats,
} from "./engine.ts";

export async function handleLoomRoutes(
  method: string,
  url: URL,
  req: Request,
  requestId: string,
): Promise<Response | null> {
  const path = url.pathname;

  if (!path.startsWith("/loom/") && path !== "/loom") return null;

  const sub = path.slice("/loom".length); // e.g. "/workflows" or "/runs/5"

  // -- Workflows --

  if (sub === "/workflows" && method === "GET") {
    return json(listWorkflows());
  }

  if (sub === "/workflows" && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    const { name, description, steps } = body;
    if (!name || typeof name !== "string") return errorResponse("name required", 400, requestId);
    if (!Array.isArray(steps) || steps.length === 0) return errorResponse("steps array required", 400, requestId);

    // Validate step definitions
    const validTypes = new Set(["action", "decision", "parallel", "wait", "webhook", "llm", "transform"]);
    const stepNames = new Set<string>();
    for (const step of steps) {
      if (!step.name || typeof step.name !== "string") return errorResponse("each step requires a name", 400, requestId);
      if (!step.type || !validTypes.has(step.type)) return errorResponse(`invalid step type: ${step.type}`, 400, requestId);
      if (stepNames.has(step.name)) return errorResponse(`duplicate step name: ${step.name}`, 400, requestId);
      stepNames.add(step.name);
    }

    // Validate depends_on references
    for (const step of steps) {
      if (step.depends_on) {
        for (const dep of step.depends_on) {
          if (!stepNames.has(dep)) return errorResponse(`step "${step.name}" depends on unknown step "${dep}"`, 400, requestId);
        }
      }
    }

    try {
      return json(createWorkflow(name, description, steps), 201);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return errorResponse("Workflow name already exists", 409, requestId);
      throw e;
    }
  }

  const workflowMatch = sub.match(/^\/workflows\/(\d+)$/);
  if (workflowMatch && method === "GET") {
    const wf = getWorkflow(parseInt(workflowMatch[1], 10));
    if (!wf) return errorResponse("Workflow not found", 404, requestId);
    return json(wf);
  }

  if (workflowMatch && method === "PATCH") {
    const id = parseInt(workflowMatch[1], 10);
    const existing = getWorkflow(id);
    if (!existing) return errorResponse("Workflow not found", 404, requestId);

    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    const updates: { name?: string; description?: string | null; steps?: any[] } = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.steps !== undefined) updates.steps = body.steps;

    try {
      return json(updateWorkflow(id, updates));
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return errorResponse("Workflow name already exists", 409, requestId);
      throw e;
    }
  }

  if (workflowMatch && method === "DELETE") {
    const ok = deleteWorkflow(parseInt(workflowMatch[1], 10));
    if (!ok) return errorResponse("Workflow not found", 404, requestId);
    return json({ ok: true });
  }

  // -- Runs --

  if (sub === "/runs" && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    const { workflow_id, workflow_name, input } = body;

    let resolvedId: number | undefined;
    if (workflow_id) {
      resolvedId = Number(workflow_id);
    } else if (workflow_name && typeof workflow_name === "string") {
      const wf = getWorkflowByName(workflow_name);
      if (!wf) return errorResponse(`Workflow "${workflow_name}" not found`, 404, requestId);
      resolvedId = wf.id as number;
    }
    if (!resolvedId) return errorResponse("workflow_id or workflow_name required", 400, requestId);

    try {
      return json(createRun(resolvedId, input ?? {}), 201);
    } catch (e: any) {
      return errorResponse(e.message ?? "Failed to create run", 400, requestId);
    }
  }

  if (sub === "/runs" && method === "GET") {
    const workflowId = url.searchParams.has("workflow_id") ? parseInt(url.searchParams.get("workflow_id")!, 10) : undefined;
    return json(listRuns({
      workflow_id: workflowId !== undefined && Number.isFinite(workflowId) ? workflowId : undefined,
      status: url.searchParams.get("status") ?? undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 1000, 100),
    }));
  }

  const runMatch = sub.match(/^\/runs\/(\d+)$/);
  if (runMatch && method === "GET") {
    const run = getRun(parseInt(runMatch[1], 10));
    if (!run) return errorResponse("Run not found", 404, requestId);
    return json(run);
  }

  const runCancelMatch = sub.match(/^\/runs\/(\d+)\/cancel$/);
  if (runCancelMatch && method === "POST") {
    const ok = cancelRun(parseInt(runCancelMatch[1], 10));
    if (!ok) return errorResponse("Run not found or already terminal", 404, requestId);
    return json({ ok: true });
  }

  const runStepsMatch = sub.match(/^\/runs\/(\d+)\/steps$/);
  if (runStepsMatch && method === "GET") {
    const runId = parseInt(runStepsMatch[1], 10);
    const run = getRun(runId);
    if (!run) return errorResponse("Run not found", 404, requestId);
    return json(getSteps(runId));
  }

  const runLogsMatch = sub.match(/^\/runs\/(\d+)\/logs$/);
  if (runLogsMatch && method === "GET") {
    const runId = parseInt(runLogsMatch[1], 10);
    const run = getRun(runId);
    if (!run) return errorResponse("Run not found", 404, requestId);
    return json(getLogs({
      run_id: runId,
      step_id: url.searchParams.has("step_id") ? parseInt(url.searchParams.get("step_id")!, 10) : undefined,
      level: url.searchParams.get("level") ?? undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 1000, 200),
    }));
  }

  // -- Step external callbacks --

  const stepCompleteMatch = sub.match(/^\/steps\/(\d+)\/complete$/);
  if (stepCompleteMatch && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    try {
      completeStep(parseInt(stepCompleteMatch[1], 10), body.output ?? {});
      return json({ ok: true });
    } catch (e: any) {
      return errorResponse(e.message ?? "Failed to complete step", 400, requestId);
    }
  }

  const stepFailMatch = sub.match(/^\/steps\/(\d+)\/fail$/);
  if (stepFailMatch && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    if (!body.error || typeof body.error !== "string") return errorResponse("error string required", 400, requestId);
    try {
      failStep(parseInt(stepFailMatch[1], 10), body.error);
      return json({ ok: true });
    } catch (e: any) {
      return errorResponse(e.message ?? "Failed to fail step", 400, requestId);
    }
  }

  // -- Stats --

  if (sub === "/stats" && method === "GET") {
    return json(getStats());
  }

  return null; // Not a loom route match
}
