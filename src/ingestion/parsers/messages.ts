import type { Parser, ParsedDocument } from "../types.ts";

interface MessageEntry {
  role: string;
  content: string;
  timestamp?: string;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const messagesParser: Parser = {
  name: "messages",

  detect(input: Buffer | string, _meta?: { extension?: string; mime?: string }): boolean {
    const text = Buffer.isBuffer(input) ? input.toString("utf-8") : input;
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
      const first = parsed[0];
      return (
        typeof first === "object" &&
        first !== null &&
        typeof first.role === "string" &&
        typeof first.content === "string"
      );
    } catch {
      return false;
    }
  },

  async *parse(input: Buffer | string): AsyncIterable<ParsedDocument> {
    const text = Buffer.isBuffer(input) ? input.toString("utf-8") : input;
    const messages: MessageEntry[] = JSON.parse(text);

    const parts = messages.map((m) => `${capitalize(m.role)}: ${m.content}`);
    const fullText = parts.join("\n\n");
    const title = fullText.slice(0, 60);

    yield {
      title,
      text: fullText,
      metadata: {
        message_count: messages.length,
      },
      source: "messages",
    };
  },
};
