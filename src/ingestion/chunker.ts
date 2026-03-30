import type { ParsedDocument, Chunk, ChunkerOptions } from "./types.ts";

const DEFAULT_MAX_CHUNK_SIZE = 3000;
const DEFAULT_OVERLAP = 200;
const DEFAULT_RESPECT_STRUCTURE = true;

export function chunkDocument(
  doc: ParsedDocument,
  options?: ChunkerOptions
): Chunk[] {
  const maxSize = options?.max_chunk_size ?? DEFAULT_MAX_CHUNK_SIZE;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP;
  const respectStructure = options?.respect_structure ?? DEFAULT_RESPECT_STRUCTURE;

  const text = doc.text.trim();
  if (text.length === 0) return [];

  if (text.length <= maxSize) {
    return [
      {
        text,
        index: 0,
        total: 1,
        document_title: doc.title,
        source: doc.source,
        metadata: doc.metadata,
      },
    ];
  }

  const minAdvance = Math.floor(maxSize * 0.3);
  const rawChunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    let end = Math.min(pos + maxSize, text.length);

    if (end < text.length && respectStructure) {
      const window = text.slice(pos, end);

      // Priority 1: last heading break (/\n#{1,6}\s/) -- must be after 40% of window
      const headingRegex = /\n#{1,6}\s/g;
      let headingMatch: RegExpExecArray | null;
      let lastHeadingIndex = -1;
      while ((headingMatch = headingRegex.exec(window)) !== null) {
        lastHeadingIndex = headingMatch.index;
      }
      if (lastHeadingIndex > maxSize * 0.4) {
        end = pos + lastHeadingIndex;
      } else {
        // Priority 2: last paragraph break (\n\n) -- must be after 50% of window
        const paraIndex = window.lastIndexOf("\n\n");
        if (paraIndex > maxSize * 0.5) {
          end = pos + paraIndex;
        } else {
          // Priority 3: last sentence break (/[.!?]\s/) -- must be after 50% of window
          const sentenceRegex = /[.!?]\s/g;
          let sentenceMatch: RegExpExecArray | null;
          let lastSentenceIndex = -1;
          while ((sentenceMatch = sentenceRegex.exec(window)) !== null) {
            lastSentenceIndex = sentenceMatch.index + 1; // include the punctuation
          }
          if (lastSentenceIndex > maxSize * 0.5) {
            end = pos + lastSentenceIndex;
          }
        }
      }
    }

    const chunk = text.slice(pos, end).trim();
    if (chunk.length > 0) {
      rawChunks.push(chunk);
    }

    const advance = end - pos - overlap;
    pos += Math.max(advance, minAdvance);
  }

  const total = rawChunks.length;
  return rawChunks.map((chunkText, index) => ({
    text: chunkText,
    index,
    total,
    document_title: doc.title,
    source: doc.source,
    metadata: doc.metadata,
  }));
}
