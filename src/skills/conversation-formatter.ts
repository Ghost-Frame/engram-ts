// ============================================================================
// CONVERSATION FORMATTER - Priority-based truncation for execution analysis
// Ported from OpenSpace skill_engine/conversation_formatter.py
// ============================================================================

export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name?: string;
  is_error?: boolean;
}

interface TruncatedMessage extends ConversationMessage {
  priority: number;
  truncated: boolean;
}

// Priority levels (lower = higher priority, never truncated first)
const P_USER_INSTRUCTION = 0;
const P_FINAL_ASSISTANT = 1;
const P_TOOL_ERRORS = 2;
const P_TOOL_CALLS = 3;
const P_ASSISTANT_REASONING = 4;
const P_TOOL_SUCCESS = 5;
const P_SYSTEM_GUIDANCE = 6;
const P_SKIP = 99;

function assignPriority(msg: ConversationMessage, index: number, total: number): number {
  if (msg.role === "user" && index === 0) return P_USER_INSTRUCTION;
  if (msg.role === "assistant" && index >= total - 2) return P_FINAL_ASSISTANT;
  if (msg.role === "tool" && msg.is_error) return P_TOOL_ERRORS;
  if (msg.role === "tool") return P_TOOL_SUCCESS;
  if (msg.role === "assistant") return P_ASSISTANT_REASONING;
  if (msg.role === "system") return P_SYSTEM_GUIDANCE;
  return P_TOOL_CALLS;
}

function truncateContent(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };
  const half = Math.floor(maxChars / 2);
  const text = content.slice(0, half) + "\n... [truncated] ...\n" + content.slice(-half);
  return { text, truncated: true };
}

/**
 * Format and truncate a conversation log for LLM analysis.
 * Uses priority-based truncation: high-priority messages (user instructions,
 * errors, final response) are preserved; low-priority (success results,
 * system guidance) are truncated first.
 */
export function formatConversation(
  messages: ConversationMessage[],
  maxChars: number = 50000,
): string {
  if (messages.length === 0) return "(no conversation recorded)";

  // Assign priorities
  const prioritized: TruncatedMessage[] = messages.map((msg, i) => ({
    ...msg,
    priority: assignPriority(msg, i, messages.length),
    truncated: false,
  }));

  // Calculate current size
  let totalChars = prioritized.reduce((sum, m) => sum + m.content.length, 0);

  // Truncate from lowest priority up until we fit
  if (totalChars > maxChars) {
    const byPriority = [...prioritized].sort((a, b) => b.priority - a.priority);

    for (const msg of byPriority) {
      if (totalChars <= maxChars) break;
      if (msg.priority === P_USER_INSTRUCTION) continue; // never truncate user instruction

      const excess = totalChars - maxChars;
      const targetLen = Math.max(200, msg.content.length - excess);
      const { text, truncated } = truncateContent(msg.content, targetLen);

      totalChars -= (msg.content.length - text.length);
      msg.content = text;
      msg.truncated = truncated;
    }
  }

  // Format output
  const lines: string[] = [];
  for (const msg of prioritized) {
    if (msg.priority === P_SKIP) continue;
    const roleLabel = msg.role === "tool"
      ? `[TOOL${msg.tool_name ? `: ${msg.tool_name}` : ""}${msg.is_error ? " ERROR" : ""}]`
      : `[${msg.role.toUpperCase()}]`;
    const truncLabel = msg.truncated ? " (truncated)" : "";
    lines.push(`${roleLabel}${truncLabel}\n${msg.content}`);
  }

  return lines.join("\n\n---\n\n");
}

/**
 * Format tool execution results for analysis.
 */
export function formatToolResults(
  results: Array<{ tool: string; success: boolean; output: string; error?: string; duration_ms?: number }>,
  maxPerResult: number = 2000,
): string {
  if (results.length === 0) return "(no tool executions)";

  return results.map(r => {
    const status = r.success ? "SUCCESS" : "FAILURE";
    const duration = r.duration_ms ? ` (${r.duration_ms}ms)` : "";
    const output = r.success
      ? truncateContent(r.output, maxPerResult).text
      : (r.error || r.output).slice(0, maxPerResult);
    return `[${r.tool}] ${status}${duration}\n${output}`;
  }).join("\n\n");
}
