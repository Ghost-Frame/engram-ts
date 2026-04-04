// ============================================================================
// SKILLS DOMAIN - Route handlers (enriched with full OpenSpace pipeline)
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { ENGRAM_SKILL_DIRS, OPENSPACE_API_KEY } from "../config/index.ts";
import { callLLM, isLLMAvailable } from "../llm/index.ts";
import {
  listSkillsStmt, getSkillById, softDeleteSkillStmt, getSkillTagsStmt,
  incrementSkillSelectionsStmt, getSkillByPath,
} from "../db/index.ts";
import {
  syncSkills, searchSkillsLocal, fixSkill, deriveSkillEvolution, captureSkill, evolve,
  uploadSkillToCloud, searchSkillsCloud,
} from "./index.ts";
import { analyzeExecution } from "./analyzer.ts";
import type { EvolutionContext, SkillRecord, SkillSearchResult } from "./types.ts";

export function registerSkillRoutes(router: Router): void {

  // POST /skills/sync
  router.post("/skills/sync", async (req) => {
    const { requestId, body: rawBody } = getContext(req);
    try {
      const body = (rawBody || {}) as any;
      const dirs: string[] = Array.isArray(body?.dirs) && body.dirs.length
        ? body.dirs.map(String)
        : ENGRAM_SKILL_DIRS;
      if (!dirs.length) return errorResponse("No skill directories configured or provided", 400, requestId);
      const result = await syncSkills(dirs);
      return json(result);
    } catch (e: any) {
      return safeError("skills sync", e, 500, requestId);
    }
  });

  // GET /skills
  router.get("/skills", (req) => {
    const { url } = getContext(req);
    const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
    const rows = listSkillsStmt.all(limit) as any[];
    return Promise.resolve(json({ skills: rows, count: rows.length }));
  });

  // POST /skills/search
  router.post("/skills/search", async (req) => {
    const { requestId, body: rawBody } = getContext(req);
    try {
      const body = (rawBody || {}) as any;
      const query = String(body?.query || "").trim();
      if (!query) return errorResponse("query is required", 400, requestId);
      const limit = Math.min(Number(body?.limit || 20), 100);
      const source = body?.source ?? "all";

      let results = await searchSkillsLocal(query, limit);
      if (source === "all" || source === "cloud") {
        const cloudResults = await searchSkillsCloud(query, 10);
        const cloudMapped = cloudResults.map(c => ({
          skill_id: c.skill_id, name: c.name, description: c.description,
          path: "", category: c.category, origin: c.origin,
          score: 0.5, source: "cloud" as const,
        }));
        const seen = new Set(results.map(r => r.skill_id));
        results = [...results, ...cloudMapped.filter(r => !seen.has(r.skill_id))].slice(0, limit);
      }
      return json({ results, count: results.length });
    } catch (e: any) {
      return safeError("skills search", e, 500, requestId);
    }
  });

  // POST /skills/upload
  router.post("/skills/upload", async (req) => {
    const { requestId, body: rawBody } = getContext(req);
    if (!OPENSPACE_API_KEY) return errorResponse("OPENSPACE_API_KEY not configured", 503, requestId);
    try {
      const body = (rawBody || {}) as any;
      const skill_dir = String(body?.skill_dir || "").trim();
      if (!skill_dir) return errorResponse("skill_dir is required", 400, requestId);
      const row = getSkillByPath.get(skill_dir) as any;
      if (!row) return errorResponse(`No skill found at path: ${skill_dir}. Run /skills/sync first.`, 404, requestId);
      const result = await uploadSkillToCloud(
        skill_dir, row.skill_id, row.name, row.description, row.content,
        body?.visibility ?? "public",
        { origin: body?.origin, parent_skill_ids: body?.parent_skill_ids, tags: body?.tags, change_summary: body?.change_summary },
      );
      return json({ uploaded: true, skill_id: row.skill_id, ...result });
    } catch (e: any) {
      return safeError("skills upload", e, 500, requestId);
    }
  });

  // POST /skills/execute - Full 6-stage pipeline
  router.post("/skills/execute", async (req) => {
    const { requestId, body: rawBody } = getContext(req);
    if (!isLLMAvailable()) return errorResponse("No LLM configured", 503, requestId);
    try {
      const body = (rawBody || {}) as any;
      const task = String(body?.task || "").trim();
      if (!task) return errorResponse("task is required", 400, requestId);
      const taskId = body?.task_id || `task_${Date.now()}`;
      const extraDirs: string[] = Array.isArray(body?.skill_dirs) ? body.skill_dirs.map(String) : [];
      const searchScope = body?.search_scope ?? "all";
      const runAnalysis = body?.analyze !== false;

      // Stage 1: Initialize
      if (extraDirs.length) await syncSkills(extraDirs);

      // Stage 2: Skill Selection
      let searchResults = await searchSkillsLocal(task, 5);
      if (searchScope === "all" && searchResults.length < 3) {
        const cloudResults = await searchSkillsCloud(task, 5);
        const seen = new Set(searchResults.map(r => r.skill_id));
        const cloudMapped = cloudResults.filter(c => !seen.has(c.skill_id)).map(c => ({
          skill_id: c.skill_id, name: c.name, description: c.description,
          path: "", category: c.category, origin: c.origin,
          score: 0.5, source: "cloud" as const,
        }));
        searchResults = [...searchResults, ...cloudMapped].slice(0, 5);
      }

      const topSkills = searchResults.slice(0, 3).map(r => {
        const row = getSkillById.get(r.skill_id) as any;
        if (row) incrementSkillSelectionsStmt.run(r.skill_id);
        return row ? { skill_id: r.skill_id, name: row.name, content: row.content } : null;
      }).filter(Boolean) as Array<{ skill_id: string; name: string; content: string }>;

      // Stage 3: Skill Phase -- execute with skill context
      const skillContext = topSkills.length
        ? topSkills.map(s => `<skill name="${s.name}">\n${s.content}\n</skill>`).join("\n\n")
        : "";
      const sysPrompt = skillContext
        ? `You are a skilled assistant. Use the following skills as guidance:\n\n${skillContext}`
        : "You are a skilled assistant.";

      let response: string;
      let usedFallback = false;

      try {
        response = await callLLM(sysPrompt, task);
      } catch (skillError: any) {
        // Stage 4: Tool Fallback -- retry without skill context
        usedFallback = true;
        response = await callLLM("You are a helpful assistant.", task);
      }

      const result: Record<string, any> = {
        response,
        skills_used: topSkills.map(s => s.name),
        task_id: taskId,
        used_fallback: usedFallback,
      };

      // Stage 5: Analysis (background, non-blocking)
      if (runAnalysis && topSkills.length > 0) {
        try {
          const analysis = await analyzeExecution({
            task_id: taskId,
            task_description: task,
            conversation: [
              { role: "user", content: task },
              { role: "assistant", content: response },
            ],
            selected_skills: searchResults.slice(0, 3),
          });

          if (analysis) {
            result.analysis = {
              task_completed: analysis.task_completed,
              execution_note: analysis.execution_note,
              suggestions: analysis.evolution_suggestions.length,
            };

            // Stage 6: Evolution (trigger if suggestions exist)
            if (analysis.evolution_suggestions.length > 0) {
              const suggestion = analysis.evolution_suggestions[0];
              const targetRecords = suggestion.target_skill_ids
                .map(id => getSkillById.get(id) as SkillRecord)
                .filter(Boolean);

              if (targetRecords.length > 0 || suggestion.evolution_type === "captured") {
                const ctx: EvolutionContext = {
                  trigger: "analysis",
                  suggestion,
                  skill_records: targetRecords,
                  skill_contents: targetRecords.map(r => r.content),
                  skill_dirs: targetRecords.map(r => r.path),
                  source_task_id: taskId,
                  recent_analyses: [analysis],
                  tool_issue_summary: analysis.tool_issues.join("; "),
                  metric_summary: "",
                };

                const evoResult = await evolve(ctx);
                result.evolution = evoResult;
              }
            }
          }
        } catch (analysisError: any) {
          result.analysis_error = analysisError.message;
        }
      }

      return json(result);
    } catch (e: any) {
      return safeError("skills execute", e, 500, requestId);
    }
  });

  // POST /skills/analyze - Standalone analysis endpoint
  router.post("/skills/analyze", async (req) => {
    const { requestId, body: rawBody } = getContext(req);
    if (!isLLMAvailable()) return errorResponse("No LLM configured", 503, requestId);
    try {
      const body = (rawBody || {}) as any;
      if (!body?.task_id) return errorResponse("task_id is required", 400, requestId);
      if (!body?.task_description) return errorResponse("task_description is required", 400, requestId);

      const analysis = await analyzeExecution({
        task_id: body.task_id,
        task_description: body.task_description,
        conversation: body.conversation || [],
        selected_skills: body.selected_skills || [],
        tool_results: body.tool_results,
        model: body.model,
      });

      if (!analysis) return errorResponse("Analysis failed -- check LLM configuration", 500, requestId);
      return json(analysis);
    } catch (e: any) {
      return safeError("skills analyze", e, 500, requestId);
    }
  });

  // POST /skills/derive - Derive new skill from parents
  router.post("/skills/derive", async (req) => {
    const { requestId, body: rawBody } = getContext(req);
    if (!isLLMAvailable()) return errorResponse("No LLM configured", 503, requestId);
    try {
      const body = (rawBody || {}) as any;
      const parentIds = body?.parent_skill_ids;
      if (!Array.isArray(parentIds) || parentIds.length === 0) {
        return errorResponse("parent_skill_ids array is required", 400, requestId);
      }
      const direction = String(body?.direction || "").trim();
      if (!direction) return errorResponse("direction is required", 400, requestId);

      const result = await deriveSkillEvolution(parentIds, direction, body?.source_task_id);
      return json({ derived: true, ...result });
    } catch (e: any) {
      return safeError("skills derive", e, 500, requestId);
    }
  });

  // POST /skills/capture - Capture novel pattern as new skill
  router.post("/skills/capture", async (req) => {
    const { requestId, body: rawBody } = getContext(req);
    if (!isLLMAvailable()) return errorResponse("No LLM configured", 503, requestId);
    try {
      const body = (rawBody || {}) as any;
      const direction = String(body?.direction || "").trim();
      if (!direction) return errorResponse("direction is required", 400, requestId);
      const baseDir = String(body?.base_dir || ENGRAM_SKILL_DIRS[0] || "./skills");

      const result = await captureSkill(direction, baseDir, body?.source_task_id);
      return json({ captured: true, ...result });
    } catch (e: any) {
      return safeError("skills capture", e, 500, requestId);
    }
  });

  // GET /skills/:name
  router.get("/skills/:name", (req, params) => {
    const { requestId } = getContext(req);
    const skillId = params.name;
    if (!skillId || skillId.includes("/")) return Promise.resolve(errorResponse("Invalid skill ID", 400, requestId));
    const row = getSkillById.get(skillId) as any;
    if (!row) return Promise.resolve(errorResponse("Skill not found", 404, requestId));
    const tags = (getSkillTagsStmt.all(skillId) as any[]).map(r => r.tag);
    return Promise.resolve(json({ ...row, tags }));
  });

  // GET /skills/:name/quality - Skill quality metrics
  router.get("/skills/:name/quality", (req, params) => {
    const { requestId } = getContext(req);
    const skillId = params.name;
    const row = getSkillById.get(skillId) as any;
    if (!row) return Promise.resolve(errorResponse("Skill not found", 404, requestId));

    const quality = {
      skill_id: skillId,
      total_selections: row.total_selections,
      total_applied: row.total_applied,
      total_completions: row.total_completions,
      total_fallbacks: row.total_fallbacks || 0,
      applied_rate: row.total_selections > 0 ? row.total_applied / row.total_selections : 0,
      completion_rate: row.total_applied > 0 ? row.total_completions / row.total_applied : 0,
      effective_rate: row.total_selections > 0 ? row.total_completions / row.total_selections : 0,
      fallback_rate: row.total_selections > 0 ? (row.total_fallbacks || 0) / row.total_selections : 0,
    };

    return Promise.resolve(json(quality));
  });

  // DELETE /skills/:name
  router.delete("/skills/:name", (req, params) => {
    const { requestId } = getContext(req);
    const skillId = params.name;
    if (!skillId || skillId.includes("/")) return Promise.resolve(errorResponse("Invalid skill ID", 400, requestId));
    softDeleteSkillStmt.run(skillId);
    return Promise.resolve(json({ deleted: true, skill_id: skillId }));
  });

  // POST /skills/:name/fix
  router.post("/skills/:name/fix", async (req, params) => {
    const { requestId, body: rawBody } = getContext(req);
    if (!isLLMAvailable()) return errorResponse("No LLM configured", 503, requestId);
    try {
      const skillId = params.name;
      const body = (rawBody || {}) as any;
      const direction = String(body?.direction || "").trim();
      if (!direction) return errorResponse("direction is required", 400, requestId);
      const row = getSkillById.get(skillId) as any;
      if (!row) return errorResponse("Skill not found", 404, requestId);
      const patched = await fixSkill(skillId, row.path, direction, body?.source_task_id);
      const updated = getSkillById.get(skillId) as any;
      return json({ skill_id: skillId, name: updated?.name, patched: true, content: patched });
    } catch (e: any) {
      return safeError("skills fix", e, 500, requestId);
    }
  });
}
