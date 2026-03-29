import type { Parser } from "../types.ts";
import { markdownParser } from "./markdown.ts";
import { htmlParser } from "./html.ts";
import { claudeParser } from "./claude.ts";
import { chatgptParser } from "./chatgpt.ts";
import { messagesParser } from "./messages.ts";
import { csvParser } from "./csv.ts";
import { jsonlParser } from "./jsonl.ts";
import { pdfParser } from "./pdf.ts";
import { docxParser } from "./docx.ts";
import { zipParser } from "./zip.ts";

const registry = new Map<string, Parser>([
  ["markdown", markdownParser],
  ["plaintext", markdownParser],
  ["html", htmlParser],
  ["claude-export", claudeParser],
  ["chatgpt-export", chatgptParser],
  ["messages", messagesParser],
  ["csv", csvParser],
  ["jsonl", jsonlParser],
  ["pdf", pdfParser],
  ["docx", docxParser],
  ["zip", zipParser],
]);

export function getParser(format: string): Parser | undefined {
  return registry.get(format);
}

export function listParsers(): Parser[] {
  return [...new Set(registry.values())];
}
