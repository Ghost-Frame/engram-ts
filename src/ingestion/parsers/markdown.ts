import type { Parser, ParsedDocument } from "../types.ts";

export const markdownParser: Parser = {
  name: "markdown",

  detect(_input: Buffer | string, meta?: { extension?: string; mime?: string }): boolean {
    if (meta?.extension) {
      return [".md", ".txt", ".text"].includes(meta.extension.toLowerCase());
    }
    return false;
  },

  async *parse(input: Buffer | string): AsyncIterable<ParsedDocument> {
    const text = Buffer.isBuffer(input) ? input.toString("utf-8") : input;

    const headingMatch = text.match(/^#{1,6}\s+(.+)$/m);
    const title = headingMatch ? headingMatch[1].trim() : text.slice(0, 60);

    yield {
      title,
      text,
      metadata: {},
      source: "markdown",
    };
  },
};
