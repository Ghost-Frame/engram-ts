// ============================================================================
// EVAL COLLECTOR - Tee callLocalModel inputs/outputs to golden dataset
// Enable with ENGRAM_EVAL_COLLECT=1
// ============================================================================

import { appendFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(__dirname, "../../data/eval-golden.jsonl");
const ENABLED = process.env.ENGRAM_EVAL_COLLECT === "1";

export interface GoldenEntry {
  call_site: string;
  system_prompt: string;
  user_prompt: string;
  response: string;
  timestamp: string;
  model: string;
  error?: string;
}

function inferCallSite(): string {
  const err = new Error();
  const stack = err.stack?.split("\n") || [];
  // Walk up the stack past collect.ts and local.ts frames
  for (const line of stack.slice(2)) {
    const trimmed = line.trim();
    if (trimmed.includes("collect.ts") || trimmed.includes("local.ts")) continue;
    // Extract filename:line from stack frame
    const match = trimmed.match(/(?:at\s+)?(?:\S+\s+\()?(.+?):(\d+):\d+\)?$/);
    if (match) {
      const file = match[1].replace(/\\/g, "/");
      // Get relative path from src/
      const srcIdx = file.indexOf("src/");
      const rel = srcIdx >= 0 ? file.substring(srcIdx) : file.split("/").slice(-2).join("/");
      return `${rel}:${match[2]}`;
    }
  }
  return "unknown";
}

function writeEntry(entry: GoldenEntry): void {
  try {
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    appendFileSync(GOLDEN_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Don't crash the app for eval logging failures
  }
}

type CallLocalModelFn = (
  systemPrompt: string,
  userPrompt: string,
  opts?: { priority?: "hot" | "background"; model?: string; timeout?: number }
) => Promise<string>;

export function wrapWithCollector(callFn: CallLocalModelFn): CallLocalModelFn {
  if (!ENABLED) return callFn;

  return async (systemPrompt, userPrompt, opts) => {
    const callSite = inferCallSite();
    const timestamp = new Date().toISOString();
    const model = opts?.model || process.env.OLLAMA_MODEL || "unknown";

    try {
      const response = await callFn(systemPrompt, userPrompt, opts);
      writeEntry({
        call_site: callSite,
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        response,
        timestamp,
        model,
      });
      return response;
    } catch (e: any) {
      writeEntry({
        call_site: callSite,
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        response: "",
        timestamp,
        model,
        error: e.message,
      });
      throw e; // Re-throw so caller behavior is unchanged
    }
  };
}

export { GOLDEN_PATH, ENABLED };
