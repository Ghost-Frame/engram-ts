// ============================================================================
// DECOMPOSITION FALLBACK - Tier 2 (rule-based NLP) and Tier 3 (template) decomposition
// Used when LLM and Gemini CLI are both unavailable.
// Tier 2 quality: ~55% of LLM. Tier 3 quality: ~35% of LLM.
// ============================================================================

import { DECOMPOSITION_MAX_FACTS } from "../config/index.ts";

export interface DecompositionResult {
  facts: string[];
  skip: boolean;
}

// Filler phrases to strip from sentence starts
const FILLER_PREFIXES = [
  "so ", "well ", "basically ", "actually ", "honestly ",
  "like ", "i mean ", "you know ", "anyway ",
];

// Meta-sentences to skip entirely
const META_STOPLIST = [
  "let me explain", "as i mentioned", "in summary", "to summarize",
  "as we discussed", "like i said", "to be clear", "for context",
  "moving on", "on another note", "by the way", "speaking of which",
];

// Technical value patterns to preserve as standalone facts
const TECHNICAL_PATTERNS = [
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/,  // IP:port
  /\b(?:\/[\w.-]+)+\b/,                                   // Unix paths
  /https?:\/\/[^\s,)]+/,                                  // URLs
  /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/,                // Versions
  /`[^`]+`/,                                              // Backtick commands
];

/**
 * Tier 3 -- Template-based decomposition.
 * Split on sentence boundaries, filter, strip filler.
 * Quality: ~35% of LLM.
 */
export function decomposeTemplate(content: string): DecompositionResult {
  // 1. Split on sentence boundaries + newlines
  const rawSentences = content
    .split(/[.!?]+\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length >= 10 && s.length <= 300);

  // 2. Strip leading filler
  const cleaned = rawSentences.map(s => {
    let lower = s.toLowerCase();
    for (const filler of FILLER_PREFIXES) {
      if (lower.startsWith(filler)) {
        s = s.slice(filler.length).replace(/^[,\s]+/, "");
        break;
      }
    }
    return s;
  }).filter(s => s.length >= 10);

  if (cleaned.length <= 1) {
    return { facts: [], skip: true };
  }

  return {
    facts: cleaned.slice(0, DECOMPOSITION_MAX_FACTS),
    skip: false,
  };
}

/**
 * Tier 2 -- Rule-based NLP decomposition.
 * Sentence splitting + conjunction splitting + pronoun resolution + technical value preservation.
 * Quality: ~55% of LLM. Strong on technical content.
 */
export function decomposeRuleBased(content: string): DecompositionResult {
  // 1. Sentence splitting (same as Tier 3)
  const rawSentences = content
    .split(/[.!?]+\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length >= 10 && s.length <= 300);

  // 2. Filter meta-sentences
  const filtered = rawSentences.filter(s => {
    const lower = s.toLowerCase();
    return !META_STOPLIST.some(meta => lower.includes(meta));
  });

  // 3. Strip filler
  let sentences = filtered.map(s => {
    let lower = s.toLowerCase();
    for (const filler of FILLER_PREFIXES) {
      if (lower.startsWith(filler)) {
        s = s.slice(filler.length).replace(/^[,\s]+/, "");
        break;
      }
    }
    return s;
  }).filter(s => s.length >= 10);

  // 4. Conjunction splitting: split on " and ", " but ", " while " if both clauses have subject+verb
  const expanded: string[] = [];
  const conjunctionPattern = /\s+(?:and|but|while|however|although)\s+/i;
  const hasSubjectVerb = (clause: string) => {
    // Simple heuristic: clause has at least 3 words
    return clause.split(/\s+/).length >= 3;
  };

  for (const sentence of sentences) {
    const parts = sentence.split(conjunctionPattern);
    if (parts.length > 1 && parts.every(p => hasSubjectVerb(p.trim()))) {
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.length >= 10) expanded.push(trimmed);
      }
    } else {
      expanded.push(sentence);
    }
  }

  // 5. Pronoun resolution: if clause starts with it/this/that/they and prior clause has a capitalized noun or quoted string
  const resolved: string[] = [];
  let lastContext = "";
  const pronounStart = /^(it|this|that|they|these|those)\s/i;
  const contextPattern = /\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*)|"([^"]+)"|'([^']+)'/;
  const commonWords = new Set(["The", "It", "This", "That", "They", "We", "He", "She", "If", "When", "But", "And", "So", "My", "Our", "Its", "There", "Here", "Then", "Now", "Also"]);

  for (const sentence of expanded) {
    const ctxMatch = sentence.match(contextPattern);
    if (ctxMatch) {
      const candidate = ctxMatch[1] || ctxMatch[2] || ctxMatch[3] || "";
      if (candidate && !commonWords.has(candidate)) {
        lastContext = candidate;
      }
    }

    if (pronounStart.test(sentence) && lastContext) {
      // Prepend context: "Regarding [context], [sentence]"
      resolved.push(`Regarding ${lastContext}, ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`);
    } else {
      resolved.push(sentence);
    }
  }

  // 6. Technical value preservation: sentences with IPs, URLs, paths, versions, commands
  // are high-value -- re-add any that were lost during conjunction splitting
  const hasTechnicalValue = (s: string) => TECHNICAL_PATTERNS.some(p => p.test(s));
  for (const sentence of sentences) {
    if (hasTechnicalValue(sentence) && !resolved.some(r => r.includes(sentence) || sentence.includes(r))) {
      resolved.push(sentence);
    }
  }

  // 7. Dedup: drop facts with >80% token overlap
  const deduped: string[] = [];
  const tokenize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length >= 3);

  for (const fact of resolved) {
    const tokens = new Set(tokenize(fact));
    const isDuplicate = deduped.some(existing => {
      const existingTokens = new Set(tokenize(existing));
      const intersection = [...tokens].filter(t => existingTokens.has(t)).length;
      const union = new Set([...tokens, ...existingTokens]).size;
      return union > 0 && intersection / union > 0.8;
    });
    if (!isDuplicate) deduped.push(fact);
  }

  if (deduped.length <= 1) {
    return { facts: [], skip: true };
  }

  return {
    facts: deduped.slice(0, DECOMPOSITION_MAX_FACTS),
    skip: false,
  };
}
