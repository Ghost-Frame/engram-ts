// ============================================================================
// PROMPTS DOMAIN - Route handlers (/prompt, /header)
// ============================================================================

import type { Router } from "../router/types.ts";
import { getContext, hasScope } from "../middleware/auth.ts";
import { json, errorResponse, safeError } from "../helpers/index.ts";
import { db } from "../db/index.ts";
import { getStaticMemories, trackAccessWithFSRS } from "../db/index.ts";
import { hybridSearch } from "../memory/search.ts";

export function registerPromptRoutes(router: Router): void {

  // GET /prompt
  router.get("/prompt", async (req) => {
    const { auth, url } = getContext(req);
    try {
      const format = url.searchParams.get("format") || "raw"; // raw, anthropic, openai, llamaindex
      const tokenBudget = Math.max(100, Math.min(Number(url.searchParams.get("tokens") || 4000), 128000));
      const context = url.searchParams.get("context") || "";

      const candidates: Array<any> = [];
      const staticFacts = getStaticMemories.all(auth.user_id) as Array<any>;
      for (const sf of staticFacts) candidates.push({ ...sf, score: 100 });
      if (context.trim()) {
        const semantic = await hybridSearch(context, 30, false, true, true, auth.user_id);
        for (const sr of semantic) {
          if (!candidates.find((c: any) => c.id === sr.id)) candidates.push({ ...sr, score: sr.score * 50 });
        }
      }
      const important = db.prepare(
        `SELECT id, content, category, importance, decay_score, confidence
         FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
         ORDER BY COALESCE(decay_score, importance) DESC LIMIT 1000`
      ).all(auth.user_id) as Array<any>;
      for (const m of important) {
        if (!candidates.find((c: any) => c.id === m.id)) candidates.push({ ...m, score: (m.decay_score || m.importance) * 2 });
      }
      candidates.sort((a: any, b: any) => b.score - a.score);

      const packed: string[] = [];
      let tokensUsed = 0;
      for (const c of candidates) {
        const t = Math.ceil(c.content.length / 4) + 5;
        if (tokensUsed + t > tokenBudget) continue;
        packed.push(`[${c.category}] ${c.content}`);
        tokensUsed += t;
        trackAccessWithFSRS(c.id);
      }

      const memoryBlock = packed.join("\n\n");

      let prompt: string;
      if (format === "anthropic") {
        prompt = `<context>
<engram-memories count="${packed.length}" tokens="~${tokensUsed}">
${memoryBlock}
</engram-memories>
</context>

The above are persistent memories from previous sessions. Use them to maintain continuity. If a memory contradicts the current conversation, prefer the conversation.`;
      } else if (format === "openai") {
        prompt = `# Persistent Memory (Engram)
The following are ${packed.length} memories from previous sessions (~${tokensUsed} tokens):

${memoryBlock}

Use these memories for context. If they conflict with the current conversation, prefer the conversation.`;
      } else if (format === "llamaindex") {
        prompt = `[MEMORY CONTEXT]
${memoryBlock}
[/MEMORY CONTEXT]`;
      } else {
        prompt = memoryBlock;
      }

      return json({
        prompt,
        format,
        memories_included: packed.length,
        tokens_estimated: tokensUsed,
      });
    } catch (e: any) {
      return safeError("Prompt generation", e);
    }
  });

  // POST /header
  router.post("/header", async (req) => {
    const { auth, body: rawBody } = getContext(req);
    try {
      const body = (rawBody || {}) as any;
      const actorModel = body.actor_model || "unknown";
      const actorRole = body.actor_role || "assistant"; // audit | verify | fix | assistant
      const taskContext = body.context || "";
      const limit = Math.min(Number(body.limit) || 10, 30);

      // Find recent memories from OTHER models to surface prior work
      const recentAll = db.prepare(
        `SELECT id, content, category, source, model, created_at, importance
         FROM memories WHERE is_forgotten = 0 AND is_archived = 0 AND is_latest = 1 AND user_id = ?
         ORDER BY created_at DESC LIMIT ?`
      ).all(auth.user_id, limit * 3) as any[];

      const priorModels = new Set<string>();
      const priorWork: any[] = [];
      for (const m of recentAll) {
        if (m.model && m.model !== actorModel) {
          priorModels.add(m.model);
          if (priorWork.length < limit) {
            priorWork.push({ id: m.id, model: m.model, source: m.source, category: m.category, summary: m.content.slice(0, 200), created_at: m.created_at });
          }
        }
      }

      // Build structured header
      const header: any = {
        actor_model: actorModel,
        actor_role: actorRole,
        prior_models: Array.from(priorModels),
        prior_work_count: priorWork.length,
        prior_work: priorWork,
        attribution_rule: "Memories tagged with a model field were stored by that model, not by you. Do not claim credit for work done by other models. When referencing prior work, attribute it to the model that performed it.",
      };

      // If context provided, find relevant attributed memories
      if (taskContext.trim()) {
        const relevant = await hybridSearch(taskContext, 10, false, true, false, auth.user_id);
        header.relevant_attributed = relevant.map(r => ({
          id: r.id, model: r.model || null, source: r.source, category: r.category,
          summary: r.content.slice(0, 200), score: Math.round((r.score || 0) * 1000) / 1000,
        }));
      }

      // Generate the text header for injection into system prompts
      const lines = [
        `# Engram Task Header`,
        `actor_model: ${actorModel}`,
        `actor_role: ${actorRole}`,
        `prior_models: [${Array.from(priorModels).join(", ")}]`,
        ``,
        `## Attribution Rule`,
        `You are ${actorModel}. Memories in Engram tagged with a different model were NOT created by you.`,
        `When you see "(by X via Y)" on a memory, model X stored it via client Y.`,
        `Do not take credit for prior work. Attribute it correctly when referencing it.`,
      ];

      if (priorWork.length > 0) {
        lines.push(``, `## Recent Work by Other Models`);
        for (const pw of priorWork.slice(0, 5)) {
          lines.push(`- [${pw.model}] ${pw.summary}${pw.summary.length >= 200 ? "..." : ""}`);
        }
      }

      return json({
        header: header,
        text: lines.join("\n"),
        actor_model: actorModel,
        prior_models: Array.from(priorModels),
      });
    } catch (e: any) {
      return safeError("Header generation", e);
    }
  });
}
