// ============================================================================
// Thymus routes - quality scoring, rubric evaluations, metrics
// Prefix: /thymus/*
// ============================================================================

import { json, errorResponse } from "../../helpers/index.ts";
import { getContext } from "../../middleware/auth.ts";
import { bounded } from "../types.ts";
import {
  createRubric, getRubric, getRubricName, listRubrics, updateRubric, deleteRubric,
  evaluate, getEvaluation, listEvaluations, getAgentScores,
  recordMetric, getMetrics, getMetricSummary,
  getStats,
} from "./scoring.ts";

export async function handleThymusRoutes(
  method: string,
  url: URL,
  req: Request,
  requestId: string,
): Promise<Response | null> {
  const path = url.pathname;

  if (!path.startsWith("/thymus/") && path !== "/thymus") return null;

  // Strip prefix for cleaner matching
  const sub = path.slice("/thymus".length); // e.g. "/rubrics" or "/rubrics/5"

  // - Rubrics --

  if (sub === "/rubrics" && method === "GET") {
    return json(listRubrics());
  }

  if (sub === "/rubrics" && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    const { name, description, criteria } = body;
    if (!name || typeof name !== "string") return errorResponse("name required", 400, requestId);
    if (!criteria || !Array.isArray(criteria)) return errorResponse("criteria (array) required", 400, requestId);
    try {
      return json(createRubric(name, description, criteria), 201);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return errorResponse("Rubric already exists", 409, requestId);
      throw e;
    }
  }

  const rubricMatch = sub.match(/^\/rubrics\/(\d+)$/);

  if (rubricMatch && method === "GET") {
    const rubric = getRubric(parseInt(rubricMatch[1], 10));
    if (!rubric) return errorResponse("Rubric not found", 404, requestId);
    return json(rubric);
  }

  if (rubricMatch && method === "PATCH") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    const rubric = updateRubric(parseInt(rubricMatch[1], 10), body);
    if (!rubric) return errorResponse("Rubric not found", 404, requestId);
    return json(rubric);
  }

  if (rubricMatch && method === "DELETE") {
    const ok = deleteRubric(parseInt(rubricMatch[1], 10));
    if (!ok) return errorResponse("Rubric not found", 404, requestId);
    return json({ ok: true });
  }

  // - Evaluations --

  if (sub === "/evaluate" && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    const { rubric_id, agent, subject, input, output, scores, notes, evaluator } = body;
    if (!rubric_id || typeof rubric_id !== "number") return errorResponse("rubric_id (number) required", 400, requestId);
    if (!agent || typeof agent !== "string") return errorResponse("agent required", 400, requestId);
    if (!subject || typeof subject !== "string") return errorResponse("subject required", 400, requestId);
    if (!scores || typeof scores !== "object") return errorResponse("scores (object) required", 400, requestId);
    if (!evaluator || typeof evaluator !== "string") return errorResponse("evaluator required", 400, requestId);
    try {
      return json(evaluate(rubric_id, agent, subject, input, output, scores, notes, evaluator), 201);
    } catch (e: any) {
      return errorResponse(e.message ?? "Evaluation failed", 400, requestId);
    }
  }

  if (sub === "/evaluations" && method === "GET") {
    return json(listEvaluations({
      agent: url.searchParams.get("agent") ?? undefined,
      rubric_id: url.searchParams.has("rubric_id") ? parseInt(url.searchParams.get("rubric_id")!, 10) : undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 1000, 100),
    }));
  }

  const evalMatch = sub.match(/^\/evaluations\/(\d+)$/);
  if (evalMatch && method === "GET") {
    const evaluation = getEvaluation(parseInt(evalMatch[1], 10));
    if (!evaluation) return errorResponse("Evaluation not found", 404, requestId);
    return json(evaluation);
  }

  // - Agent Scores --

  const agentScoresMatch = sub.match(/^\/agents\/([^/]+)\/scores$/);
  if (agentScoresMatch && method === "GET") {
    const agentName = decodeURIComponent(agentScoresMatch[1]);
    return json(getAgentScores(agentName, {
      rubric_id: url.searchParams.has("rubric_id") ? parseInt(url.searchParams.get("rubric_id")!, 10) : undefined,
      since: url.searchParams.get("since") ?? undefined,
    }));
  }

  // - Metrics --

  if (sub === "/metrics" && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    const { agent, metric, value, tags } = body;
    if (!agent || typeof agent !== "string") return errorResponse("agent required", 400, requestId);
    if (!metric || typeof metric !== "string") return errorResponse("metric required", 400, requestId);
    if (value === undefined || typeof value !== "number") return errorResponse("value (number) required", 400, requestId);
    return json(recordMetric(agent, metric, value, tags), 201);
  }

  if (sub === "/metrics" && method === "GET") {
    return json(getMetrics({
      agent: url.searchParams.get("agent") ?? undefined,
      metric: url.searchParams.get("metric") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 1000, 100),
    }));
  }

  if (sub === "/metrics/summary" && method === "GET") {
    const agent = url.searchParams.get("agent");
    const metric = url.searchParams.get("metric");
    if (!agent) return errorResponse("agent query param required", 400, requestId);
    if (!metric) return errorResponse("metric query param required", 400, requestId);
    return json(getMetricSummary(agent, metric, url.searchParams.get("since") ?? undefined));
  }

  // - Stats --

  if (sub === "/stats" && method === "GET") {
    return json(getStats());
  }

  return null; // Not a thymus route match
}
