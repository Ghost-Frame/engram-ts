import { SupportedFormat } from "./types.ts";

const EXT_MAP: Record<string, SupportedFormat> = {
  ".md":   SupportedFormat.Markdown,
  ".txt":  SupportedFormat.PlainText,
  ".text": SupportedFormat.PlainText,
  ".html": SupportedFormat.HTML,
  ".htm":  SupportedFormat.HTML,
  ".pdf":  SupportedFormat.PDF,
  ".docx": SupportedFormat.DOCX,
  ".csv":  SupportedFormat.CSV,
  ".jsonl": SupportedFormat.JSONL,
  ".zip":  SupportedFormat.ZIP,
};

const MIME_MAP: Record<string, SupportedFormat> = {
  "text/html":               SupportedFormat.HTML,
  "application/pdf":         SupportedFormat.PDF,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": SupportedFormat.DOCX,
  "text/csv":                SupportedFormat.CSV,
  "application/zip":         SupportedFormat.ZIP,
  "application/x-zip-compressed": SupportedFormat.ZIP,
  "text/plain":              SupportedFormat.PlainText,
};

function magicBytes(buf: Buffer): SupportedFormat | null {
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return SupportedFormat.PDF; // %PDF
  }
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return SupportedFormat.ZIP; // PK..
  }
  return null;
}

function sniffContent(text: string): SupportedFormat | null {
  const trimmed = text.trimStart();

  // HTML doctype or opening tag
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return SupportedFormat.HTML;
  }

  // JSON array sniffing for chat exports
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        if (first && typeof first === "object") {
          if ("uuid" in first && "chat_messages" in first) {
            return SupportedFormat.ClaudeExport;
          }
          if ("title" in first && "mapping" in first) {
            return SupportedFormat.ChatGPTExport;
          }
          if ("role" in first && "content" in first) {
            return SupportedFormat.Messages;
          }
        }
      }
    } catch {
      // Not valid JSON, continue
    }
  }

  return null;
}

export function detectFormat(
  input: Buffer | string,
  meta?: { extension?: string; mime?: string },
): SupportedFormat {
  // 1. Extension takes highest priority
  if (meta?.extension) {
    const ext = meta.extension.toLowerCase();
    if (ext in EXT_MAP) return EXT_MAP[ext];
  }

  // 2. MIME type
  if (meta?.mime) {
    const mime = meta.mime.toLowerCase().split(";")[0].trim();
    if (mime in MIME_MAP) return MIME_MAP[mime];
  }

  // 3. Magic bytes (Buffer only)
  if (Buffer.isBuffer(input)) {
    const magic = magicBytes(input);
    if (magic !== null) return magic;
  }

  // 4. Content sniffing (string or buffer converted to string)
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const sniffed = sniffContent(text);
  if (sniffed !== null) return sniffed;

  // 5. Fallback
  return SupportedFormat.PlainText;
}
