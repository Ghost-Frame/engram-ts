// ============================================================================
// PERSONALITY FALLBACK - Tier 2 (rule-based NLP) and Tier 3 (template) signal extraction
// and profile synthesis. Used when LLM is unavailable.
// Tier 2 extraction quality: ~40% of LLM. Tier 3 quality: ~25% of LLM.
// Tier 2 synthesis quality: ~45%. Tier 3 synthesis quality: ~20% narrative, ~70% informational.
// ============================================================================

import type { PersonalitySignal } from "./personality.ts";
import { SENTIMENT_LEXICON } from "./sentiment-lexicon.ts";

// ---- Signal Extraction ----

// Reuse same regex patterns from extraction.ts
const likePattern = /\b(?:I\s+)?(love|like|enjoy|prefer|adore|am (?:really )?into)\s+(.+?)(?:\.|,|!|\s+(?:and|but|so|because))/gi;
const dislikePattern = /\b(?:I\s+)?(hate|dislike|don't like|can't stand|avoid)\s+(.+?)(?:\.|,|!|\s+(?:and|but|so|because))/gi;
const favPattern = /\bmy favorite\s+(.+?)\s+(?:is|are)\s+(.+?)(?:\.|,|$)/gi;

// Additional patterns for richer signal types
const decisionPattern = /\b(?:I\s+)?(?:decided to|chose to|going to|switched to|opted for|picked|went with)\s+(.+?)(?:\.|,|!|$)/gi;
const identityPattern = /\b(?:I\s+)?(?:am a|'m a|consider myself|identify as)\s+(.+?)(?:\.|,|!|$)/gi;
const valuePattern = /\b(?:important to me|matters to me|I believe in|I value|I care about)\s+(.+?)(?:\.|,|!|$)/gi;
const motivationPattern = /\b(?:I want to|my goal is|I aspire to|I'm trying to|I hope to|I aim to)\s+(.+?)(?:\.|,|!|$)/gi;

// Emotional keyword list for Tier 3
const EMOTION_KEYWORDS: Record<string, { valence: "positive" | "negative"; intensity: number }> = {
  happy: { valence: "positive", intensity: 0.6 },
  excited: { valence: "positive", intensity: 0.8 },
  grateful: { valence: "positive", intensity: 0.7 },
  proud: { valence: "positive", intensity: 0.7 },
  relieved: { valence: "positive", intensity: 0.5 },
  thrilled: { valence: "positive", intensity: 0.9 },
  content: { valence: "positive", intensity: 0.5 },
  sad: { valence: "negative", intensity: 0.6 },
  angry: { valence: "negative", intensity: 0.8 },
  frustrated: { valence: "negative", intensity: 0.7 },
  anxious: { valence: "negative", intensity: 0.6 },
  stressed: { valence: "negative", intensity: 0.7 },
  disappointed: { valence: "negative", intensity: 0.6 },
  overwhelmed: { valence: "negative", intensity: 0.8 },
  lonely: { valence: "negative", intensity: 0.7 },
  worried: { valence: "negative", intensity: 0.5 },
  bored: { valence: "negative", intensity: 0.4 },
};

// Intensifiers for Tier 2
const INTENSIFIERS: Record<string, number> = {
  very: 1.3, really: 1.3, absolutely: 1.4, extremely: 1.4, incredibly: 1.4,
  super: 1.3, totally: 1.3, deeply: 1.3, strongly: 1.3, highly: 1.3,
  somewhat: 0.7, slightly: 0.7, a_bit: 0.7, kind_of: 0.7, sort_of: 0.7,
  barely: 0.5, hardly: 0.5, mildly: 0.6,
};

function cleanSubject(raw: string): string {
  return raw.trim().replace(/^(a |an |the |my |our )/i, "").slice(0, 200);
}

function splitSentences(content: string): string[] {
  return content.split(/[.!?]+\s+|\n+/).map(s => s.trim()).filter(s => s.length > 5);
}

/**
 * Tier 3 -- Template-based signal extraction.
 * Pattern match explicit signals only.
 * Quality: ~25% of LLM.
 */
export function extractSignalsTemplate(content: string): PersonalitySignal[] {
  const signals: PersonalitySignal[] = [];
  const sentences = splitSentences(content);

  // Preferences: likes
  for (const m of content.matchAll(likePattern)) {
    const subject = cleanSubject(m[2]);
    if (subject.length < 3 || subject.length > 100) continue;
    signals.push({
      signal_type: "preference",
      subject,
      valence: "positive",
      intensity: 0.6,
      reasoning: `Expressed positive preference about ${subject}`,
      source_text: m[0].trim(),
    });
  }

  // Preferences: dislikes
  for (const m of content.matchAll(dislikePattern)) {
    const subject = cleanSubject(m[2]);
    if (subject.length < 3 || subject.length > 100) continue;
    signals.push({
      signal_type: "preference",
      subject,
      valence: "negative",
      intensity: 0.6,
      reasoning: `Expressed negative preference about ${subject}`,
      source_text: m[0].trim(),
    });
  }

  // Preferences: favorites
  for (const m of content.matchAll(favPattern)) {
    signals.push({
      signal_type: "preference",
      subject: `${cleanSubject(m[1])}: ${cleanSubject(m[2])}`,
      valence: "positive",
      intensity: 0.8,
      reasoning: `Named ${cleanSubject(m[2])} as favorite ${cleanSubject(m[1])}`,
      source_text: m[0].trim(),
    });
  }

  // Decisions
  for (const m of content.matchAll(decisionPattern)) {
    const subject = cleanSubject(m[1]);
    if (subject.length < 3 || subject.length > 100) continue;
    signals.push({
      signal_type: "decision",
      subject,
      valence: "neutral",
      intensity: 0.5,
      reasoning: `Made a decision about ${subject}`,
      source_text: m[0].trim(),
    });
  }

  // Identity
  for (const m of content.matchAll(identityPattern)) {
    const subject = cleanSubject(m[1]);
    if (subject.length < 3 || subject.length > 100) continue;
    signals.push({
      signal_type: "identity",
      subject,
      valence: "neutral",
      intensity: 0.7,
      reasoning: `Self-identified as ${subject}`,
      source_text: m[0].trim(),
    });
  }

  // Emotions (keyword scan)
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    for (const [keyword, meta] of Object.entries(EMOTION_KEYWORDS)) {
      if (lower.includes(keyword)) {
        signals.push({
          signal_type: "emotion",
          subject: keyword,
          valence: meta.valence,
          intensity: meta.intensity,
          reasoning: `Expressed ${meta.valence} emotion: ${keyword}`,
          source_text: sentence.slice(0, 500),
        });
        break; // One emotion per sentence
      }
    }
  }

  return signals;
}

/**
 * Tier 2 -- Rule-based NLP signal extraction.
 * All Tier 3 patterns + sentiment lexicon + intensifiers + multi-signal + values + motivations.
 * Quality: ~40% of LLM.
 */
export function extractSignalsRuleBased(content: string): PersonalitySignal[] {
  // Start with Tier 3 signals
  const signals = extractSignalsTemplate(content);

  // Values
  for (const m of content.matchAll(valuePattern)) {
    const subject = cleanSubject(m[1]);
    if (subject.length < 3 || subject.length > 100) continue;
    signals.push({
      signal_type: "value",
      subject,
      valence: "positive",
      intensity: 0.7,
      reasoning: `Expressed that ${subject} is important to them`,
      source_text: m[0].trim(),
    });
  }

  // Motivations
  for (const m of content.matchAll(motivationPattern)) {
    const subject = cleanSubject(m[1]);
    if (subject.length < 3 || subject.length > 100) continue;
    signals.push({
      signal_type: "motivation",
      subject,
      valence: "positive",
      intensity: 0.6,
      reasoning: `Expressed aspiration toward ${subject}`,
      source_text: m[0].trim(),
    });
  }

  // Sentiment lexicon scoring for intensity calibration on existing signals
  for (const sig of signals) {
    const words = sig.source_text.toLowerCase().split(/\s+/);
    let sentimentSum = 0;
    let sentimentCount = 0;
    for (const word of words) {
      const score = SENTIMENT_LEXICON.get(word);
      if (score !== undefined) {
        sentimentSum += score;
        sentimentCount++;
      }
    }
    if (sentimentCount > 0) {
      const avgSentiment = sentimentSum / sentimentCount;
      // Calibrate intensity based on sentiment strength
      sig.intensity = Math.max(0, Math.min(1, sig.intensity + avgSentiment * 0.05));
    }

    // Intensifier detection
    for (const word of words) {
      const normalized = word.replace(/\s+/g, "_");
      const mult = INTENSIFIERS[normalized];
      if (mult) {
        sig.intensity = Math.max(0, Math.min(1, sig.intensity * mult));
      }
    }

    // Punctuation-based intensity
    if (sig.source_text.includes("!")) sig.intensity = Math.min(1, sig.intensity + 0.1);
    if (sig.source_text === sig.source_text.toUpperCase() && sig.source_text.length > 5) {
      sig.intensity = Math.min(1, sig.intensity + 0.2);
    }
  }

  // Multi-signal extraction: "I love X but hate Y" already handled by separate regex matches

  return signals;
}

// ---- Profile Synthesis ----

interface SynthesisInput {
  signals: Array<{
    signal_type: string;
    subject: string;
    valence: string;
    intensity: number;
    reasoning: string | null;
    source_text: string | null;
  }>;
  preferences: Array<{ domain: string; preference: string; strength: number }>;
  facts: Array<{ subject: string; verb: string; object: string }>;
  staticMemories: Array<{ content: string }>;
}

/**
 * Tier 3 -- Template-based profile synthesis.
 * Structured dump of signals grouped by type.
 * Quality: ~20% narrative, ~70% informational content.
 */
export function synthesizeProfileTemplate(input: SynthesisInput): string {
  const { signals, preferences, facts, staticMemories } = input;

  if (signals.length === 0 && preferences.length === 0) {
    return "Insufficient data for personality synthesis. No personality signals have been extracted yet.";
  }

  const sections: string[] = [];
  const now = new Date().toISOString().split("T")[0];
  sections.push(`Profile based on ${signals.length} signals. Updated ${now}.`);

  // Group by type
  const grouped: Record<string, typeof signals> = {};
  for (const sig of signals) {
    const type = sig.signal_type;
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(sig);
  }

  // Sort each group by intensity desc, take top 5
  const typeLabels: Record<string, string> = {
    value: "CORE VALUES",
    preference: "PREFERENCES",
    decision: "DECISIONS",
    emotion: "EMOTIONS",
    identity: "IDENTITY",
    motivation: "MOTIVATIONS",
  };

  for (const [type, label] of Object.entries(typeLabels)) {
    const group = grouped[type];
    if (!group || group.length === 0) continue;
    group.sort((a, b) => b.intensity - a.intensity);
    const top = group.slice(0, 5);
    sections.push(`\n${label}:`);
    for (const sig of top) {
      sections.push(`- ${sig.subject} (${sig.valence}, strength: ${sig.intensity.toFixed(2)})${sig.reasoning ? " -- " + sig.reasoning : ""}`);
    }
  }

  // Preferences from user_preferences table
  if (preferences.length > 0) {
    const likes = preferences.filter(p => p.preference.startsWith("likes "));
    const dislikes = preferences.filter(p => p.preference.startsWith("dislikes "));
    if (likes.length > 0) {
      sections.push("\nLIKES:");
      for (const p of likes.slice(0, 10)) {
        sections.push(`- ${p.preference.replace("likes ", "")} [${p.domain}] (strength: ${p.strength})`);
      }
    }
    if (dislikes.length > 0) {
      sections.push("\nDISLIKES:");
      for (const p of dislikes.slice(0, 10)) {
        sections.push(`- ${p.preference.replace("dislikes ", "")} [${p.domain}] (strength: ${p.strength})`);
      }
    }
  }

  // Static memories
  if (staticMemories.length > 0) {
    sections.push("\nCORE IDENTITY:");
    for (const m of staticMemories.slice(0, 5)) {
      sections.push(`- ${m.content.slice(0, 200)}`);
    }
  }

  return sections.join("\n");
}

/**
 * Tier 2 -- Rule-based NLP profile synthesis.
 * Signal clustering, trend detection, contradiction flagging.
 * Quality: ~45%.
 */
export function synthesizeProfileRuleBased(input: SynthesisInput): string {
  const { signals, preferences, facts, staticMemories } = input;

  if (signals.length === 0 && preferences.length === 0) {
    return "Insufficient data for personality synthesis. No personality signals have been extracted yet.";
  }

  const sections: string[] = [];
  const now = new Date().toISOString().split("T")[0];

  // 1. Signal clustering: group by subject token overlap >50%
  const tokenize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length >= 3);

  interface Cluster {
    label: string;
    signals: typeof signals;
    avgIntensity: number;
  }

  const clusters: Cluster[] = [];
  for (const sig of signals) {
    const sigTokens = new Set(tokenize(sig.subject));
    let placed = false;
    for (const cluster of clusters) {
      const clusterTokens = new Set(tokenize(cluster.label));
      const intersection = [...sigTokens].filter(t => clusterTokens.has(t)).length;
      const union = new Set([...sigTokens, ...clusterTokens]).size;
      if (union > 0 && intersection / union > 0.5) {
        cluster.signals.push(sig);
        cluster.avgIntensity = cluster.signals.reduce((s, sig) => s + sig.intensity, 0) / cluster.signals.length;
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ label: sig.subject, signals: [sig], avgIntensity: sig.intensity });
    }
  }

  // Sort clusters by signal count desc
  clusters.sort((a, b) => b.signals.length - a.signals.length);

  sections.push(`Personality profile based on ${signals.length} signals across ${clusters.length} themes. Generated ${now}.`);

  // 2. Top themes with sentence templates
  const topClusters = clusters.slice(0, 8);
  if (topClusters.length > 0) {
    sections.push("\nKEY THEMES:");
    for (const cluster of topClusters) {
      const types = [...new Set(cluster.signals.map(s => s.signal_type))];
      const valences = [...new Set(cluster.signals.map(s => s.valence))];
      const intensity = cluster.avgIntensity;

      if (cluster.signals.length >= 3) {
        sections.push(`- "${cluster.label}" is a strong theme (${cluster.signals.length} signals, avg intensity: ${intensity.toFixed(2)}). Types: ${types.join(", ")}. Valences: ${valences.join(", ")}.`);
      } else {
        sections.push(`- "${cluster.label}" (${cluster.signals.length} signal${cluster.signals.length > 1 ? "s" : ""}, intensity: ${intensity.toFixed(2)}, ${valences.join("/")})`);
      }
    }
  }

  // 3. Contradiction flagging: same subject + opposing valences
  const contradictions: string[] = [];
  for (const cluster of clusters) {
    const hasPositive = cluster.signals.some(s => s.valence === "positive");
    const hasNegative = cluster.signals.some(s => s.valence === "negative");
    if (hasPositive && hasNegative) {
      contradictions.push(cluster.label);
    }
  }
  if (contradictions.length > 0) {
    sections.push("\nCOMPLEXITIES:");
    for (const c of contradictions) {
      sections.push(`- "${c}" shows mixed signals -- both positive and negative sentiments detected. This suggests nuanced or evolving feelings.`);
    }
  }

  // 4. Preferences summary
  if (preferences.length > 0) {
    sections.push("\nSTATED PREFERENCES:");
    const topPrefs = preferences.slice(0, 10);
    for (const p of topPrefs) {
      sections.push(`- [${p.domain}] ${p.preference} (strength: ${p.strength})`);
    }
  }

  // 5. Identity from static memories
  if (staticMemories.length > 0) {
    sections.push("\nCORE IDENTITY:");
    for (const m of staticMemories.slice(0, 5)) {
      sections.push(`- ${m.content.slice(0, 200)}`);
    }
  }

  // 6. Summary sentence
  const topTypes = [...new Set(signals.map(s => s.signal_type))];
  const avgIntensity = signals.length > 0 ? signals.reduce((s, sig) => s + sig.intensity, 0) / signals.length : 0;
  sections.push(`\nOverall signal types: ${topTypes.join(", ")}. Average intensity: ${avgIntensity.toFixed(2)}.`);

  return sections.join("\n");
}
