// ============================================================================
// SKILL DASHBOARD - REST API for skill management and monitoring
// Ported from OpenSpace dashboard_server.py
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import {
  getSkillById, getSkillTagsStmt, listSkillsStmt,
  getSkillStats, getSkillStatsByCategory, getSkillStatsByOrigin,
  listSkillsSorted, countAnalyses, listExecutionAnalyses,
  getSkillJudgmentsBySkill, getSkillParents, getSkillChildren,
  getSkillLineageUp, getSkillLineageDown, getSkillVersions,
} from "../db/index.ts";
import { PIPELINE_STAGES } from "./types.ts";

// --- Skill scoring (weighted quality metric) ---

function computeSkillScore(row: any): number {
  const selections = row.total_selections || 0;
  if (selections === 0) return 0;

  const completionRate = (row.total_completions || 0) / selections;
  const appliedRate = (row.total_applied || 0) / selections;
  const recency = Math.max(0, 1 - daysSince(row.last_updated) / 90);

  // Weighted: 50% completion, 30% applied, 20% recency
  return completionRate * 0.5 + appliedRate * 0.3 + recency * 0.2;
}

function daysSince(isoDate: string): number {
  try {
    return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
  } catch { return 999; }
}

// --- Route registration ---

export function registerDashboardRoutes(router: Router): void {

  // GET /api/v1/health
  router.get("/api/v1/health", () => {
    const stats = getSkillStats.get() as any;
    const analysisCount = (countAnalyses.get() as any)?.count ?? 0;
    return Promise.resolve(json({
      status: "ok",
      skills: { total: stats?.total ?? 0, active: stats?.active ?? 0 },
      analyses: analysisCount,
    }));
  });

  // GET /api/v1/overview
  router.get("/api/v1/overview", () => {
    const stats = getSkillStats.get() as any ?? {};
    const byCategory = getSkillStatsByCategory.all() as any[];
    const byOrigin = getSkillStatsByOrigin.all() as any[];
    const analysisCount = (countAnalyses.get() as any)?.count ?? 0;

    // Top skills by score
    const allSkills = listSkillsStmt.all(100) as any[];
    const scored = allSkills
      .map(s => ({ ...s, score: computeSkillScore(s) }))
      .sort((a, b) => b.score - a.score);

    const topSkills = scored.slice(0, 5).map(s => ({
      skill_id: s.skill_id,
      name: s.name,
      score: Math.round(s.score * 100) / 100,
      selections: s.total_selections,
      completions: s.total_completions,
    }));

    const recentSkills = [...allSkills]
      .sort((a, b) => (b.last_updated || "").localeCompare(a.last_updated || ""))
      .slice(0, 5)
      .map(s => ({
        skill_id: s.skill_id,
        name: s.name,
        origin: s.origin,
        last_updated: s.last_updated,
      }));

    return Promise.resolve(json({
      summary: {
        total_skills: stats.total ?? 0,
        active_skills: stats.active ?? 0,
        total_selections: stats.total_selections ?? 0,
        total_completions: stats.total_completions ?? 0,
        avg_completion_rate: stats.avg_completion_rate != null
          ? Math.round(stats.avg_completion_rate * 100) / 100
          : null,
        total_analyses: analysisCount,
      },
      by_category: byCategory,
      by_origin: byOrigin,
      top_skills: topSkills,
      recent_skills: recentSkills,
      pipeline_stages: PIPELINE_STAGES,
    }));
  });

  // GET /api/v1/skills
  router.get("/api/v1/skills", (req) => {
    const { url } = getContext(req);
    const sort = url.searchParams.get("sort") || "score";
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
    const activeOnly = url.searchParams.get("active_only") !== "false";
    const category = url.searchParams.get("category") || null;

    let skills: any[];
    if (sort === "score") {
      const all = listSkillsStmt.all(limit * 2) as any[];
      skills = all
        .filter(s => (!activeOnly || s.is_active) && (!category || s.category === category))
        .map(s => ({ ...s, score: computeSkillScore(s) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } else {
      skills = (listSkillsSorted.all(sort, sort, sort, limit) as any[])
        .filter(s => !category || s.category === category);
    }

    // Attach tags
    const result = skills.map(s => {
      const tags = (getSkillTagsStmt.all(s.skill_id) as any[]).map(r => r.tag);
      return { ...s, tags };
    });

    return Promise.resolve(json({ skills: result, count: result.length }));
  });

  // GET /api/v1/skills/stats
  router.get("/api/v1/skills/stats", () => {
    const byCategory = getSkillStatsByCategory.all() as any[];
    const byOrigin = getSkillStatsByOrigin.all() as any[];
    const stats = getSkillStats.get() as any ?? {};
    return Promise.resolve(json({
      total: stats.total ?? 0,
      active: stats.active ?? 0,
      by_category: byCategory,
      by_origin: byOrigin,
    }));
  });

  // GET /api/v1/skills/:id
  router.get("/api/v1/skills/:id", (req, params) => {
    const { requestId } = getContext(req);
    const skillId = params.id;
    const row = getSkillById.get(skillId) as any;
    if (!row) return Promise.resolve(errorResponse("Skill not found", 404, requestId));

    const tags = (getSkillTagsStmt.all(skillId) as any[]).map(r => r.tag);
    const parentRows = getSkillParents.all(skillId) as any[];
    const childRows = getSkillChildren.all(skillId) as any[];
    const judgments = getSkillJudgmentsBySkill.all(skillId, 20) as any[];

    const quality = {
      total_selections: row.total_selections,
      total_applied: row.total_applied,
      total_completions: row.total_completions,
      total_fallbacks: row.total_fallbacks || 0,
      applied_rate: row.total_selections > 0 ? row.total_applied / row.total_selections : 0,
      completion_rate: row.total_applied > 0 ? row.total_completions / row.total_applied : 0,
      effective_rate: row.total_selections > 0 ? row.total_completions / row.total_selections : 0,
      fallback_rate: row.total_selections > 0 ? (row.total_fallbacks || 0) / row.total_selections : 0,
    };

    return Promise.resolve(json({
      ...row,
      tags,
      parents: parentRows.map(r => r.parent_skill_id),
      children: childRows.map(r => r.skill_id),
      quality,
      recent_judgments: judgments,
      score: computeSkillScore(row),
    }));
  });

  // GET /api/v1/skills/:id/lineage
  router.get("/api/v1/skills/:id/lineage", (req, params) => {
    const { requestId } = getContext(req);
    const skillId = params.id;
    const row = getSkillById.get(skillId) as any;
    if (!row) return Promise.resolve(errorResponse("Skill not found", 404, requestId));

    // Get all ancestors and descendants
    const ancestors = getSkillLineageUp.all(skillId) as any[];
    const descendants = getSkillLineageDown.all(skillId) as any[];

    // Build nodes (deduplicated)
    const nodeMap = new Map<string, any>();
    for (const r of [...ancestors, ...descendants]) {
      if (!nodeMap.has(r.skill_id)) {
        nodeMap.set(r.skill_id, {
          id: r.skill_id,
          name: r.name,
          origin: r.origin,
          generation: r.generation,
          is_active: !!r.is_active,
          last_updated: r.last_updated,
        });
      }
    }

    // Build edges
    const edges: Array<{ from: string; to: string }> = [];
    for (const node of nodeMap.values()) {
      const parents = getSkillParents.all(node.id) as any[];
      for (const p of parents) {
        if (nodeMap.has(p.parent_skill_id)) {
          edges.push({ from: p.parent_skill_id, to: node.id });
        }
      }
    }

    return Promise.resolve(json({
      root: skillId,
      nodes: Array.from(nodeMap.values()),
      edges,
    }));
  });

  // GET /api/v1/skills/:id/source
  router.get("/api/v1/skills/:id/source", (req, params) => {
    const { requestId } = getContext(req);
    const skillId = params.id;
    const row = getSkillById.get(skillId) as any;
    if (!row) return Promise.resolve(errorResponse("Skill not found", 404, requestId));

    // Parse frontmatter from content
    let frontmatter: Record<string, string> = {};
    if (row.content?.startsWith("---")) {
      const endIdx = row.content.indexOf("\n---", 3);
      if (endIdx !== -1) {
        const fm = row.content.slice(4, endIdx);
        for (const line of fm.split("\n")) {
          const m = line.trim().match(/^(\w+)\s*:\s*(.+)$/);
          if (m) frontmatter[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
        }
      }
    }

    return Promise.resolve(json({
      skill_id: skillId,
      name: row.name,
      content: row.content,
      frontmatter,
      path: row.path,
    }));
  });

  // GET /api/v1/analyses
  router.get("/api/v1/analyses", (req) => {
    const { url } = getContext(req);
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    const rows = listExecutionAnalyses.all(limit) as any[];

    const analyses = rows.map(r => ({
      ...r,
      task_completed: !!r.task_completed,
      candidate_for_evolution: !!r.candidate_for_evolution,
      tool_issues: safeParseJSON(r.tool_issues, []),
      evolution_suggestions: safeParseJSON(r.evolution_suggestions, []),
    }));

    return Promise.resolve(json({ analyses, count: analyses.length }));
  });

  // GET /api/v1/workflows (placeholder -- returns analyses as workflows for now)
  router.get("/api/v1/workflows", (req) => {
    const { url } = getContext(req);
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
    const rows = listExecutionAnalyses.all(limit) as any[];
    return Promise.resolve(json({
      workflows: rows.map(r => ({
        id: r.task_id,
        timestamp: r.timestamp,
        completed: !!r.task_completed,
        analyzed_at: r.analyzed_at,
      })),
      count: rows.length,
    }));
  });
}

function safeParseJSON(val: string, fallback: any): any {
  try { return JSON.parse(val); }
  catch { return fallback; }
}
