# Bulk Ingestion Pipeline

**Date:** 2026-03-29
**Version:** 5.12.0
**Status:** Approved

## Problem

Engram only accepts single memory entries via `/store`. Users with large context bases (conversation exports, document collections, journals, blogs, work documents) have no way to load them into Engram without writing their own tooling or manually inserting entries into the database.

The existing `/ingest` endpoint handles URL/text extraction but is capped at 12K chars, processes one item at a time, and has its chunking/extraction logic inline in the 7K+ line route handler.

A Reddit commenter requested the ability to "generate and load memories from a large context base (for example, a long conversation or a batch of conversations) to allow for smooth migration."

## Solution

A dedicated ingestion module (`src/ingestion/`) that handles format detection, parsing, chunking, and memory creation from arbitrary input. Exposed via both an API endpoint (`POST /import/bulk`) and a CLI command (`engram-cli ingest`). Users choose between LLM extraction mode (high quality, slower) and raw mode (fast, each chunk stored directly as a memory).

The existing `/ingest` endpoint gets refactored to use this module, establishing the pattern for extracting logic out of the monolith route file.

## Architecture

### Module Structure

```
src/ingestion/
  index.ts          - Public API: ingest(input, options) -> IngestResult
  detect.ts         - Format detection (sniff from content/extension/MIME)
  chunker.ts        - Intelligent text chunking (respects document structure)
  parsers/
    index.ts        - Parser registry, dispatches to correct parser
    claude.ts       - Claude export JSON
    chatgpt.ts      - ChatGPT export JSON
    messages.ts     - Generic [{role, content}] array
    markdown.ts     - Markdown / plain text
    html.ts         - HTML (strip to text, preserve structure for chunking)
    pdf.ts          - PDF text extraction
    docx.ts         - DOCX text extraction
    csv.ts          - CSV with content column detection
    jsonl.ts        - One entry per line
  processors/
    extract.ts      - LLM extraction mode (chunks -> LLM fact extraction -> memories)
    raw.ts          - Raw mode (chunks -> memories directly)
```

### Parser Interface

Every parser implements:

```typescript
interface Parser {
  name: string;
  detect(input: Buffer | string, meta?: { extension?: string; mime?: string }): boolean;
  parse(input: Buffer | string): AsyncIterable<ParsedDocument>;
}

interface ParsedDocument {
  title: string;
  text: string;
  metadata: Record<string, unknown>;
  source: string;
  timestamp?: string;
}
```

`detect` returns true if this parser can handle the input. `parse` yields documents (a single file may yield many documents, e.g., a ChatGPT export contains multiple conversations).

### Chunker

Takes a `ParsedDocument`, splits into `Chunk` objects:

```typescript
interface Chunk {
  text: string;
  index: number;
  total: number;
  document_title: string;
  source: string;
  metadata: Record<string, unknown>;
}

interface ChunkerOptions {
  max_chunk_size?: number;    // default: 3000 chars
  overlap?: number;           // default: 200 chars
  respect_structure?: boolean; // default: true (break at paragraphs/headings)
}
```

When `respect_structure` is true, the chunker breaks at paragraph boundaries, heading boundaries, or sentence boundaries (in that priority order) rather than at arbitrary character positions. This reuses the chunking logic currently inline in `/ingest`, pulled out and generalized.

### Processors

Both processors take chunks and create memories through the existing store pipeline:

**Extract processor** (`extract.ts`):
- Sends each chunk to the LLM with the fact extraction prompt
- Creates one memory per extracted fact
- Each memory enters the `post_store` job queue (auto-link, personality signals, graph, dedup)
- Reuses the extraction logic currently inline in `/ingest`

**Raw processor** (`raw.ts`):
- Each chunk becomes a memory directly
- Content = chunk text, source = ingestion source label, category = user-specified or "general"
- Each memory enters the `post_store` job queue

### Processing Pipeline

```
Input (file/URL/text/ZIP)
  -> detect.ts (identify format)
  -> parser (format-specific, yields ParsedDocument[])
  -> chunker.ts (split into Chunk[], respecting structure)
  -> processor (extract or raw, per user choice)
    -> extract.ts: LLM fact extraction per chunk -> memories via store pipeline
    -> raw.ts: chunk text -> memory via store pipeline
  -> post_store job queue (auto-link, personality, graph, SimHash dedup, etc.)
```

## Supported Formats

### Chat Exports (native parsers)

**Claude export JSON:** Array of conversations, each with `uuid`, `name`, `created_at`, `updated_at`, and `chat_messages` array. Each message has `sender` (human/assistant), `text`, `created_at`. Parser yields one `ParsedDocument` per conversation.

**ChatGPT export JSON:** Array of conversations with `title`, `create_time`, `update_time`, and `mapping` object containing message nodes. Each node has `message.author.role`, `message.content.parts`. Parser walks the message tree and yields one `ParsedDocument` per conversation.

**Generic messages:** `[{role: string, content: string, timestamp?: string}]` array. Parser concatenates into a single `ParsedDocument` with role prefixes.

### Document Formats

**Markdown / plain text:** Detected by `.md`, `.txt`, `.text` extension or plain text MIME. Passed through as-is. Chunker respects heading hierarchy for split points.

**HTML:** Detected by `.html`, `.htm` extension or HTML content. Stripped using `html-to-text` (already a dependency). Nav, footer, header, script, style elements removed. Chunker respects heading/section structure.

**PDF:** Detected by `.pdf` extension or `%PDF` magic bytes. Text extracted via a PDF parsing library. Chunker respects page boundaries as natural split points.

**DOCX:** Detected by `.docx` extension or OOXML magic bytes. Text extracted from the document XML. Chunker respects paragraph/heading structure.

### Bulk Containers

**CSV:** Detected by `.csv` extension. Auto-detects which column contains the primary text content (longest average string length, or column named "content"/"text"/"body"/"message"). Each row yields one `ParsedDocument`.

**JSONL:** Detected by `.jsonl` extension. Each line parsed as JSON. Looks for `content`, `text`, `body`, or `message` field. Each line yields one `ParsedDocument`.

**ZIP:** Detected by `.zip` extension or PK magic bytes. Extracted, each file processed through format detection individually. Allows mixed-format bulk import.

## API Endpoint

```
POST /import/bulk
Content-Type: multipart/form-data OR application/json
Authorization: Bearer <key> (write scope required)

Parameters:
  files[]          - File uploads (multipart)
  text             - Raw text (JSON body)
  url              - URL to fetch (JSON body)
  format           - Force format (optional, auto-detect if omitted)
  mode             - "extract" | "raw" (default: "extract")
  source           - Source label (default: "import")
  category         - Memory category (default: "general")
  project_id       - Associate with project (optional)
  episode_id       - Associate with episode (optional)

Response (immediate, 202 Accepted):
{
  "job_id": "ingest_abc123",
  "chiasm_task_id": 42,
  "status": "processing",
  "axon_channel": "ingestion",
  "subscribe": "/axon/events?channel=ingestion"
}
```

Processing is async. The endpoint validates input, creates the Chiasm task, publishes `ingest.started` to Axon, queues the work, and returns immediately.

## CLI Command

```bash
engram-cli ingest <path> [options]
  --mode extract|raw        Processing mode (default: extract)
  --format <format>         Force format (default: auto-detect)
  --source <label>          Source label
  --category <category>     Memory category
  --recursive               Process directories recursively
  --progress                Show live progress (subscribes to Axon SSE)
```

For single files: calls the API endpoint.
For large files/directories: streams directly through the ingestion module to avoid HTTP upload size limits.

## Axon Events (Runtime)

The ingestion pipeline publishes to the `ingestion` channel:

| When | Type | Payload |
|------|------|---------|
| Job starts | `ingest.started` | `{job_id, source, format, file_count, mode}` |
| File parsed | `ingest.parsed` | `{job_id, file, format, chunk_count}` |
| Progress | `ingest.progress` | `{job_id, chunks_done, chunks_total, memories_created}` |
| Error | `ingest.error` | `{job_id, file, error, chunk_index}` |
| Complete | `ingest.completed` | `{job_id, total_memories, total_chunks, duration_ms, mode}` |

## Chiasm Task (Runtime)

- On job start: create task `{agent: "engram", project: "ingestion", title: "Ingest: <source>"}`
- On progress: update summary with current stats
- On complete/error: mark completed or blocked with final summary

## Refactoring `/ingest`

The existing `/ingest` endpoint (lines ~1880-2050 in `src/routes/index.ts`) gets refactored to call `src/ingestion/index.ts` instead of doing inline chunking and extraction. This:

- Removes ~170 lines of inline logic from the route handler
- Makes `/ingest` a thin wrapper around the ingestion module
- Establishes the pattern for future extraction of logic from the monolith route file
- Preserves the existing `/ingest` API contract (URL or text input, returns extracted facts)

## Implementation Coordination

This work is designed to be split across multiple parallel sessions coordinated through Chiasm and Axon.

**Axon channel:** `dev:engram-ingestion`

**Event types for coordination:**
- `task.claimed` - session announces it's working on a piece
- `task.completed` - session announces a piece is done, includes file paths and exported interface
- `task.blocked` - session is blocked on another piece
- `interface.published` - a module's public API is finalized, other modules can code against it

**Parallelization strategy:** The parser modules are fully independent of each other. The chunker, detect, and processor modules depend on the shared interfaces (`ParsedDocument`, `Chunk`) but not on each other's implementations. One session can build parsers while another builds the chunker and processors, as long as the interfaces are published to Axon first.

**Sequencing constraints:**
1. Interfaces (`ParsedDocument`, `Chunk`, `Parser`, `Processor`) must be defined first
2. After interfaces: parsers, chunker, detect, and processors can all be built in parallel
3. After those: the orchestrator (`index.ts`), API endpoint, and CLI depend on everything above
4. After endpoint: refactor existing `/ingest` to use the module

## Dependencies

**Existing (already in project):**
- `html-to-text` - HTML stripping (used by current `/ingest`)
- LLM client - fact extraction (used by current `/ingest`)
- Job queue - `post_store` pipeline

**New:**
- PDF parsing library (e.g., `pdf-parse` or `pdfjs-dist`)
- DOCX parsing library (e.g., `mammoth` or direct XML extraction)
- ZIP extraction (Node built-in `zlib` + a zip library, or `yauzl`)

## Out of Scope

- Real-time streaming ingestion (e.g., websocket feed of messages)
- Automatic scheduled re-ingestion of URLs
- Format conversion (e.g., DOCX to markdown)
- OCR for scanned PDFs or images
