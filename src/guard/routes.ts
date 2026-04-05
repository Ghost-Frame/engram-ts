// ============================================================================
// GUARD DOMAIN - Route handlers (/guard)
// ============================================================================

import { readFileSync, writeFileSync } from "fs";
import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { db, audit } from "../db/index.ts";
import { updateAgentTrust } from "../db/index.ts";
import { SIGNING_SECRET_FILE } from "../config/index.ts";
import { hybridSearch } from "../memory/search.ts";
import { callLocalModel, isLocalModelAvailable } from "../llm/local.ts";
import { signExecution, computeTrustScore, generateSigningSecret } from "../../sign/index.ts";

// Load or generate signing secret
let signingSecret: string;
try {
  signingSecret = readFileSync(SIGNING_SECRET_FILE, "utf8").trim();
} catch {
  signingSecret = generateSigningSecret();
  writeFileSync(SIGNING_SECRET_FILE, signingSecret, "utf8");
}

function refreshAgentTrust(agentId: number): void {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) return;
  const score = computeTrustScore({
    total_ops: agent.total_ops,
    successful_ops: agent.successful_ops,
    failed_ops: agent.failed_ops,
    guard_allows: agent.guard_allows,
    guard_warns: agent.guard_warns,
    guard_blocks: agent.guard_blocks,
  });
  updateAgentTrust.run(score, agent.total_ops, agent.successful_ops, agent.failed_ops, agent.guard_allows, agent.guard_warns, agent.guard_blocks, agentId);
}

function recordAgentGuard(agentId: number | null, signal: "allow" | "warn" | "block"): void {
  if (!agentId) return;
  const col = signal === "allow" ? "guard_allows" : signal === "warn" ? "guard_warns" : "guard_blocks";
  db.prepare(`UPDATE agents SET ${col} = ${col} + 1 WHERE id = ?`).run(agentId);
  refreshAgentTrust(agentId);
}

function heuristicGuard(action: string, rules: Array<{ content: string; score: number; importance: number }>): "allow" | "warn" | "block" {
  for (const r of rules) {
    const rl = r.content.toLowerCase();
    const hasProhibition = /\bnever\b|\bdo not\b|\bdon't\b|\bcritical\b|\bnot\b.*\ballowed\b|\bno\s+(?:purple|blue|indigo)\b/.test(rl);
    if (r.importance >= 10) return "warn";
    if (hasProhibition) return "warn";
  }
  return "allow";
}

export function registerGuardRoutes(router: Router): void {

  // POST /guard
  router.post("/guard", async (req) => {
    const { auth, clientIp, requestId, body: rawBody } = getContext(req);
    try {
      const body = (rawBody || {}) as any;
      const action = body.action;
      if (!action || typeof action !== "string") return errorResponse("action (string) required - describe what you are about to do");

      // Search static high-importance memories for conflicts
      const results = await hybridSearch(action, 20, false, false, true, auth.user_id);
      const rules = results.filter(r => r.is_static && r.importance >= 8);

      // Get agent trust score if identified
      let trustScore: number | null = null;
      if (auth.agent_id) {
        const agent = db.prepare("SELECT trust_score FROM agents WHERE id = ?").get(auth.agent_id) as any;
        if (agent) trustScore = agent.trust_score;
      }

      if (rules.length === 0) {
        // Record clean guard pass
        recordAgentGuard(auth.agent_id, "allow");
        const exec = auth.agent_id ? signExecution(signingSecret, auth.agent_id, "guard", { action }, { signal: "allow" }) : null;
        if (exec) audit(auth.user_id, "guard", null, null, "allow", clientIp, requestId, auth.agent_id, exec.execution_hash, exec.signature);
        return json({ signal: "allow", action, rules: [], message: "No conflicting rules found.", trust_score: trustScore, execution: exec });
      }

      // Ask LLM if any rules conflict with the proposed action
      let signal: "allow" | "warn" | "block" = "warn";
      let message = "";

      if (isLocalModelAvailable()) {
        try {
          const trustContext = trustScore !== null ? `\nAGENT TRUST SCORE: ${trustScore}/100 (${trustScore < 30 ? "LOW - be strict" : trustScore < 70 ? "MODERATE" : "HIGH - earned trust"})` : "";
          const rulesText = rules.slice(0, 5).map((r, i) => `RULE ${i + 1} (importance ${r.importance}): ${r.content}`).join("\n\n");
          const llmResult = await callLocalModel(
            `You are a guardrail system. Given an agent's PROPOSED ACTION and a set of RULES from memory, determine if the action conflicts with any rule. Respond with ONLY one of: BLOCK (action directly violates a rule), WARN (action is related to a rule and should proceed with caution), or ALLOW (no conflict). After the signal word, write a brief explanation on the same line.${trustContext ? " Factor the agent's trust score into borderline decisions - low-trust agents should get WARN or BLOCK more readily." : ""}`,
            `PROPOSED ACTION: ${action}\n\nRULES:\n${rulesText}${trustContext}`,
            { priority: "background" },
          );
          const first = llmResult.trim().split("\n")[0].toUpperCase();
          if (first.startsWith("BLOCK")) { signal = "block"; message = llmResult.trim(); }
          else if (first.startsWith("ALLOW")) { signal = "allow"; message = llmResult.trim(); }
          else { signal = "warn"; message = llmResult.trim(); }
        } catch {
          signal = heuristicGuard(action, rules);
          message = signal !== "allow" ? "Rule conflict detected (semantic + keyword heuristic). Review the rules before proceeding." : "No conflicts detected (LLM unavailable for deeper analysis).";
        }
      } else {
        signal = heuristicGuard(action, rules);
        // Trust-based escalation: low-trust agent + heuristic warn -> block
        if (trustScore !== null && trustScore < 30 && signal === "warn") {
          signal = "block";
          message = `Blocked: low trust score (${trustScore}) combined with rule conflict.`;
        } else {
          message = signal !== "allow" ? "Rule conflict detected (semantic + keyword heuristic). Review the rules before proceeding." : "No conflicts detected.";
        }
      }

      // Record guard result for trust scoring
      recordAgentGuard(auth.agent_id, signal);

      // Sign the guard execution
      const exec = auth.agent_id ? signExecution(signingSecret, auth.agent_id, "guard", { action }, { signal, rules_matched: rules.length }) : null;
      if (exec) audit(auth.user_id, "guard", null, null, signal, clientIp, requestId, auth.agent_id, exec.execution_hash, exec.signature);

      return json({
        signal,
        action,
        message,
        trust_score: trustScore,
        rules: rules.slice(0, 5).map(r => ({ id: r.id, content: r.content, importance: r.importance })),
        execution: exec,
      });
    } catch (e: any) {
      return safeError("guard check", e);
    }
  });
}
