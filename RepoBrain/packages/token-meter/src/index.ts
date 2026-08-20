import { createRequire } from 'node:module';
import { countTokens as o200kCountTokens } from 'gpt-tokenizer/encoding/o200k_base';

/**
 * @repobrain/token-meter
 *
 * Token counting backed by REAL tokenizers selected per model family.
 * RepoBrain spec §14 forbids the naive `chars / 4` heuristic, so every count
 * here goes through an actual BPE tokenizer:
 *   - OpenAI models  -> gpt-tokenizer, o200k_base encoding (the modern encoding)
 *   - Claude models  -> @anthropic-ai/tokenizer (legacy Claude BPE) + safety pad
 *   - unknown/generic -> o200k_base + a small safety pad
 */

export type ModelFamily = 'claude' | 'gpt' | 'generic';

/** A function that returns the raw token count for a piece of text. */
type Counter = (text: string) => number;

const nodeRequire = createRequire(import.meta.url);

/**
 * Lazily-created, cached token counters. Encoders are expensive to build
 * (the Anthropic tokenizer loads a WASM BPE table), so we build each one at
 * most once and reuse it for the lifetime of the module.
 *
 * Value semantics:
 *   - a `Counter` => the encoder is ready
 *   - `null`      => we tried to build it and failed (do not retry)
 *   - absent      => not built yet
 */
const encoderCache = new Map<string, Counter | null>();

/** Minimal shape of the Anthropic tokenizer we rely on. */
interface AnthropicTokenizer {
  encode(text: string, allowedSpecial: 'all'): ArrayLike<number>;
}
interface AnthropicTokenizerModule {
  getTokenizer(): AnthropicTokenizer;
}

/** Cached counter for OpenAI's modern o200k_base encoding. */
function getO200kCounter(): Counter {
  const cached = encoderCache.get('o200k_base');
  if (cached) return cached;
  const counter: Counter = (text) => o200kCountTokens(text);
  encoderCache.set('o200k_base', counter);
  return counter;
}

/**
 * Cached counter backed by @anthropic-ai/tokenizer. Returns `null` if the
 * package cannot be loaded/used for any reason so callers can fall back.
 */
function getAnthropicCounter(): Counter | null {
  if (encoderCache.has('anthropic')) {
    return encoderCache.get('anthropic') ?? null;
  }
  try {
    const mod = nodeRequire('@anthropic-ai/tokenizer') as AnthropicTokenizerModule;
    const tokenizer = mod.getTokenizer();
    const counter: Counter = (text) =>
      tokenizer.encode(text.normalize('NFKC'), 'all').length;
    // Validate the encoder actually works before caching it.
    counter('probe');
    encoderCache.set('anthropic', counter);
    return counter;
  } catch {
    encoderCache.set('anthropic', null);
    return null;
  }
}

/**
 * Map a model identifier to a tokenizer family.
 *
 * - contains (case-insensitive) claude|sonnet|opus|haiku -> 'claude'
 * - contains gpt|o1|o3|o4|4o|openai                       -> 'gpt'
 * - undefined / empty / 'generic' / anything else         -> 'generic'
 */
export function resolveModelFamily(model?: string): ModelFamily {
  if (!model) return 'generic';
  const m = model.toLowerCase();
  if (/claude|sonnet|opus|haiku/.test(m)) return 'claude';
  if (/gpt|o1|o3|o4|4o|openai/.test(m)) return 'gpt';
  return 'generic';
}

/**
 * Count tokens for `text` using the tokenizer appropriate for `model`.
 *
 * Returns the token count plus the name of the tokenizer/strategy used, so
 * callers can surface how a number was derived.
 */
export function countTokens(
  text: string,
  model?: string,
): { tokens: number; tokenizer: string } {
  const family = resolveModelFamily(model);
  const empty = text.length === 0;

  if (family === 'gpt') {
    return { tokens: empty ? 0 : getO200kCounter()(text), tokenizer: 'o200k_base' };
  }

  if (family === 'generic') {
    // The exact model is unknown; pad the o200k_base count by 10% as a safe
    // over-estimate so downstream budgets are never exceeded.
    const base = empty ? 0 : getO200kCounter()(text);
    return { tokens: Math.ceil(base * 1.1), tokenizer: 'o200k_base*1.1' };
  }

  // family === 'claude'
  // The Anthropic JS tokenizer only approximates modern Claude and tends to
  // under-count, so pad by 15% as a safety margin.
  const anthropic = getAnthropicCounter();
  if (anthropic) {
    const base = empty ? 0 : anthropic(text);
    return { tokens: Math.ceil(base * 1.15), tokenizer: 'anthropic-approx*1.15' };
  }
  // Fall back to o200k_base (also padded 15%) when the Anthropic tokenizer
  // is unavailable for any reason.
  const base = empty ? 0 : getO200kCounter()(text);
  return { tokens: Math.ceil(base * 1.15), tokenizer: 'o200k_base*1.15' };
}

/**
 * Tokens saved by using a compact capsule instead of a naive dump.
 * Never negative.
 */
export function estimateTokensSaved(
  capsuleTokens: number,
  naiveEstimate: number,
): number {
  return Math.max(0, naiveEstimate - capsuleTokens);
}
