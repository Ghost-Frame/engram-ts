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
  recordSessionQuality, getSessionQuality,
  recordDriftEvent, getDriftEvents, getDriftSummary,
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
    const { auth } = getContext(req);
    return json(listRubrics(auth.user_id));
  }

  if (sub === "/rubrics" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const { name, description, criteria } = body;
    if (!name || typeof name !== "string") return errorResponse("name required", 400, requestId);
    if (!criteria || !Array.isArray(criteria)) return errorResponse("criteria (array) required", 400, requestId);
    try {
      return json(createRubric(auth.user_id, name, description, criteria), 201);
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
    const { auth } = getContext(req);
    const ok = deleteRubric(auth.user_id, parseInt(rubricMatch[1], 10));
    if (!ok) return errorResponse("Rubric not found", 404, requestId);
    return json({ ok: true });
  }

  // - Evaluations --

  if (sub === "/evaluate" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const { rubric_id, agent, subject, input, output, scores, notes, evaluator } = body;
    if (!rubric_id || typeof rubric_id !== "number") return errorResponse("rubric_id (number) required", 400, requestId);
    if (!agent || typeof agent !== "string") return errorResponse("agent required", 400, requestId);
    if (!subject || typeof subject !== "string") return errorResponse("subject required", 400, requestId);
    if (!scores || typeof scores !== "object") return errorResponse("scores (object) required", 400, requestId);
    if (!evaluator || typeof evaluator !== "string") return errorResponse("evaluator required", 400, requestId);
    try {
      return json(evaluate(auth.user_id, rubric_id, agent, subject, input, output, scores, notes, evaluator), 201);
    } catch (e: any) {
      return errorResponse(e.message ?? "Evaluation failed", 400, requestId);
    }
  }

  if (sub === "/evaluations" && method === "GET") {
    const { auth } = getContext(req);
    return json(listEvaluations(auth.user_id, {
      agent: url.searchParams.get("agent") ?? undefined,
      rubric_id: url.searchParams.has("rubric_id") ? parseInt(url.searchParams.get("rubric_id")!, 10) : undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 1000, 100),
    }));
  }

  const evalMatch = sub.match(/^\/evaluations\/(\d+)$/);
  if (evalMatch && method === "GET") {
    const { auth } = getContext(req);
    const evaluation = getEvaluation(parseInt(evalMatch[1], 10));
    if (!evaluation) return errorResponse("Evaluation not found", 404, requestId);
    if ((evaluation as any).user_id !== auth.user_id) return errorResponse("Evaluation not found", 404, requestId);
    return json(evaluation);
  }

  // - Agent Scores --

  const agentScoresMatch = sub.match(/^\/agents\/([^/]+)\/scores$/);
  if (agentScoresMatch && method === "GET") {
    const { auth } = getContext(req);
    const agentName = decodeURIComponent(agentScoresMatch[1]);
    return json(getAgentScores(auth.user_id, agentName, {
      rubric_id: url.searchParams.has("rubric_id") ? parseInt(url.searchParams.get("rubric_id")!, 10) : undefined,
      since: url.searchParams.get("since") ?? undefined,
    }));
  }

  // - Metrics --

  if (sub === "/metrics" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const { agent, metric, value, tags } = body;
    if (!agent || typeof agent !== "string") return errorResponse("agent required", 400, requestId);
    if (!metric || typeof metric !== "string") return errorResponse("metric required", 400, requestId);
    if (value === undefined || typeof value !== "number") return errorResponse("value (number) required", 400, requestId);
    return json(recordMetric(auth.user_id, agent, metric, value, tags), 201);
  }

  if (sub === "/metrics" && method === "GET") {
    const { auth } = getContext(req);
    return json(getMetrics(auth.user_id, {
      agent: url.searchParams.get("agent") ?? undefined,
      metric: url.searchParams.get("metric") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 1000, 100),
    }));
  }

  if (sub === "/metrics/summary" && method === "GET") {
    const { auth } = getContext(req);
    const agent = url.searchParams.get("agent");
    const metric = url.searchParams.get("metric");
    if (!agent) return errorResponse("agent query param required", 400, requestId);
    if (!metric) return errorResponse("metric query param required", 400, requestId);
    return json(getMetricSummary(auth.user_id, agent, metric, url.searchParams.get("since") ?? undefined));
  }

  // - Stats --

  if (sub === "/stats" && method === "GET") {
    const { auth } = getContext(req);
    return json(getStats(auth.is_admin ? undefined : auth.user_id));
  }

  // - Session Quality --

  if (sub === "/session-quality" && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    if (!body.session_id || !body.agent) return errorResponse("session_id and agent are required", 400, requestId);
    try {
      return json(recordSessionQuality(body), 201);
    } catch (e: any) {
      return errorResponse(e.message, 400, requestId);
    }
  }

  if (sub === "/session-quality" && method === "GET") {
    const agent = url.searchParams.get("agent");
    if (!agent) return errorResponse("agent query parameter is required", 400, requestId);
    const since = url.searchParams.get("since") ?? undefined;
    const limitStr = url.searchParams.get("limit");
    const results = getSessionQuality(agent, {
      since,
      limit: limitStr ? parseInt(limitStr, 10) : undefined,
    });
    return json(results);
  }

  // - Drift Events --

  if (sub === "/drift-events" && method === "POST") {
    const { body: rawBody } = getContext(req);
    const body = (rawBody || {}) as any;
    if (!body.agent || !body.drift_type || !body.signal) {
      return errorResponse("agent, drift_type, and signal are required", 400, requestId);
    }
    try {
      return json(recordDriftEvent(body), 201);
    } catch (e: any) {
      return errorResponse(e.message, 400, requestId);
    }
  }

  if (sub === "/drift-events" && method === "GET") {
    const agent = url.searchParams.get("agent");
    if (!agent) return errorResponse("agent query parameter is required", 400, requestId);
    const limitStr = url.searchParams.get("limit");
    const results = getDriftEvents(agent, limitStr ? parseInt(limitStr, 10) : undefined);
    return json(results);
  }

  if (sub === "/drift-summary" && method === "GET") {
    const agent = url.searchParams.get("agent");
    if (!agent) return errorResponse("agent query parameter is required", 400, requestId);
    return json(getDriftSummary(agent));
  }

  return null; // Not a thymus route match
}
