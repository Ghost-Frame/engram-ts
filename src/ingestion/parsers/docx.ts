import mammoth from "mammoth";
import type { Parser, ParsedDocument } from "../types.ts";

export const docxParser: Parser = {
  name: "docx",

  detect(input: Buffer | string, meta?: { extension?: string; mime?: string }): boolean {
    if (meta?.extension) {
      return meta.extension.toLowerCase() === ".docx";
    }
    if (Buffer.isBuffer(input) && input.length >= 2) {
      // DOCX files are ZIP archives; ZIP magic bytes: 0x50 0x4B (PK)
      return input[0] === 0x50 && input[1] === 0x4b;
    }
    return false;
  },

  async *parse(input: Buffer | string): AsyncIterable<ParsedDocument> {
    if (typeof input === "string") {
      throw new Error("String input not supported: DOCX is a binary format. Pass a Buffer.");
    }

    const result = await mammoth.extractRawText({ buffer: input });
    const text = result.value;

    const headingMatch = text.match(/^#+ (.+)/m);
    const title = headingMatch
      ? headingMatch[1].trim()
      : text.slice(0, 60).trim();

    yield {
      title,
      text,
      metadata: {},
      source: "docx",
    };
  },
};
