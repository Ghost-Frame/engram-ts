export const IngestMode = { Extract: "extract", Raw: "raw" } as const;
export type IngestMode = (typeof IngestMode)[keyof typeof IngestMode];

export const SupportedFormat = {
  Markdown: "markdown", HTML: "html", PDF: "pdf", DOCX: "docx",
  CSV: "csv", JSONL: "jsonl", ClaudeExport: "claude-export",
  ChatGPTExport: "chatgpt-export", Messages: "messages",
  ZIP: "zip", PlainText: "plaintext",
} as const;
export type SupportedFormat = (typeof SupportedFormat)[keyof typeof SupportedFormat];

export const SUPPORTED_EXTENSIONS: string[] = [
  ".md", ".txt", ".text", ".html", ".htm", ".pdf",
  ".docx", ".csv", ".jsonl", ".json", ".zip",
];

export interface ParsedDocument {
  title: string;
  text: string;
  metadata: Record<string, unknown>;
  source: string;
  timestamp?: string;
}

export interface Chunk {
  text: string;
  index: number;
  total: number;
  document_title: string;
  source: string;
  metadata: Record<string, unknown>;
}

export interface Parser {
  name: string;
  detect(input: Buffer | string, meta?: { extension?: string; mime?: string }): boolean;
  parse(input: Buffer | string): AsyncIterable<ParsedDocument>;
}

export interface Processor {
  name: string;
  process(chunks: Chunk[], options: ProcessOptions): Promise<ProcessResult>;
}

export interface ProcessOptions {
  source: string;
  category: string;
  userId: number;
  spaceId: number | null;
  projectId?: number;
  episodeId?: number;
  entityIds?: number[];
}

export interface ProcessResult {
  memories_created: number;
  errors: string[];
}

export interface ChunkerOptions {
  max_chunk_size?: number;    // default: 3000
  overlap?: number;           // default: 200
  respect_structure?: boolean; // default: true
}

export interface IngestOptions {
  mode: IngestMode;
  format?: SupportedFormat;
  source: string;
  category: string;
  userId: number;
  spaceId: number | null;
  projectId?: number;
  episodeId?: number;
  entityIds?: number[];
  chunkerOptions?: ChunkerOptions;
}

export interface IngestResult {
  job_id: string;
  chiasm_task_id: number;
  status: "processing" | "completed" | "failed";
  total_documents: number;
  total_chunks: number;
  total_memories: number;
  errors: string[];
  duration_ms: number;
}

export interface IngestProgress {
  job_id: string;
  chunks_done: number;
  chunks_total: number;
  memories_created: number;
  current_file?: string;
}
