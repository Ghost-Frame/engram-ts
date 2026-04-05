// ============================================================================
// Broca narrator - template-based action narration with LLM fallback
// 30+ action templates for O(1) narration; falls back to LLM for unknowns.
// ============================================================================

import { log } from "../../config/logger.ts";
import { callLocalModel, isLocalModelAvailable } from "../../llm/local.ts";

// - Template map: action -> narrative generator --

const TEMPLATES: Record<string, (p: Record<string, unknown>) => string> = {
  // Tasks (Chiasm)
  "task.created":         p => `${p.agent || p.source || "An agent"} started a new task: "${p.title}" in ${p.project}`,
  "task.updated":         p => `"${p.title}" status changed to ${p.status}${p.summary ? ": " + p.summary : ""}`,
  "task.completed":       p => `"${p.title || p.task_title}" was completed${p.agent ? " by " + p.agent : ""}`,
  "task.blocked":         p => `"${p.title}" is blocked${p.reason ? ": " + p.reason : ""}`,

  // Workflows (Loom)
  "workflow.run.created":    p => `${p.agent || "An agent"} started the "${p.workflow}" workflow`,
  "workflow.run.completed":  p => `The "${p.workflow}" workflow finished successfully`,
  "workflow.run.failed":     p => `The "${p.workflow}" workflow failed on step "${p.failed_step}"${p.error ? ": " + p.error : ""}`,
  "workflow.run.cancelled":  p => `The "${p.workflow}" workflow was cancelled`,
  "workflow.step.started":   p => `Step "${p.step}" started in the "${p.workflow}" workflow`,
  "workflow.step.completed": p => `Step "${p.step}" finished in the "${p.workflow}" workflow`,
  "workflow.step.failed":    p => `Step "${p.step}" failed in the "${p.workflow}" workflow: ${p.error}`,

  // Agents (Soma)
  "agent.registered":    p => `${p.name} came online as a ${p.type}`,
  "agent.deregistered":  p => `${p.name} went offline`,
  "agent.online":        p => `${p.agent || p.name} is online`,
  "agent.offline":       p => `${p.agent || p.name} went offline`,

  // Memory (Engram)
  "memory.stored":   p => `${p.source || "An agent"} stored a memory${p.category ? " (" + p.category + ")" : ""}`,
  "memory.searched": p => `${p.agent || "An agent"} searched memory for "${p.query}"`,
  "memory.forgotten": () => `A memory was removed`,

  // Evaluations (Thymus)
  "evaluation.completed": p => {
    const pct = p.overall_score !== undefined ? " with score " + Math.round(Number(p.overall_score) * 100) + "%" : "";
    return `${p.agent}'s work on "${p.subject}" was evaluated${pct} using the ${p.rubric} rubric`;
  },
  "metric.recorded": p => `${p.agent} recorded ${p.metric}: ${p.value}`,

  // System / Deploy
  "system.started":   p => `${p.service || "A service"} started up`,
  "system.stopped":   p => `${p.service || "A service"} shut down`,
  "deploy.started":   p => `Deployment started${p.service ? " for " + p.service : ""}`,
  "deploy.succeeded": p => `${p.service || "Deployment"} deployed successfully`,
  "deploy.failed":    p => `Deployment failed${p.service ? " for " + p.service : ""}${p.error ? ": " + p.error : ""}`,
  "alert.triggered":  p => `Alert triggered: ${p.message || p.name || "unknown"}`,
};

// - Template narration (O(1) lookup) --

export function narrateFromTemplate(action: string, payload: Record<string, unknown>): string | null {
  const fn = TEMPLATES[action];
  if (!fn) return null;
  try {
    return fn(payload);
  } catch (e: any) {
    log.warn({ msg: "broca_template_error", action, error: e.message });
    return null;
  }
}

// - LLM fallback narration --

export async function narrateWithLLM(
  agent: string,
  service: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<string> {
  if (!isLocalModelAvailable()) {
    return `${agent} performed ${action} on ${service}`;
  }

  const systemPrompt = "Convert this agent action into a single plain English sentence. Be concise. No markdown.";
  const userPrompt = `Agent: ${agent}, Service: ${service}, Action: ${action}, Details: ${JSON.stringify(payload)}`;

  try {
    const result = await callLocalModel(systemPrompt, userPrompt, { priority: "background" });
    return result.trim() || `${agent} performed ${action} on ${service}`;
  } catch (e: any) {
    log.warn({ msg: "broca_llm_narrate_failed", action, error: e.message });
    return `${agent} performed ${action} on ${service}`;
  }
}

// - Main narration: template first, LLM fallback --

export async function narrate(
  agent: string,
  service: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const fromTemplate = narrateFromTemplate(action, payload);
  if (fromTemplate) return fromTemplate;
  return narrateWithLLM(agent, service, action, payload);
}
