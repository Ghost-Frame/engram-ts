import yauzl from "yauzl";
import { extname } from "node:path";
import type { Parser, ParsedDocument } from "../types.ts";
import { detectFormat } from "../detect.ts";
import { SupportedFormat } from "../types.ts";

// Sub-parsers imported directly to avoid circular dependency via registry
import { markdownParser } from "./markdown.ts";
import { htmlParser } from "./html.ts";
import { claudeParser } from "./claude.ts";
import { chatgptParser } from "./chatgpt.ts";
import { messagesParser } from "./messages.ts";
import { csvParser } from "./csv.ts";
import { jsonlParser } from "./jsonl.ts";
import { pdfParser } from "./pdf.ts";
import { docxParser } from "./docx.ts";

const SKIP_NAMES = new Set(["__MACOSX", ".DS_Store", "Thumbs.db"]);

function shouldSkip(filename: string): boolean {
  const parts = filename.split("/");
  for (const part of parts) {
    if (part.startsWith(".")) return true;
    if (SKIP_NAMES.has(part)) return true;
  }
  return false;
}

function parserForFormat(format: SupportedFormat): Parser | null {
  switch (format) {
    case SupportedFormat.Markdown:
    case SupportedFormat.PlainText:
      return markdownParser;
    case SupportedFormat.HTML:
      return htmlParser;
    case SupportedFormat.ClaudeExport:
      return claudeParser;
    case SupportedFormat.ChatGPTExport:
      return chatgptParser;
    case SupportedFormat.Messages:
      return messagesParser;
    case SupportedFormat.CSV:
      return csvParser;
    case SupportedFormat.JSONL:
      return jsonlParser;
    case SupportedFormat.PDF:
      return pdfParser;
    case SupportedFormat.DOCX:
      return docxParser;
    case SupportedFormat.ZIP:
      // Skip nested ZIPs to prevent zip bombs
      return null;
    default:
      return null;
  }
}

function readEntryToBuffer(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("no stream"));
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
}

function openZipFromBuffer(buf: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("failed to open zip"));
      resolve(zipfile);
    });
  });
}

export const zipParser: Parser = {
  name: "zip",

  detect(input: Buffer | string, meta?: { extension?: string; mime?: string }): boolean {
    if (meta?.extension) {
      return meta.extension.toLowerCase() === ".zip";
    }
    if (Buffer.isBuffer(input) && input.length >= 2) {
      // ZIP magic bytes: PK (0x50 0x4B)
      return input[0] === 0x50 && input[1] === 0x4b;
    }
    return false;
  },

  async *parse(input: Buffer | string): AsyncIterable<ParsedDocument> {
    if (!Buffer.isBuffer(input)) {
      throw new Error("zipParser.parse requires a Buffer input");
    }

    const zipfile = await openZipFromBuffer(input);

    const entries: yauzl.Entry[] = await new Promise((resolve, reject) => {
      const collected: yauzl.Entry[] = [];
      zipfile.readEntry();
      zipfile.on("entry", (entry: yauzl.Entry) => {
        collected.push(entry);
        zipfile.readEntry();
      });
      zipfile.on("end", () => resolve(collected));
      zipfile.on("error", reject);
    });

    for (const entry of entries) {
      const filename: string = entry.fileName;

      // Skip directories
      if (filename.endsWith("/")) continue;

      // Skip hidden files and known noise
      if (shouldSkip(filename)) continue;

      const ext = extname(filename);
      const format = detectFormat(Buffer.alloc(0), { extension: ext });

      // Skip nested ZIPs to prevent zip bombs
      if (format === SupportedFormat.ZIP) continue;

      const parser = parserForFormat(format);
      if (!parser) continue;

      const entryBuf = await readEntryToBuffer(zipfile, entry);

      // Text-based formats get string content; binary formats get Buffer
      const textFormats: SupportedFormat[] = [
        SupportedFormat.Markdown,
        SupportedFormat.PlainText,
        SupportedFormat.HTML,
        SupportedFormat.CSV,
        SupportedFormat.JSONL,
        SupportedFormat.Messages,
        SupportedFormat.ClaudeExport,
        SupportedFormat.ChatGPTExport,
      ];

      const content: Buffer | string = textFormats.includes(format)
        ? entryBuf.toString("utf-8")
        : entryBuf;

      yield* parser.parse(content);
    }
  },
};
