// ============================================================================
// PERSONALITY ENGINE — extraction, synthesis, caching
// ============================================================================

import { callLLM, isLLMAvailable, repairAndParseJSON } from "../llm/index.ts";
import { log } from "../config/logger.ts";
import {
  db,
  insertPersonalitySignal,
  getPersonalitySignals,
  getPersonalitySignalCount,
  getCachedPersonalityProfile,
  upsertPersonalityProfile,
  invalidatePersonalityProfile,
} from "../db/index.ts";

// --- Types ---

export interface PersonalitySignal {
  signal_type: "preference" | "value" | "motivation" | "decision" | "emotion" | "identity";
  subject: string;
  valence: "positive" | "negative" | "neutral" | "mixed";
  intensity: number;
  reasoning: string;
  source_text: string;
}

// --- Prompts ---

const EXTRACTION_SYSTEM_PROMPT = `You are a personality analysis engine. Given a conversation excerpt, extract personality signals - the preferences, values, motivations, decision patterns, and emotional associations expressed or implied.

For each signal, identify:
- signal_type: preference|value|motivation|decision|emotion|identity
- subject: what the signal is about (2-5 words)
- valence: positive|negative|neutral|mixed
- intensity: 0.0-1.0 (how strongly expressed)
- reasoning: WHY this matters to the person (1-2 sentences)
- source_text: the exact quote or close paraphrase that supports this signal

Rules:
- Extract IMPLICIT signals, not just explicit statements. If someone describes feeling "trapped" by structure, that implies they value freedom/autonomy.
- Look for PATTERNS across the text. Multiple related signals should reference each other in reasoning.
- Intensity 0.8+ = strong emotional language, life-changing decisions. 0.5 = mentioned but not emphasized. 0.2 = barely implied.
- Be specific in subjects. Not "activities" but "structured creative activities" or "solo music exploration".
- 3-8 signals per chunk is typical. Don't over-extract from short texts.

Respond with ONLY valid JSON array (no markdown, no backticks):
[
  {
    "signal_type": "...",
    "subject": "...",
    "valence": "...",
    "intensity": 0.0,
    "reasoning": "...",
    "source_text": "..."
  }
]`;

const SYNTHESIS_SYSTEM_PROMPT = `You are building a personality profile from accumulated personality signals. Given the signals below, write a coherent narrative profile of this person.

Cover these dimensions:
1. **Core Values**: What matters most to them fundamentally
2. **Decision-Making Style**: How they approach choices (spontaneous vs deliberate, independent vs collaborative)
3. **Emotional Patterns**: What energizes them, what drains them, what triggers strong reactions
4. **Creative & Intellectual Preferences**: How they prefer to express themselves, learn, and explore
5. **Social Tendencies**: How they relate to others, group dynamics, collaboration preferences
6. **Growth Trajectory**: What they're moving toward, what they're leaving behind, how they're evolving

Rules:
- Write in third person ("This person...")
- Be specific and evidence-based. Reference the signals, don't speculate beyond them.
- Identify PATTERNS across signals. If multiple signals point to the same underlying trait, name the trait explicitly.
- Note CONTRADICTIONS if any exist (people are complex).
- Keep it to 300-500 words. Dense and actionable, not fluffy.
- This profile will be used by an AI to predict how this person would react to new situations, so focus on predictive signals.`;

// --- Core Functions ---

export async function extractPersonalitySignals(
  content: string,
  memoryId: number,
  userId: number
): Promise<PersonalitySignal[]> {
  if (!isLLMAvailable()) {
    log.debug({ msg: "personality_extraction_skipped", reason: "no_llm" });
    return [];
  }

  // Skip very short content (unlikely to contain personality signals)
  if (content.length < 50) return [];

  try {
    const response = await callLLM(EXTRACTION_SYSTEM_PROMPT, content);
    const signals = repairAndParseJSON(response) as PersonalitySignal[] | null;

    if (!Array.isArray(signals)) {
      log.warn({ msg: "personality_extraction_not_array", memoryId });
      return [];
    }

    // Validate and insert each signal
    const validSignals: PersonalitySignal[] = [];
    const validTypes = new Set(["preference", "value", "motivation", "decision", "emotion", "identity"]);
    const validValences = new Set(["positive", "negative", "neutral", "mixed"]);

    for (const sig of signals) {
      if (!sig.signal_type || !validTypes.has(sig.signal_type)) continue;
      if (!sig.subject || typeof sig.subject !== "string") continue;
      if (!sig.valence || !validValences.has(sig.valence)) continue;

      const intensity = Math.max(0, Math.min(1, Number(sig.intensity) || 0.5));

      try {
        insertPersonalitySignal.run(
          memoryId,
          userId,
          sig.signal_type,
          sig.subject.slice(0, 200),
          sig.valence,
          intensity,
          sig.reasoning?.slice(0, 1000) || null,
          sig.source_text?.slice(0, 500) || null
        );
        validSignals.push({ ...sig, intensity });
      } catch (e: any) {
        log.warn({ msg: "personality_signal_insert_failed", memoryId, error: e.message });
      }
    }

    if (validSignals.length > 0) {
      // Invalidate cached profile since we have new signals
      invalidatePersonalityProfile.run(userId);
      log.debug({ msg: "personality_extracted", memoryId, signals: validSignals.length });
    }

    return validSignals;
  } catch (e: any) {
    log.error({ msg: "personality_extraction_failed", memoryId, error: e.message });
    return [];
  }
}

export async function synthesizePersonalityProfile(userId: number): Promise<string> {
  if (!isLLMAvailable()) {
    throw new Error("LLM not available for personality synthesis");
  }

  // Gather all personality signals
  const signals = getPersonalitySignals.all(userId) as Array<{
    signal_type: string;
    subject: string;
    valence: string;
    intensity: number;
    reasoning: string;
    source_text: string;
  }>;

  if (signals.length === 0) {
    return "Insufficient data for personality synthesis. No personality signals have been extracted yet.";
  }

  // Also pull user_preferences and structured_facts for richer synthesis
  const preferences = db.prepare(
    "SELECT domain, preference, strength FROM user_preferences WHERE user_id = ? ORDER BY strength DESC LIMIT 50"
  ).all(userId) as Array<{ domain: string; preference: string; strength: number }>;

  const facts = db.prepare(
    "SELECT subject, verb, object FROM structured_facts WHERE user_id = ? LIMIT 50"
  ).all(userId) as Array<{ subject: string; verb: string; object: string }>;

  const staticMemories = db.prepare(
    "SELECT content FROM memories WHERE user_id = ? AND is_static = 1 AND is_forgotten = 0 ORDER BY importance DESC LIMIT 20"
  ).all(userId) as Array<{ content: string }>;

  // Build the user prompt with all gathered data
  let userPrompt = `PERSONALITY SIGNALS (${signals.length} total):\n`;
  for (const sig of signals) {
    userPrompt += `- [${sig.signal_type}] "${sig.subject}" (${sig.valence}, intensity: ${sig.intensity})\n`;
    if (sig.reasoning) userPrompt += `  Why: ${sig.reasoning}\n`;
    if (sig.source_text) userPrompt += `  Evidence: "${sig.source_text}"\n`;
  }

  if (preferences.length > 0) {
    userPrompt += `\nUSER PREFERENCES:\n`;
    for (const p of preferences) {
      userPrompt += `- [${p.domain}] ${p.preference} (strength: ${p.strength})\n`;
    }
  }

  if (facts.length > 0) {
    userPrompt += `\nSTRUCTURED FACTS:\n`;
    for (const f of facts) {
      userPrompt += `- ${f.subject} ${f.verb} ${f.object || ""}\n`;
    }
  }

  if (staticMemories.length > 0) {
    userPrompt += `\nSTATIC MEMORIES (core identity/preferences):\n`;
    for (const m of staticMemories) {
      userPrompt += `- ${m.content.slice(0, 200)}\n`;
    }
  }

  const profile = await callLLM(SYNTHESIS_SYSTEM_PROMPT, userPrompt);

  // Cache the profile
  const signalCount = (getPersonalitySignalCount.get(userId) as { count: number }).count;
  upsertPersonalityProfile.run(userId, profile, signalCount);

  log.info({ msg: "personality_profile_synthesized", userId, signals: signalCount });
  return profile;
}

export function getCachedProfile(userId: number): string | null {
  const row = getCachedPersonalityProfile.get(userId) as { profile: string } | undefined;
  return row?.profile ?? null;
}

export function invalidateProfile(userId: number): void {
  invalidatePersonalityProfile.run(userId);
}
