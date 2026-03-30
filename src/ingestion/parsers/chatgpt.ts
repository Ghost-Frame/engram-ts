import type { Parser, ParsedDocument } from "../types.ts";

interface ChatGPTMessage {
  author: { role: string };
  content: { parts: string[] };
  create_time: number | null;
}

interface ChatGPTNode {
  message: ChatGPTMessage | null;
  parent: string | null;
  children: string[];
}

interface ChatGPTConversation {
  title: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, ChatGPTNode>;
}

function toString(input: Buffer | string): string {
  return Buffer.isBuffer(input) ? input.toString("utf8") : input;
}

function isChatGPTExport(data: unknown): data is ChatGPTConversation[] {
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0];
  return (
    first !== null &&
    typeof first === "object" &&
    "title" in first &&
    "mapping" in first
  );
}

function findRoot(mapping: Record<string, ChatGPTNode>): string | null {
  for (const [id, node] of Object.entries(mapping)) {
    if (node.parent === null) return id;
  }
  return null;
}

function walkTree(
  mapping: Record<string, ChatGPTNode>,
  startId: string
): ChatGPTMessage[] {
  const messages: ChatGPTMessage[] = [];
  const visited = new Set<string>();

  function walk(nodeId: string): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = mapping[nodeId];
    if (!node) return;

    const msg = node.message;
    if (
      msg !== null &&
      msg.author.role !== "system" &&
      msg.content.parts.length > 0
    ) {
      messages.push(msg);
    }

    for (const childId of node.children) {
      walk(childId);
    }
  }

  walk(startId);
  return messages;
}

function buildText(messages: ChatGPTMessage[]): string {
  return messages
    .map((m) => {
      const prefix = m.author.role === "user" ? "User" : "Assistant";
      const text = m.content.parts.join("").trim();
      return `${prefix}: ${text}`;
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

  if (!isChatGPTExport(data)) return;

  for (const conv of data) {
    const rootId = findRoot(conv.mapping);
    const messages = rootId ? walkTree(conv.mapping, rootId) : [];
    const text = buildText(messages);
    const timestamp = new Date(conv.create_time * 1000).toISOString();

    yield {
      title: conv.title,
      text,
      metadata: {
        update_time: conv.update_time,
      },
      source: "chatgpt-export",
      timestamp,
    };
  }
}

export const chatgptParser: Parser = {
  name: "chatgpt",

  detect(input: Buffer | string): boolean {
    const raw = toString(input);
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
    }
    return isChatGPTExport(data);
  },

  parse(input: Buffer | string): AsyncIterable<ParsedDocument> {
    return parseConversations(input);
  },
};
