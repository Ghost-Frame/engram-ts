import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDuration,
  buildFallbackSummary,
  formatMemoriesForLLM,
  nowTimestamp,
  EPISODE_SUMMARIZE_PROMPT,
  FINALIZE_SUMMARIZE_PROMPT,
  LLM_TEXT_LIMIT,
} from '../src/episodes/index.ts';
import { registerEpisodeRoutes } from '../src/episodes/routes.ts';

describe('calculateDuration', () => {
  it('computes seconds between two valid timestamps', () => {
    assert.strictEqual(
      calculateDuration('2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z'),
      3600,
    );
  });
  it('computes seconds for sub-minute difference', () => {
    assert.strictEqual(
      calculateDuration('2025-06-15T12:00:00Z', '2025-06-15T12:00:45Z'),
      45,
    );
  });
  it('returns 0 when startedAt is null', () => {
    assert.strictEqual(calculateDuration(null, '2025-01-01T01:00:00Z'), 0);
  });
  it('returns 0 when endedAt is null', () => {
    assert.strictEqual(calculateDuration('2025-01-01T00:00:00Z', null), 0);
  });
  it('returns 0 when both are null', () => {
    assert.strictEqual(calculateDuration(null, null), 0);
  });
  it('returns 0 when both are undefined', () => {
    assert.strictEqual(calculateDuration(undefined, undefined), 0);
  });
  it('returns 0 for invalid date strings', () => {
    assert.strictEqual(calculateDuration('not-a-date', 'also-not'), 0);
  });
  it('returns 0 when end is before start', () => {
    assert.strictEqual(
      calculateDuration('2025-01-02T00:00:00Z', '2025-01-01T00:00:00Z'),
      0,
    );
  });
});

describe('buildFallbackSummary', () => {
  it('joins memory content with spaces', () => {
    const result = buildFallbackSummary([
      { content: 'first memory' },
      { content: 'second memory' },
    ]);
    assert.strictEqual(result, 'first memory second memory');
  });
  it('truncates to 1000 chars', () => {
    const longContent = 'x'.repeat(800);
    const result = buildFallbackSummary([
      { content: longContent },
      { content: longContent },
    ]);
    assert.strictEqual(result.length, 1000);
  });
  it('returns empty string for empty array', () => {
    assert.strictEqual(buildFallbackSummary([]), '');
  });
});

describe('formatMemoriesForLLM', () => {
  it('formats memories with category prefix', () => {
    const result = formatMemoriesForLLM([
      { content: 'did a thing', category: 'task' },
      { content: 'learned stuff', category: 'fact' },
    ]);
    assert.ok(result.includes('[task] did a thing'));
    assert.ok(result.includes('[fact] learned stuff'));
  });
  it('truncates to LLM_TEXT_LIMIT', () => {
    const bigMemories = Array.from({ length: 100 }, (_, i) => ({
      content: 'x'.repeat(200),
      category: 'test',
    }));
    const result = formatMemoriesForLLM(bigMemories);
    assert.ok(result.length <= LLM_TEXT_LIMIT);
  });
});

describe('nowTimestamp', () => {
  it('returns a space-separated ISO timestamp without Z', () => {
    const ts = nowTimestamp();
    assert.ok(ts.includes(' '), 'should contain space separator');
    assert.ok(!ts.includes('T'), 'should not contain T');
    assert.ok(!ts.endsWith('Z'), 'should not end with Z');
  });
});

describe('constants', () => {
  it('EPISODE_SUMMARIZE_PROMPT is a non-empty string', () => {
    assert.strictEqual(typeof EPISODE_SUMMARIZE_PROMPT, 'string');
    assert.ok(EPISODE_SUMMARIZE_PROMPT.length > 0);
  });
  it('FINALIZE_SUMMARIZE_PROMPT is a non-empty string', () => {
    assert.strictEqual(typeof FINALIZE_SUMMARIZE_PROMPT, 'string');
    assert.ok(FINALIZE_SUMMARIZE_PROMPT.length > 0);
  });
  it('LLM_TEXT_LIMIT is 8000', () => {
    assert.strictEqual(LLM_TEXT_LIMIT, 8000);
  });
});

describe('registerEpisodeRoutes', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof registerEpisodeRoutes, 'function');
  });
});
