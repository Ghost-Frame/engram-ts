import type { Parser, ParsedDocument } from "../types.ts";

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let field = "";
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            // Escaped quote
            field += '"';
            i += 2;
          } else {
            // End of quoted field
            i++; // skip closing quote
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      fields.push(field);
      // skip comma
      if (i < line.length && line[i] === ",") i++;
    } else {
      // Unquoted field
      const start = i;
      while (i < line.length && line[i] !== ",") {
        i++;
      }
      fields.push(line.slice(start, i));
      if (i < line.length && line[i] === ",") i++;
    }
  }
  return fields;
}

const CONTENT_COLUMN_NAMES = ["content", "text", "body", "message"];
const TITLE_COLUMN_NAMES = ["title", "name"];

function detectContentColumn(headers: string[], rows: string[][]): number {
  // First: check by name
  for (const name of CONTENT_COLUMN_NAMES) {
    const idx = headers.findIndex((h) => h.toLowerCase() === name);
    if (idx !== -1) return idx;
  }

  // Fallback: longest average string length
  const averages = headers.map((_, colIdx) => {
    const lengths = rows.map((row) => (row[colIdx] ?? "").length);
    return lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
  });

  let maxIdx = 0;
  for (let i = 1; i < averages.length; i++) {
    if (averages[i] > averages[maxIdx]) maxIdx = i;
  }
  return maxIdx;
}

function detectTitleColumn(headers: string[]): number {
  for (const name of TITLE_COLUMN_NAMES) {
    const idx = headers.findIndex((h) => h.toLowerCase() === name);
    if (idx !== -1) return idx;
  }
  return -1;
}

export const csvParser: Parser = {
  name: "csv",

  detect(_input: Buffer | string, meta?: { extension?: string; mime?: string }): boolean {
    return meta?.extension?.toLowerCase() === ".csv";
  },

  async *parse(input: Buffer | string): AsyncIterable<ParsedDocument> {
    const text = Buffer.isBuffer(input) ? input.toString("utf-8") : input;
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length < 2) return;

    const headers = parseCSVLine(lines[0]);
    const rows = lines.slice(1).map((l) => parseCSVLine(l));

    const contentIdx = detectContentColumn(headers, rows);
    const titleIdx = detectTitleColumn(headers);

    for (let rowNum = 0; rowNum < rows.length; rowNum++) {
      const row = rows[rowNum];
      const contentText = row[contentIdx] ?? "";

      const title =
        titleIdx !== -1 && row[titleIdx]
          ? row[titleIdx]
          : `Row ${rowNum + 1}`;

      const metadata: Record<string, unknown> = {};
      for (let colIdx = 0; colIdx < headers.length; colIdx++) {
        if (colIdx === contentIdx) continue;
        metadata[headers[colIdx]] = row[colIdx] ?? "";
      }

      yield {
        title,
        text: contentText,
        metadata,
        source: "csv",
      };
    }
  },
};
