import { htmlToText } from "html-to-text";
import type { Parser, ParsedDocument } from "../types.ts";

export const htmlParser: Parser = {
  name: "html",

  detect(input: Buffer | string, meta?: { extension?: string; mime?: string }): boolean {
    if (meta?.extension) {
      return [".html", ".htm"].includes(meta.extension.toLowerCase());
    }
    const str = Buffer.isBuffer(input) ? input.toString("utf-8") : input;
    const trimmed = str.trimStart();
    return trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html");
  },

  async *parse(input: Buffer | string): AsyncIterable<ParsedDocument> {
    const html = Buffer.isBuffer(input) ? input.toString("utf-8") : input;

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "Untitled";

    const raw = htmlToText(html, {
      wordwrap: false,
      selectors: [
        { selector: "script", format: "skip" },
        { selector: "style", format: "skip" },
        { selector: "nav", format: "skip" },
        { selector: "footer", format: "skip" },
        { selector: "header", format: "skip" },
        { selector: "aside", format: "skip" },
      ],
    });

    const text = raw
      .replace(/\n{3,}/g, "\n\n")
      .replace(/ {2,}/g, " ");

    yield {
      title,
      text,
      metadata: {},
      source: "html",
    };
  },
};
