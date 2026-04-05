// ============================================================================
// EVAL SCORING - Compare golden vs candidate responses
// ============================================================================

import { repairAndParseJSON } from "../../src/llm/index.ts";

// --- JSON Structural Match ---
// Parse both as JSON, compare field presence and types recursively.
// Returns 0-1 score.

function countFields(obj: unknown, prefix = ""): Map<string, string> {
  const fields = new Map<string, string>();
  if (obj === null || obj === undefined) return fields;
  if (Array.isArray(obj)) {
    fields.set(prefix || "[]", "array");
    for (let i = 0; i < Math.min(obj.length, 3); i++) {
      for (const [k, v] of countFields(obj[i], `${prefix}[${i}]`)) {
        fields.set(k, v);
      }
    }
    return fields;
  }
  if (typeof obj === "object") {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      fields.set(path, typeof val);
      if (typeof val === "object" && val !== null) {
        for (const [k, v] of countFields(val, path)) {
          fields.set(k, v);
        }
      }
    }
  }
  return fields;
}

export function jsonStructuralMatch(golden: string, candidate: string): number {
  const goldenParsed = repairAndParseJSON(golden);
  const candidateParsed = repairAndParseJSON(candidate);

  if (goldenParsed === null && candidateParsed === null) return 1;
  if (goldenParsed === null || candidateParsed === null) return 0;

  const goldenFields = countFields(goldenParsed);
  const candidateFields = countFields(candidateParsed);

  if (goldenFields.size === 0) return candidateFields.size === 0 ? 1 : 0.5;

  let matched = 0;
  for (const [path, type] of goldenFields) {
    if (candidateFields.has(path)) {
      // Same path exists -- bonus if same type
      matched += candidateFields.get(path) === type ? 1 : 0.5;
    }
  }

  return matched / goldenFields.size;
}

// --- Semantic Similarity ---
// Embed both strings with bge-m3 and compute cosine similarity.

export async function semanticSimilarity(golden: string, candidate: string): Promise<number> {
  // Dynamic import to avoid loading ONNX when not needed
  const { embed, cosineSimilarity } = await import("../../src/embeddings/index.ts");

  const [goldenEmb, candidateEmb] = await Promise.all([
    embed(golden.substring(0, 512)),
    embed(candidate.substring(0, 512)),
  ]);

  return cosineSimilarity(goldenEmb, candidateEmb);
}

// --- Keyword Recall ---
// Extract "interesting" tokens from golden, check how many appear in candidate.
// Interesting = IPs, ports, paths, versions, dates, names, commands, numbers.

const KEYWORD_PATTERNS = [
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,       // IPs
  /\b\d{4}-\d{2}-\d{2}\b/g,                           // dates
  /\b(?:v?\d+\.\d+(?:\.\d+)?)\b/g,                    // versions
  /\b(?:\/[\w\-.]+){2,}\b/g,                           // paths
  /\b\d{2,5}\b/g,                                      // ports/numbers
  /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,                 // CamelCase names
  /\b[a-z]+(?:_[a-z]+){1,}\b/g,                        // snake_case names
];

function extractKeywords(text: string): Set<string> {
  const keywords = new Set<string>();
  for (const pattern of KEYWORD_PATTERNS) {
    const matches = text.matchAll(new RegExp(pattern.source, pattern.flags));
    for (const m of matches) {
      keywords.add(m[0].toLowerCase());
    }
  }
  return keywords;
}

export function keywordRecall(golden: string, candidate: string, keywords?: string[]): number {
  let target: Set<string>;
  if (keywords && keywords.length > 0) {
    target = new Set(keywords.map(k => k.toLowerCase()));
  } else {
    target = extractKeywords(golden);
  }

  if (target.size === 0) return 1; // nothing to recall

  const candidateLower = candidate.toLowerCase();
  let recalled = 0;
  for (const kw of target) {
    if (candidateLower.includes(kw)) recalled++;
  }

  return recalled / target.size;
}

// --- Composite Score ---

export interface ScoreResult {
  jsonMatch: number;
  semantic: number | null; // null if embedding unavailable
  keywordRecall: number;
  pass: boolean;
}

export async function scoreResponse(
  golden: string,
  candidate: string,
  thresholds = { json: 0.85, semantic: 0.75, keyword: 0.90 }
): Promise<ScoreResult> {
  const jsonMatch = jsonStructuralMatch(golden, candidate);
  const kw = keywordRecall(golden, candidate);

  let semantic: number | null = null;
  try {
    semantic = await semanticSimilarity(golden, candidate);
  } catch {
    // Embedding unavailable -- score on remaining metrics
  }

  const jsonPass = jsonMatch >= thresholds.json;
  const kwPass = kw >= thresholds.keyword;
  const semanticPass = semantic === null || semantic >= thresholds.semantic;

  return {
    jsonMatch,
    semantic,
    keywordRecall: kw,
    pass: jsonPass && kwPass && semanticPass,
  };
}
