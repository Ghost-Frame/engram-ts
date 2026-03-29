import type { Parser, ParsedDocument } from "../types.ts";

interface ClaudeMessage {
  sender: "human" | "assistant";
  text: string;
  created_at: string;
}

interface ClaudeConversation {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  chat_messages: ClaudeMessage[];
}

function toString(input: Buffer | string): string {
  return Buffer.isBuffer(input) ? input.toString("utf8") : input;
}

function isClaudeExport(data: unknown): data is ClaudeConversation[] {
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0];
  return (
    first !== null &&
    typeof first === "object" &&
    "uuid" in first &&
    "chat_messages" in first
  );
}

function buildText(messages: ClaudeMessage[]): string {
  return messages
    .map((m) => {
      const prefix = m.sender === "human" ? "Human" : "Assistant";
      return `${prefix}: ${m.text}`;
    })
    .join("\n");
}

async function* parseConversations(
  input: Buffer | string
): AsyncIterable<ParsedDocument> {
  const raw = toString(input);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  if (!isClaudeExport(data)) return;

  for (const conv of data) {
    const text = buildText(conv.chat_messages);
    yield {
      title: conv.name,
      text,
      metadata: {
        uuid: conv.uuid,
        updated_at: conv.updated_at,
      },
      source: "claude-export",
      timestamp: conv.created_at,
    };
  }
}

export const claudeParser: Parser = {
  name: "claude-export",

  detect(input: Buffer | string): boolean {
    const raw = toString(input);
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
    }
    return isClaudeExport(data);
  },

  parse(input: Buffer | string): AsyncIterable<ParsedDocument> {
    return parseConversations(input);
  },
};
