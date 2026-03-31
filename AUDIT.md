# Engram Security & Architecture Audit

**Instructions for Codex**: This is a read-only audit. Do NOT make edits. Analyze the entire codebase and return a structured report covering all sections below. Be specific -- cite file paths, line numbers, and code snippets for every finding.

---

## 1. Security Audit

### Authentication & Authorization
- Trace the full API key authentication flow from request to database validation
- Check for endpoints that bypass or skip authentication
- Audit the bootstrap token mechanism for first-run API key creation
- Check open-access mode (`ENGRAM_OPEN_ACCESS`) for unintended exposure -- does it properly block admin endpoints?
- Look for timing attacks in key comparison
- Check if API keys are stored hashed or plaintext in the database

### Input Validation & Injection
- Check all route handlers for SQL injection (libsql parameterized queries vs string interpolation)
- Check for command injection in any `exec`, `spawn`, or shell calls
- Audit `/ingest` and `/store` endpoints for content injection or oversized payloads
- Check if user-supplied content is sanitized before storage or used in any template/eval context
- Look for path traversal in any file-handling code (model downloads, data directory resolution)

### ONNX Model Security
- Audit model download flow in `src/embeddings/index.ts` and `src/reranker/index.ts` -- are URLs hardcoded or user-controllable?
- Check for TOCTOU race conditions in model file download (tmp file -> rename)
- Verify Worker thread isolation -- can a malicious ONNX model escape the worker sandbox?
- Check if custom model directories (`ENGRAM_MODEL_DIR`, `ENGRAM_RERANKER_MODEL_DIR`) are validated

### Network & Transport
- Check for SSRF vectors (does the server make outbound requests based on user input?)
- Audit CORS configuration
- Check if any endpoints expose internal state, stack traces, or debug info

### Dependencies
- Review `package.json` for known-vulnerable packages
- Check if `onnxruntime-node` version has known CVEs
- Audit the custom tokenizer implementations for buffer overflow or memory safety issues

---

## 2. Architecture Review

### Database Layer (`src/db/`)
- Audit the libsql schema for proper indexing
- Check the vector index rebuild mechanism (`rebuildVectorIndex`) for data loss potential
- Review embedding cache lifecycle -- memory leaks, stale entries, cache invalidation
- Check if database migrations are handled safely (what happens on schema version mismatch?)

### Embedding Pipeline (`src/embeddings/`)
- Trace the full embedding flow: text -> tokenizer -> ONNX -> vector -> storage
- Audit the custom SentencePiece Unigram tokenizer for correctness (Viterbi algorithm, NFKC normalization)
- Check mean pooling + L2 normalization implementation
- Review the Worker thread lifecycle: spawn, message passing, error recovery, cleanup
- What happens if the embedding worker crashes mid-batch?

### Reranker Pipeline (`src/reranker/`)
- Trace the full reranking flow: query + candidates -> tokenizer -> ONNX -> scores -> re-sort
- Audit the ByteLevel BPE tokenizer for correctness (bytes-to-unicode mapping, merge algorithm)
- Verify token_type_ids are correctly set (segment 0 for query, segment 1 for document)
- Check the 15-second timeout handling -- does it properly clean up pending requests?
- Review score blending formula in `crossEncoderRerank` -- is the boost calculation sound?

### Bulk Ingestion (`src/ingestion/`)
- Audit the job queue mechanism for race conditions
- Check memory pressure during large ingestion batches
- Review chunking strategy -- are there edge cases that produce empty or malformed chunks?
- Check error recovery -- what happens if ingestion fails mid-batch?

### Server & Routes (`src/routes/`, `src/server.ts`)
- Check for missing error handlers that could crash the process
- Audit rate limiting (is there any?)
- Review the modular route registration for conflicts or shadowing
- Check if streaming responses are properly cleaned up on client disconnect

---

## 3. Correctness & Reliability

### Edge Cases
- What happens when the database file is corrupted or missing?
- What happens when ONNX models fail to load?
- What happens on concurrent writes to the same memory entry?
- What happens if the embedding dimension changes (model swap) with existing data?
- What happens if the server runs out of disk space during model download?

### Memory & Performance
- Check for unbounded growth in any in-memory data structures
- Review the embedding cache for memory pressure with large datasets
- Check if Worker threads are properly terminated on server shutdown
- Audit `Promise` handling for unhandled rejections that could crash the process

### Configuration
- Check for environment variables that are used but not documented
- Check for configuration values that are silently ignored or have surprising defaults
- Review the interaction between config file, env vars, and CLI args

---

## 4. Improvement Opportunities

For each finding, rate priority as **critical**, **high**, **medium**, or **low** and explain why.

Focus on:
- Things that could cause data loss
- Things that could cause security breaches
- Things that could cause silent incorrect behavior
- Things that would make the codebase significantly more maintainable

Do NOT suggest:
- Style changes, formatting, or linting
- Adding comments or documentation to existing code
- Refactoring that doesn't fix a concrete problem
- Adding features that don't exist yet

---

## Output Format

Structure your report as:

```
## [Section Name]

### [Finding Title]
- **Severity**: critical / high / medium / low
- **File**: path/to/file.ts:line_number
- **Description**: What the issue is
- **Evidence**: Code snippet or trace showing the problem
- **Recommendation**: Specific fix (but do NOT implement it)
```
