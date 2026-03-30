import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTags,
  clampImportance,
  validateContent,
  validateContentSize,
  isValidFeedbackSignal,
  buildCorrectionContent,
  ContentValidationError,
} from '../src/memory/store.ts';
import { registerMemoryRoutes } from '../src/memory/routes.ts';

describe('normalizeTags', () => {
  it('returns null for null/undefined', () => {
    assert.strictEqual(normalizeTags(null), null);
    assert.strictEqual(normalizeTags(undefined), null);
  });
  it('converts CSV string to JSON array', () => {
    const r = normalizeTags('foo, bar, baz');
    assert.deepStrictEqual(JSON.parse(r!), ['foo', 'bar', 'baz']);
  });
  it('converts string array lowercased', () => {
    const r = normalizeTags(['Alpha', 'BETA']);
    assert.deepStrictEqual(JSON.parse(r!), ['alpha', 'beta']);
  });
  it('filters empty strings', () => {
    const r = normalizeTags(['a', '', '  ', 'b']);
    assert.deepStrictEqual(JSON.parse(r!), ['a', 'b']);
  });
  it('returns null for all-empty input', () => {
    assert.strictEqual(normalizeTags(['', '  ']), null);
  });
});

describe('clampImportance', () => {
  it('clamps below 1 to 1', () => {
    assert.strictEqual(clampImportance(0), 1);
    assert.strictEqual(clampImportance(-5), 1);
  });
  it('clamps above 10 to 10', () => {
    assert.strictEqual(clampImportance(15), 10);
    assert.strictEqual(clampImportance(100), 10);
  });
  it('returns default for NaN', () => {
    assert.strictEqual(clampImportance('abc'), 5);
    assert.strictEqual(clampImportance(null), 1); // Number(null)=0 -> clamp to 1
    assert.strictEqual(clampImportance(undefined, 7), 7);
  });
  it('passes through valid values', () => {
    assert.strictEqual(clampImportance(1), 1);
    assert.strictEqual(clampImportance(5), 5);
    assert.strictEqual(clampImportance(10), 10);
    assert.strictEqual(clampImportance(7.5), 7.5);
  });
  it('parses numeric strings', () => {
    assert.strictEqual(clampImportance('8'), 8);
  });
});

describe('validateContent', () => {
  it('returns trimmed string for valid input', () => {
    assert.strictEqual(validateContent('  hello  '), 'hello');
  });
  it('throws for empty string', () => {
    assert.throws(() => validateContent(''), ContentValidationError);
    assert.throws(() => validateContent('   '), ContentValidationError);
  });
  it('throws for non-string', () => {
    assert.throws(() => validateContent(42), ContentValidationError);
    assert.throws(() => validateContent(null), ContentValidationError);
    assert.throws(() => validateContent(undefined), ContentValidationError);
  });
});

describe('validateContentSize', () => {
  it('does not throw for content under limit', () => {
    assert.doesNotThrow(() => validateContentSize('short', 100));
  });
  it('throws for content over limit', () => {
    assert.throws(() => validateContentSize('a'.repeat(101), 100), ContentValidationError);
  });
  it('uses default MAX_CONTENT_SIZE', () => {
    assert.doesNotThrow(() => validateContentSize('short content'));
  });
});

describe('isValidFeedbackSignal', () => {
  it('returns true for valid signals', () => {
    for (const sig of ['used', 'ignored', 'corrected', 'irrelevant', 'helpful']) {
      assert.strictEqual(isValidFeedbackSignal(sig), true);
    }
  });
  it('returns false for invalid signals', () => {
    assert.strictEqual(isValidFeedbackSignal('bad'), false);
    assert.strictEqual(isValidFeedbackSignal(''), false);
    assert.strictEqual(isValidFeedbackSignal('USED'), false);
  });
});

describe('buildCorrectionContent', () => {
  it('includes original claim and memory id', () => {
    const r = buildCorrectionContent('new fact', 'old claim', 42);
    assert.ok(r.includes('[CORRECTION]'));
    assert.ok(r.includes('old claim'));
    assert.ok(r.includes('new fact'));
  });
  it('includes memory id only when no original claim', () => {
    const r = buildCorrectionContent('new fact', null, 42);
    assert.ok(r.includes('#42'));
    assert.ok(r.includes('new fact'));
  });
  it('returns plain correction when no memory id', () => {
    const r = buildCorrectionContent('just a correction', null, null);
    assert.strictEqual(r, 'just a correction');
  });
});

describe('registerMemoryRoutes', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof registerMemoryRoutes, 'function');
  });
});