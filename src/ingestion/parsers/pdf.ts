import { PDFParse } from "pdf-parse";
import type { Parser, ParsedDocument } from "../types.ts";

export const pdfParser: Parser = {
  name: "pdf",

  detect(input: Buffer | string, meta?: { extension?: string; mime?: string }): boolean {
    if (meta?.extension) {
      return meta.extension.toLowerCase() === ".pdf";
    }
    if (Buffer.isBuffer(input) && input.length >= 4) {
      // %PDF magic bytes: 0x25 0x50 0x44 0x46
      return (
        input[0] === 0x25 &&
        input[1] === 0x50 &&
        input[2] === 0x44 &&
        input[3] === 0x46
      );
    }
    return false;
  },

  async *parse(input: Buffer | string): AsyncIterable<ParsedDocument> {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input as string);

    const parser = new PDFParse({ data: buffer });
    const [textResult, infoResult] = await Promise.all([
      parser.getText(),
      parser.getInfo(),
    ]);

    const info = infoResult.info as Record<string, unknown> | undefined;
    const titleRaw = info?.Title;
    const title: string =
      typeof titleRaw === "string" && titleRaw.trim().length > 0
        ? titleRaw.trim()
        : "PDF Document";

    yield {
      title,
      text: textResult.text,
      metadata: { ...info },
      source: "pdf",
    };
  },
};
