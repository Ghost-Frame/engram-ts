import type { Parser, ParsedDocument } from "../types.ts";

const CONTENT_FIELDS = ["content", "text", "body", "message"] as const;

export const jsonlParser: Parser = {
  name: "jsonl",

  detect(_input: Buffer | string, meta?: { extension?: string; mime?: string }): boolean {
    return meta?.extension?.toLowerCase() === ".jsonl";
  },

  async *parse(input: Buffer | string): AsyncIterable<ParsedDocument> {
    const text = Buffer.isBuffer(input) ? input.toString("utf-8") : input;
    const lines = text.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;

      // Find content field
      let contentField: string | null = null;
      let contentValue: string | null = null;
      for (const field of CONTENT_FIELDS) {
        if (typeof parsed[field] === "string") {
          contentField = field;
          contentValue = parsed[field] as string;
          break;
        }
      }

      if (contentField === null || contentValue === null) continue;

      // Build title
      const title =
        typeof parsed.title === "string" && parsed.title
          ? parsed.title
          : contentValue.slice(0, 60);

      // Build metadata (all fields except content field)
      const metadata: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (key === contentField) continue;
        metadata[key] = value;
      }

      yield {
        title,
        text: contentValue,
        metadata,
        source: "jsonl",
      };
    }
  },
};
