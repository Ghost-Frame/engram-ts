// ============================================================================
// GEMINI CLI FALLBACK - Subprocess-based LLM call using Google AI Pro subscription
// ============================================================================

import { execFile } from "node:child_process";
import { log } from "../config/logger.ts";
import { GEMINI_CLI_PATH, GEMINI_CLI_ENABLED, GEMINI_CLI_TIMEOUT } from "../config/index.ts";

/**
 * Call Gemini CLI as a subprocess fallback.
 * Uses stdin to pass the prompt (avoids shell escaping issues).
 * Returns raw response text or null on failure.
 */
export async function callGeminiCLI(systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!GEMINI_CLI_ENABLED) return null;

  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  return new Promise((resolve) => {
    const child = execFile(
      GEMINI_CLI_PATH,
      ["--model", "gemini-2.5-flash"],
      { timeout: GEMINI_CLI_TIMEOUT, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          log.warn({ msg: "gemini_cli_error", error: error.message, stderr: stderr?.substring(0, 200) });
          resolve(null);
          return;
        }
        resolve(stdout.trim() || null);
      },
    );

    // Pass prompt via stdin
    if (child.stdin) {
      child.stdin.write(fullPrompt);
      child.stdin.end();
    }
  });
}
