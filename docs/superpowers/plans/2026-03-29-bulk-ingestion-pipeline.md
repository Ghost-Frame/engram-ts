# Bulk Ingestion Pipeline -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Spec:** docs/superpowers/specs/2026-03-29-bulk-ingestion-pipeline.md
**Branch:** feat/bulk-ingestion
**Target directory:** src/ingestion/
**Scope:** Format detection, parsing, chunking, processing pipeline for bulk memory import from files, URLs, and text. Exposed via POST /import/bulk API and engram-cli ingest CLI command. Refactors existing /ingest inline logic into the new module.
**Status:** Planning

---

## Architecture Decisions

### AD-1: Module lives at src/ingestion/, not inside src/routes/

The existing /ingest logic is ~230 lines inline in the 7K+ line routes/index.ts. Extracting into a dedicated module establishes the pattern for breaking up the monolith. The orchestrator (src/ingestion/index.ts) is the single public API; routes just call it.

### AD-2: Parsers use AsyncIterable, not arrays

parse() returns AsyncIterable<ParsedDocument> so large files (ZIP with 1000 files, huge ChatGPT exports) stream documents through the pipeline without loading everything into memory at once.

### AD-3: Chunker is new, not reusing src/embeddings/chunking.ts

The existing chunkText() in src/embeddings/chunking.ts is designed for embedding chunk splitting (1440 chars, 160 overlap, max 6 chunks). The ingestion chunker needs different defaults (3000 chars, 200 overlap, no max chunks limit) and adds heading/paragraph structure awareness. It also returns Chunk objects with metadata, not bare strings. Writing a new module avoids coupling the two use cases.

### AD-4: Direct function imports for Axon/Chiasm, not HTTP

Since the ingestion module runs inside Engram itself, it imports publish from src/services/axon/bus.ts and createTask/updateTask from src/services/chiasm/engine.ts directly. No HTTP overhead.

### AD-5: Processors create memories through the same path as /store

Each memory goes through: embed -> insertMemory -> writeVec -> storeSimHash -> enqueueJob("post_store"). This ensures auto-linking, personality signals, graph updates, and SimHash dedup all fire for ingested memories, identical to manual /store.

### AD-6: API returns 202 immediately, processing is async

The POST /import/bulk endpoint validates input, creates a Chiasm task, publishes ingest.started to Axon, spawns the pipeline via setImmediate/queueMicrotask, and returns a job_id. Clients poll Axon SSE for progress.

### AD-7: New dependencies are pdf-parse, mammoth, yauzl

- pdf-parse: Well-maintained, pure JS, no native deps. Works with Node 22.
- mammoth: DOCX to text extraction. Lightweight, no native deps.
- yauzl: ZIP reading. Callback-based but wrappable. Preferred over adm-zip (yauzl is more correct with the ZIP spec).

### AD-8: CLI calls the API endpoint for single files, not the module directly

The CLI is a thin HTTP client (src/cli/index.ts). It does not import server internals. For single files, it POSTs to /import/bulk. The --progress flag subscribes to Axon SSE for live updates.

---

## Parallelization Strategy

**Wave 1 (sequential, must be first):**
- Task 1: Install dependencies
- Task 2: Types/interfaces module

**Wave 2 (all independent, can run in parallel after Wave 1):**
- Tasks 3-15: Chunker, detector, parser registry, all individual parsers, all processors

**Wave 3 (depends on all of Wave 2):**
- Task 18: Orchestrator
- Task 19: API endpoint
- Task 21: CLI command

**Wave 4 (depends on Wave 3):**
- Task 20: Refactor existing /ingest

---
## Task 1: Install new dependencies

- [ ] **Complete**

**Files:**
- Modify: `C:/Users/Zan/Projects/engram/package.json`

**Steps:**

- [ ] Run npm install for the three new dependencies:

```bash
cd C:/Users/Zan/Projects/engram && npm install pdf-parse mammoth yauzl
```

- [ ] Install type definitions for yauzl (pdf-parse and mammoth ship their own types):

```bash
cd C:/Users/Zan/Projects/engram && npm install -D @types/yauzl
```

- [ ] Verify all three are in package.json dependencies:

```bash
node -e "const p=require('./package.json'); ['pdf-parse','mammoth','yauzl'].forEach(d => console.log(d + ':', !!p.dependencies[d]))"
```

**Expected output:**
```
pdf-parse: true
mammoth: true
yauzl: true
```

**Commit:** `chore: add pdf-parse, mammoth, yauzl dependencies for bulk ingestion`

---

## Task 2: Types/interfaces module

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/types.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-types.test.ts`

**Test (write first):**

```typescript
// tests/ingestion-types.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("ingestion types", () => {
  it("exports all required interfaces and types", async () => {
    const mod = await import("../src/ingestion/types.ts");
    assert.equal(typeof mod.IngestMode, "object");
    assert.equal(mod.IngestMode.Extract, "extract");
    assert.equal(mod.IngestMode.Raw, "raw");
    assert.equal(typeof mod.SupportedFormat, "object");
    assert.ok(Array.isArray(mod.SUPPORTED_EXTENSIONS));
    assert.ok(mod.SUPPORTED_EXTENSIONS.includes(".md"));
    assert.ok(mod.SUPPORTED_EXTENSIONS.includes(".pdf"));
    assert.ok(mod.SUPPORTED_EXTENSIONS.includes(".zip"));
  });
});
```

**Test command:** `node --experimental-strip-types --test tests/ingestion-types.test.ts`

**Expected:** Test fails (module does not exist yet).

**Implementation:**

```typescript
// src/ingestion/types.ts

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
```

**Verify test passes:** `node --experimental-strip-types --test tests/ingestion-types.test.ts`

**Expected:** 1 test passing.

**Commit:** `feat(ingestion): add types and interfaces module`

---

## Task 3: Chunker module

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/chunker.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-chunker.test.ts`

**Test (write first):** Test chunkDocument with: short text (single chunk), empty text (empty array), long text (multiple chunks), paragraph boundary respect, custom chunk size/overlap, sequential index assignment. 6 test cases.

**Test command:** `node --experimental-strip-types --test tests/ingestion-chunker.test.ts`

**Implementation:** Generalize the inline chunking logic from routes/index.ts lines 1972-1994. Key algorithm:

1. Trim text. If empty, return []. If <= maxSize, return single Chunk.
2. Loop: set end = min(pos + maxSize, text.length)
3. If end < text.length and respectStructure:
   - Priority 1: Find last heading break (regex /
#{1,6}\s/) in region. Use if > 40% through.
   - Priority 2: Find last paragraph break (

). Use if > 50% through.
   - Priority 3: Find last sentence break (/[.!?]\s/). Use if > 50% through.
4. Push trimmed substring. Advance pos by (end - pos - overlap), minimum 30% of maxSize.
5. Map raw strings to Chunk objects with sequential index, total count, doc title, source, metadata.

**Defaults:** max_chunk_size=3000, overlap=200, respect_structure=true

**Exports:** `chunkDocument(doc: ParsedDocument, options?: ChunkerOptions): Chunk[]`

**Commit:** `feat(ingestion): add document chunker with structure-aware splitting`

---

## Task 4: Format detector

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/detect.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-detect.test.ts`

**Test (write first):** 16 test cases covering: extension detection (.md, .txt, .html, .pdf, .docx, .csv, .jsonl, .zip), magic bytes (PDF %PDF header, ZIP PK header), MIME type hints (text/html, application/pdf, text/csv), content sniffing (HTML doctype, Claude export JSON with uuid+chat_messages, ChatGPT export JSON with title+mapping, generic messages with role+content), fallback to plaintext.

**Test command:** `node --experimental-strip-types --test tests/ingestion-detect.test.ts`

**Implementation:** Priority chain: extension > MIME > magic bytes > content sniffing > plaintext fallback.

**Exports:** `detectFormat(input: Buffer | string, meta?: { extension?: string; mime?: string }): SupportedFormat`

**Key logic for JSON sniffing:**
- Parse as JSON. If array with length > 0, check first element.
- Claude: has `uuid` and `chat_messages` fields
- ChatGPT: has `title` and `mapping` fields
- Generic messages: has `role` and `content` fields

**Commit:** `feat(ingestion): add format detector`

---


## Task 5: Parser registry

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/index.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-registry.test.ts`

**Test:** Verify getParser returns a Parser for each format (markdown, plaintext, html, csv, jsonl, claude-export, chatgpt-export, messages, pdf, docx, zip). Verify undefined for unknown format. Verify listParsers returns >= 10 entries.

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-registry.test.ts`

**Implementation:** A Map<string, Parser> registry. Imports all parser modules from Tasks 6-15. NOTE: This task can only compile after all parser files exist.

**Exports:** `getParser(format: SupportedFormat): Parser | undefined`, `listParsers(): Parser[]`

**Key mapping:** plaintext reuses the markdown parser.

**Commit:** `feat(ingestion): add parser registry`

---

## Task 6: Markdown/plaintext parser

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/markdown.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-markdown.test.ts`

**Test:** detect returns true for .md/.txt. parse yields one ParsedDocument: title from first heading or first 60 chars, text = full input.

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-markdown.test.ts`

**Implementation:** detect checks extension (.md, .txt, .text) or MIME. parse yields one ParsedDocument. Title: first markdown heading (# line), else first 60 chars.

**Exports:** `markdownParser: Parser`

**Commit:** `feat(ingestion): add markdown/plaintext parser`

---

## Task 7: HTML parser

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/html.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-html.test.ts`

**Test:** detect returns true for .html/.htm and HTML content. parse strips scripts/styles/nav/footer/header/aside. Extracts title from <title> tag. Normalizes whitespace.

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-html.test.ts`

**Implementation:** Uses existing `html-to-text` dependency. Same htmlToText config as /ingest handler (routes/index.ts lines 1930-1939): wordwrap false, skip script/style/nav/footer/header/aside. Title from <title> tag via regex. Collapse triple+ newlines to double.

**Exports:** `htmlParser: Parser`

**Commit:** `feat(ingestion): add HTML parser`

---

## Task 8: Claude export parser

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/claude.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-claude.test.ts`

**Test:** detect returns true for JSON array where first element has uuid + chat_messages. parse yields one ParsedDocument per conversation. Title = conversation name. Text = messages with Human:/Assistant: prefixes. Timestamp from created_at. Metadata includes uuid.

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-claude.test.ts`

**Implementation:** Parse JSON array. For each conversation: title = name, timestamp = created_at, metadata = {uuid}. Concatenate chat_messages as role-prefixed lines. Yield one ParsedDocument per conversation.

**Claude export shape:** `[{uuid, name, created_at, updated_at, chat_messages: [{sender: "human"|"assistant", text, created_at}]}]`

**Exports:** `claudeParser: Parser`

**Commit:** `feat(ingestion): add Claude export parser`

---

## Task 9: ChatGPT export parser

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/chatgpt.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-chatgpt.test.ts`

**Test:** detect returns true for JSON array where first element has title + mapping. parse yields one ParsedDocument per conversation. Walks message tree correctly. Title from conversation title. Timestamp from create_time (unix epoch to ISO).

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-chatgpt.test.ts`

**Implementation:** Parse JSON. For each conversation: title from title field, timestamp from create_time (unix seconds -> ISO). Walk mapping object: each value has message.author.role and message.content.parts (string array). Filter out null messages and system messages. Sort by create_time if available. Concatenate as role-prefixed lines. Yield one ParsedDocument per conversation.

**ChatGPT export shape:** `[{title, create_time, update_time, mapping: {nodeId: {message: {author: {role}, content: {parts: [string]}}, parent, children}}}]`

**Exports:** `chatgptParser: Parser`

**Commit:** `feat(ingestion): add ChatGPT export parser`

---

## Task 10: Generic messages parser

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/messages.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-messages.test.ts`

**Test:** detect returns true for JSON array where first element has role + content. parse yields single ParsedDocument. Text concatenates messages with role prefixes. Title from first 60 chars.

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-messages.test.ts`

**Implementation:** Parse JSON array of {role, content, timestamp?}. Concatenate as "Role: content" separated by double newlines. Yield single ParsedDocument.

**Exports:** `messagesParser: Parser`

**Commit:** `feat(ingestion): add generic messages parser`

---

## Task 11: CSV parser

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/csv.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-csv.test.ts`

**Test:** detect returns true for .csv extension. parse yields one ParsedDocument per row. Auto-detects content column by: (1) column named content/text/body/message, or (2) column with longest average string length. Title = row number or value of a title/name column if present.

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-csv.test.ts`

**Implementation:** Simple CSV parser (split by newlines, split by commas, handle quoted fields). No external dependency needed for basic CSV. First row is header. Detect content column. Yield one ParsedDocument per data row with text = content column value, metadata = all other columns.

**Exports:** `csvParser: Parser`

**Commit:** `feat(ingestion): add CSV parser`

---

## Task 12: JSONL parser

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/jsonl.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-jsonl.test.ts`

**Test:** detect returns true for .jsonl extension. parse yields one ParsedDocument per line. Looks for content/text/body/message field in each JSON object. Skips blank lines and unparseable lines. Metadata = remaining fields.

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-jsonl.test.ts`

**Implementation:** Split input by newlines. Parse each line as JSON. Look for content field (try: content, text, body, message). Skip lines that fail JSON parse or have no content field. Yield one ParsedDocument per valid line.

**Exports:** `jsonlParser: Parser`

**Commit:** `feat(ingestion): add JSONL parser`

---

## Task 13: PDF parser

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/pdf.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-pdf.test.ts`

**Test:** detect returns true for .pdf extension and %PDF magic bytes. parse extracts text. Title from PDF metadata or filename.

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-pdf.test.ts`

**Implementation:** Uses `pdf-parse` dependency. Input must be Buffer. Call pdf(buffer), get data.text and data.info.Title. Yield single ParsedDocument.

**Exports:** `pdfParser: Parser`

**Commit:** `feat(ingestion): add PDF parser`

---

## Task 14: DOCX parser

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/docx.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-docx.test.ts`

**Test:** detect returns true for .docx extension. parse extracts text. Title from first heading or first 60 chars.

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-docx.test.ts`

**Implementation:** Uses `mammoth` dependency. Call mammoth.extractRawText({buffer}), get result.value. Yield single ParsedDocument.

**Exports:** `docxParser: Parser`

**Commit:** `feat(ingestion): add DOCX parser`

---

## Task 15: ZIP parser

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/parsers/zip.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-parser-zip.test.ts`

**Test:** detect true for .zip and PK magic bytes. parse extracts each file, detects format, delegates to correct parser. Skips directories and hidden files.

**Test command:** `node --experimental-strip-types --test tests/ingestion-parser-zip.test.ts`

**Implementation:** Uses `yauzl` dependency. Wrap callback API in Promise. For each entry: skip dirs (filename ends with /), skip __MACOSX/.DS_Store/Thumbs.db. Extract extension, call detectFormat, get parser, yield child documents.

**Exports:** `zipParser: Parser`

**Commit:** `feat(ingestion): add ZIP parser`

---

## Task 16: Raw processor

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/processors/raw.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-processor-raw.test.ts`

**Test:** Given Chunks and ProcessOptions, creates one memory per chunk. Verify correct embedding, insertion, and post_store job enqueue.

**Test command:** `node --experimental-strip-types --test tests/ingestion-processor-raw.test.ts`

**Implementation:** For each chunk:
1. Call checkSimHashDuplicate. If duplicate, skip (count in errors).
2. Call embedWithChunking(chunk.text) -> embArray, embeddingToBuffer(embArray) -> embBuffer
3. Call insertMemory.get(content, category, source, ...) with userId/spaceId from options
4. Call writeVec(id, embArray)
5. Call storeSimHash(id, simhash)
6. Call enqueueJob("post_store", {memoryId, content, category, userId, importance, embeddingBase64})
7. Track memories_created count

**Imports:** embedWithChunking/embeddingToBuffer from src/embeddings/index.ts, insertMemory/writeVec/db from src/db/index.ts, checkSimHashDuplicate/storeSimHash from src/memory/simhash.ts, enqueueJob from src/jobs/index.ts

**Exports:** `rawProcessor: Processor`

**Commit:** `feat(ingestion): add raw processor`

---

## Task 17: Extract processor

- [ ] **Complete**

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/processors/extract.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-processor-extract.test.ts`

**Test:** Sends each chunk to callLLM with extraction prompt. Creates one memory per extracted fact. Test with mocked LLM.

**Test command:** `node --experimental-strip-types --test tests/ingestion-processor-extract.test.ts`

**Implementation:** Pull extraction prompt and JSON parsing from routes/index.ts lines 2002-2043. For each chunk:
1. Build extraction prompt (source, chunk N/total, fact extraction rules, JSON output format)
2. Call callLLM(extractionPrompt, chunk.text) from src/llm/index.ts
3. Parse response: strip markdown fences, try JSON.parse, fallback regex for {facts:[]}
4. For each fact: embed, insertMemory (with fact.category, fact.importance, fact.is_static), writeVec, storeSimHash, enqueueJob
5. Apply tags from LLM response

**Key difference from raw:** Each chunk produces 0-N memories (one per extracted fact).

**Exports:** `extractProcessor: Processor`

**Commit:** `feat(ingestion): add extract processor`

---

## Task 18: Orchestrator

- [ ] **Complete**
- **Depends on:** Tasks 2-17

**Files:**
- Create: `C:/Users/Zan/Projects/engram/src/ingestion/index.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-orchestrator.test.ts`

**Test:** Verify the full pipeline: detect -> parse -> chunk -> process. Test with mock parsers and processors to verify correct wiring. Verify Axon events published at each stage. Verify Chiasm task created and updated.

**Test command:** `node --experimental-strip-types --test tests/ingestion-orchestrator.test.ts`

**Implementation:** The public API of the ingestion module.

**Exported function:** `async function ingest(input: Buffer | string, options: IngestOptions): Promise<IngestResult>`

**Pipeline:**
1. Generate job_id: `"ingest_" + randomUUID().slice(0, 8)`
2. Create Chiasm task via `createTask({agent: "engram", project: "ingestion", title: "Ingest: " + options.source})` (import from src/services/chiasm/engine.ts)
3. Publish `ingest.started` to Axon channel "ingestion" via `publish("ingestion", "engram", "ingest.started", {...})` (import from src/services/axon/bus.ts)
4. Detect format: `options.format || detectFormat(input, meta)`
5. Get parser: `getParser(format)`. If none, throw error.
6. Parse: iterate `parser.parse(input)`
7. For each ParsedDocument: chunk via `chunkDocument(doc, options.chunkerOptions)`
8. Publish `ingest.parsed` event per document
9. Select processor based on options.mode: `rawProcessor` or `extractProcessor`
10. Process chunks, accumulate results
11. Publish `ingest.progress` events periodically (every 10 chunks or 5 seconds)
12. On completion: publish `ingest.completed`, update Chiasm task to completed
13. On error: publish `ingest.error`, update Chiasm task to blocked
14. Return IngestResult

**Error handling:** Wrap each document/chunk in try/catch. Accumulate errors in result.errors array. Continue processing remaining documents on individual failure. Only fail the whole job if the format is unsupported or the parser throws on initial parse.

**Commit:** `feat(ingestion): add orchestrator`

---

## Task 19: API endpoint (POST /import/bulk)

- [ ] **Complete**
- **Depends on:** Task 18

**Files:**
- Modify: `C:/Users/Zan/Projects/engram/src/routes/index.ts`
- Create: `C:/Users/Zan/Projects/engram/tests/ingestion-api.test.ts`

**Test:** POST /import/bulk with text body returns 202 with job_id, chiasm_task_id, status, axon_channel. Verify auth (write scope required). Verify input validation (requires text, url, or files).

**Test command:** `node --experimental-strip-types --test tests/ingestion-api.test.ts`

**Implementation:** Add handler in routes/index.ts near the existing /ingest handler (after line ~2119). The endpoint:

1. Check auth: `hasScope(auth, "write")`
2. Parse body (JSON): extract text, url, format, mode, source, category, project_id, episode_id
3. Validate: at least one of text/url must be provided
4. If url: fetch content (reuse SSRF protection from existing /ingest, lines 1900-1912)
5. Build IngestOptions from request params
6. Call `ingest(input, options)` from src/ingestion/index.ts BUT do not await it. Use setImmediate to run async.
7. Return 202 immediately with:
   - job_id (from ingest function, generated before async work starts)
   - chiasm_task_id
   - status: "processing"
   - axon_channel: "ingestion"
   - subscribe: "/axon/events?channel=ingestion"

**Async pattern:** The ingest() function needs to be split: a sync part that creates the job_id and Chiasm task (returned immediately), and an async part that does the actual work. Alternatively, ingest() returns a Promise but the route handler calls it without await and catches errors via .catch().

**Suggested refactor of ingest():** Add `ingestAsync(input, options): { job_id, chiasm_task_id, promise: Promise<IngestResult> }` that returns the IDs synchronously and a promise for the work.

**Commit:** `feat(ingestion): add POST /import/bulk endpoint`

---

## Task 20: Refactor existing /ingest endpoint

- [ ] **Complete**
- **Depends on:** Task 19

**Files:**
- Modify: `C:/Users/Zan/Projects/engram/src/routes/index.ts`

**Purpose:** Replace the ~230 lines of inline chunking and extraction logic in /ingest (lines 1880-2119) with a thin wrapper that calls the ingestion module.

**Preserved behavior:** The /ingest API contract stays identical:
- Accepts {url, text, entity_ids, project_ids, episode_id, source}
- Returns {ingested, facts, source, title, chunks_processed, truncated}
- Requires write scope
- Requires LLM to be available

**Implementation:**
1. Keep the URL fetching and SSRF protection (lines 1896-1953) inline in the route -- this is route-level validation.
2. Replace the chunking logic (lines 1972-1994) with: `const chunks = chunkDocument({title, text: rawText, metadata: {}, source: ingestSource})`
3. Replace the extraction loop (lines 2000-2106) with: call extractProcessor.process(chunks, processOptions)
4. Map the processor result back to the existing response format

**Lines removed:** ~170 lines (chunking + extraction loop + inline prompt)
**Lines added:** ~20 lines (import + call + response mapping)

**Risk:** This changes a working endpoint. Run existing tests (tests/api.test.mjs) and verify /ingest still works.

**Test command:** `node --test tests/api.test.mjs` (existing tests)

**Commit:** `refactor: replace /ingest inline logic with ingestion module`

---

## Task 21: CLI command (engram-cli ingest)

- [ ] **Complete**
- **Depends on:** Task 19

**Files:**
- Modify: `C:/Users/Zan/Projects/engram/src/cli/index.ts`

**CLI structure (from reading src/cli/index.ts):** The CLI uses node:util parseArgs with a switch/case dispatch in main(). Commands are async functions (cmdStore, cmdSearch, etc). HTTP calls go through the api() helper. Global options: --url, --api-key, --json, --quiet, --timeout.

**New command:** `engram-cli ingest <path> [options]`

**Options to add to parseArgs:**
- `mode`: { type: "string" } (already exists, shared with search)
- `format`: { type: "string" } (new)
- `recursive`: { type: "boolean" } (new)
- `progress`: { type: "boolean" } (new)

**Implementation of cmdIngest(cfg, args, opts):**
1. Get path from args[0]. Validate it exists (readFileSync test).
2. Read file content as Buffer
3. Determine extension from path (path.extname)
4. POST to /import/bulk with body: {text: base64-encoded buffer, format, mode, source: filename, category}
   - NOTE: For binary files (PDF, DOCX, ZIP), the text field must be base64-encoded and the endpoint must handle decoding. Add a `encoding: "base64"` field to signal this.
5. Print job_id and chiasm_task_id
6. If --progress: poll `GET /axon/events?channel=ingestion&type=ingest.progress` in a loop, printing updates until ingest.completed or ingest.error event

**Help text addition:**
  `ingest <path>`       Ingest a file into memory

**Switch case addition:**
  case "ingest": await cmdIngest(cfg, restArgs, values); break;

**Edge cases:**
- File too large for JSON body: for files > 10MB, print a warning suggesting direct API upload or chunked processing
- Binary files: must be base64-encoded for JSON transport
- --recursive flag: for directories, use readdir + filter by SUPPORTED_EXTENSIONS, ingest each file

**Commit:** `feat(cli): add engram-cli ingest command`

---

## Verification Checklist

- [ ] All 19 test files pass: `node --experimental-strip-types --test tests/ingestion-*.test.ts`
- [ ] Existing tests still pass: `node --test tests/api.test.mjs`
- [ ] TypeScript compiles: `npx tsc --noEmit`
- [ ] /ingest endpoint still works (backward compatibility)
- [ ] POST /import/bulk accepts text and returns 202
- [ ] engram-cli ingest <file> works for a .md file
- [ ] Axon events published for each pipeline stage
- [ ] Chiasm task created and updated through lifecycle
- [ ] Memories created via ingestion appear in /search results
- [ ] SimHash dedup prevents duplicate memories from re-ingestion

---

## File Inventory

**New files (21):**
- src/ingestion/types.ts
- src/ingestion/chunker.ts
- src/ingestion/detect.ts
- src/ingestion/index.ts
- src/ingestion/parsers/index.ts
- src/ingestion/parsers/markdown.ts
- src/ingestion/parsers/html.ts
- src/ingestion/parsers/claude.ts
- src/ingestion/parsers/chatgpt.ts
- src/ingestion/parsers/messages.ts
- src/ingestion/parsers/csv.ts
- src/ingestion/parsers/jsonl.ts
- src/ingestion/parsers/pdf.ts
- src/ingestion/parsers/docx.ts
- src/ingestion/parsers/zip.ts
- src/ingestion/processors/raw.ts
- src/ingestion/processors/extract.ts
- tests/ingestion-types.test.ts
- tests/ingestion-chunker.test.ts
- tests/ingestion-detect.test.ts
- tests/ingestion-parser-registry.test.ts + 10 parser/processor test files

**Modified files (2):**
- src/routes/index.ts (add /import/bulk, refactor /ingest)
- src/cli/index.ts (add ingest command)
- package.json (add dependencies)
