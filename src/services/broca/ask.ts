// ============================================================================
// Broca ask - Natural language query gateway
// Routes questions to internal service functions via LLM-planned queries.
// Key difference from standalone: direct function imports, no HTTP calls.
// ============================================================================

import { log } from "../../config/logger.ts";
import { callLocalModel, isLocalModelAvailable } from "../../llm/local.ts";

// - Direct service imports (no HTTP, just function calls) --

import { listAgents, getAgent, getStats as getSomaStats } from "../soma/registry.ts";
import { listTasks, getTask, getChiasmStats } from "../chiasm/engine.ts";
import { listRubrics, listEvaluations, getAgentScores, getStats as getThymusStats } from "../thymus/scoring.ts";
import { listChannels, getEvents, getStats as getAxonStats } from "../axon/bus.ts";
import { listWorkflows, listRuns, getRun, getStats as getLoomStats } from "../loom/engine.ts";

// - Service catalog (describes available queries for the LLM planner) --

const SERVICE_CATALOG = `
Available services and their query functions:

1. SOMA (Agent Registry)
   - listAgents(opts?: { type?, status?, capability?, limit? }) - list registered agents
   - getAgent(id: number) - get a specific agent by ID
   - getSomaStats() - agent counts, online count, by type/status

2. CHIASM (Task Tracking)
   - listTasks(filters?: { agent?, project?, status?, limit?, offset? }) - list tasks
   - getTask(id: number) - get a specific task by ID
   - getChiasmStats() - total tasks, active count, by agent/project

3. THYMUS (Quality Evaluation)
   - listRubrics() - list evaluation rubrics
   - listEvaluations(opts?: { agent?, rubric_id?, limit? }) - list evaluations
   - getAgentScores(agent: string, opts?: { rubric_id?, since? }) - agent score summary
   - getThymusStats() - rubric/evaluation/metric counts, by rubric

4. AXON (Event Bus)
   - listChannels() - list event channels with counts
   - getEvents(opts?: { channel?, type?, source?, since_id?, limit? }) - list events
   - getAxonStats() - channel, event, subscription counts

5. LOOM (Workflow Engine)
   - listWorkflows() - list defined workflows
   - listRuns(opts?: { workflow_id?, status?, limit? }) - list workflow runs
   - getRun(id: number) - get a specific run by ID
   - getLoomStats() - workflow, run, active run, step counts
`.trim();

// - Query plan type --

interface QueryPlan {
  service: string;
  function: string;
  params: Record<string, unknown>;
}

// - Function dispatcher --

function dispatch(userId: number, plan: QueryPlan): unknown {
  const { service, params } = plan;
  const fn = plan.function;

  switch (service) {
    case "soma":
      if (fn === "listAgents") return listAgents(userId, params as any);
      if (fn === "getAgent") return getAgent(Number(params.id), userId);
      if (fn === "getSomaStats") return getSomaStats();
      break;

    case "chiasm":
      if (fn === "listTasks") return listTasks(userId, params as any);
      if (fn === "getTask") return getTask(Number(params.id), userId);
      if (fn === "getChiasmStats") return getChiasmStats();
      break;

    case "thymus":
      if (fn === "listRubrics") return listRubrics(userId);
      if (fn === "listEvaluations") return listEvaluations(userId, params as any);
      if (fn === "getAgentScores") return getAgentScores(userId, String(params.agent), params as any);
      if (fn === "getThymusStats") return getThymusStats();
      break;

    case "axon":
      if (fn === "listChannels") return listChannels(userId);
      if (fn === "getEvents") return getEvents(userId, params as any);
      if (fn === "getAxonStats") return getAxonStats();
      break;

    case "loom":
      if (fn === "listWorkflows") return listWorkflows(userId);
      if (fn === "listRuns") return listRuns(userId, params as any);
      if (fn === "getRun") return getRun(Number(params.id), userId);
      if (fn === "getLoomStats") return getLoomStats();
      break;
  }

  throw new Error(`Unknown function: ${service}.${fn}`);
}

// - Main ask() function --

export async function ask(userId: number, question: string): Promise<{ answer: string; plan: QueryPlan | null; raw: unknown }> {
  if (!isLocalModelAvailable()) {
    return { answer: "No LLM provider is available to process natural language queries.", plan: null, raw: null };
  }

  // Step 1: Ask LLM to pick a query plan
  const planPrompt = `Given this question about a multi-agent system, determine which service function to call.

${SERVICE_CATALOG}

Question: "${question}"

Respond with ONLY a JSON object (no markdown, no backticks):
{"service": "service_name", "function": "function_name", "params": {}}

If the question cannot be answered by any available function, respond with:
{"service": "none", "function": "none", "params": {}}`;

  let plan: QueryPlan | null = null;
  let raw: unknown = null;

  try {
    const planResult = await callLocalModel(
      "You are a query router. Given a natural language question, select the best service function and parameters. Return only JSON.",
      planPrompt,
      { priority: "background" },
    );

    // Parse the plan
    const match = planResult.match(/\{[\s\S]*\}/);
    if (match) {
      plan = JSON.parse(match[0]) as QueryPlan;
    }
  } catch (e: any) {
    log.warn({ msg: "broca_ask_plan_failed", question: question.slice(0, 100), error: e.message });
    return { answer: "Failed to determine how to answer this question.", plan: null, raw: null };
  }

  if (!plan || plan.service === "none") {
    return { answer: "I could not find a suitable service to answer that question.", plan: null, raw: null };
  }

  // Step 2: Execute the plan
  try {
    raw = dispatch(userId, plan);
  } catch (e: any) {
    log.warn({ msg: "broca_ask_dispatch_failed", plan, error: e.message });
    return { answer: `Failed to execute query: ${e.message}`, plan, raw: null };
  }

  // Step 3: Summarize results in natural language
  try {
    const summaryResult = await callLocalModel(
      "You are a concise system narrator. Summarize the following data in plain English to answer the user's question. Be brief and factual. No markdown.",
      `Question: "${question}"\n\nData from ${plan.service}.${plan.function}:\n${JSON.stringify(raw, null, 2).slice(0, 4000)}`,
      { priority: "background" },
    );

    return { answer: summaryResult.trim(), plan, raw };
  } catch (e: any) {
    log.warn({ msg: "broca_ask_summary_failed", error: e.message });
    // Return raw data as a fallback
    return {
      answer: `Query executed successfully but failed to generate summary. Raw result returned.`,
      plan,
      raw,
    };
  }
}
