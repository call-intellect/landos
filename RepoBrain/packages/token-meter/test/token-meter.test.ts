import { describe, it, expect } from 'vitest';
import { resolveModelFamily, countTokens, estimateTokensSaved } from '../src/index';

describe('resolveModelFamily', () => {
  it('maps known model identifiers to the right family', () => {
    expect(resolveModelFamily('claude-opus-4')).toBe('claude');
    expect(resolveModelFamily('gpt-4o')).toBe('gpt');
    expect(resolveModelFamily('sonnet')).toBe('claude');
    expect(resolveModelFamily(undefined)).toBe('generic');
    expect(resolveModelFamily('generic')).toBe('generic');
    expect(resolveModelFamily('llama')).toBe('generic');
  });
});

describe('countTokens', () => {
  const sentence = 'The quick brown fox jumps over the lazy dog and then writes some code.';

  it('counts gpt tokens as a small positive integer and is deterministic', () => {
    const a = countTokens('hello world', 'gpt');
    const b = countTokens('hello world', 'gpt');
    expect(a.tokenizer).toBe('o200k_base');
    expect(Number.isInteger(a.tokens)).toBe(true);
    expect(a.tokens).toBeGreaterThan(0);
    expect(a.tokens).toBeLessThan(50);
    expect(a.tokens).toBe(b.tokens); // deterministic
  });

  it('pads claude counts above the raw gpt count for a non-trivial sentence', () => {
    const gpt = countTokens(sentence, 'gpt');
    const claude = countTokens(sentence, 'claude-opus-4');
    expect(claude.tokens).toBeGreaterThan(gpt.tokens);
  });

  it('computes generic tokens as ceil(gpt tokens * 1.1)', () => {
    const gpt = countTokens(sentence, 'gpt');
    const generic = countTokens(sentence, 'llama');
    expect(generic.tokenizer).toBe('o200k_base*1.1');
    expect(generic.tokens).toBe(Math.ceil(gpt.tokens * 1.1));
  });

  it('returns 0 tokens for an empty string', () => {
    expect(countTokens('', 'gpt').tokens).toBe(0);
    expect(countTokens('', 'claude').tokens).toBe(0);
    expect(countTokens('', 'llama').tokens).toBe(0);
  });
});

describe('estimateTokensSaved', () => {
  it('returns the positive difference, never negative', () => {
    expect(estimateTokensSaved(100, 500)).toBe(400);
    expect(estimateTokensSaved(500, 100)).toBe(0);
  });
});
