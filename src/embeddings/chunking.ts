/**
 * Split text into overlapping chunks for embedding long content.
 * Short text returns a single-element array (fast path).
 */
export function chunkText(
  text: string,
  maxChars: number = 1440,
  overlapChars: number = 160,
  maxChunks: number = 6,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length && chunks.length < maxChunks) {
    let end = Math.min(start + maxChars, trimmed.length);

    if (end < trimmed.length) {
      const searchRegion = trimmed.slice(start, end);
      const sentenceBreak = findLastSentenceBreak(searchRegion, Math.floor(maxChars * 0.7));
      if (sentenceBreak > 0) {
        end = start + sentenceBreak;
      } else {
        const lastSpace = searchRegion.lastIndexOf(" ", maxChars);
        if (lastSpace > maxChars * 0.5) {
          end = start + lastSpace;
        }
      }
    }

    chunks.push(trimmed.slice(start, end).trim());

    const step = end - start - overlapChars;
    start += Math.max(step, Math.floor(maxChars * 0.3));
  }

  return chunks.filter(c => c.length > 0);
}

function findLastSentenceBreak(text: string, minPos: number): number {
  const re = /[.!?]\s/g;
  let lastMatch = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index >= minPos) {
      lastMatch = match.index + 1;
    }
  }
  return lastMatch;
}
