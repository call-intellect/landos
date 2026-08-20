import { describe, it, expect } from 'vitest';
import {
  cosine,
  minMaxNormalize,
  normalizeBm25,
  personalizedPageRank,
  combineSignals,
  type PageRankEdge,
} from '../src/scoring.js';
import { DEFAULT_WEIGHTS } from '@repobrain/shared';

describe('cosine', () => {
  it('is 1 for identical direction, 0 for orthogonal', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('returns 0 for a zero vector', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
  it('throws on length mismatch', () => {
    expect(() => cosine([1, 2], [1])).toThrow();
  });
});

describe('minMaxNormalize', () => {
  it('maps to [0,1]', () => {
    expect(minMaxNormalize([0, 5, 10])).toEqual([0, 0.5, 1]);
  });
  it('constant input yields zeros (no signal)', () => {
    expect(minMaxNormalize([3, 3, 3])).toEqual([0, 0, 0]);
  });
});

describe('normalizeBm25', () => {
  it('inverts (lower raw = better) and maps best→1, null→0', () => {
    // -8 is the best (most relevant), -2 the worst; null did not match.
    const out = normalizeBm25([-8, -2, null]);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBe(0);
  });
  it('all-null → all zeros', () => {
    expect(normalizeBm25([null, null])).toEqual([0, 0]);
  });
});

describe('personalizedPageRank', () => {
  const nodes = ['A', 'B', 'C'];
  const edges: PageRankEdge[] = [
    { source: 'A', target: 'B', weight: 1 },
    { source: 'B', target: 'C', weight: 1 },
    { source: 'A', target: 'C', weight: 1 },
  ];

  it('is deterministic across runs', () => {
    const p = new Map([['A', 1]]);
    const r1 = personalizedPageRank(nodes, edges, p);
    const r2 = personalizedPageRank(nodes, edges, p);
    expect([...r1.entries()]).toEqual([...r2.entries()]);
  });

  it('ranks the sink node (C) highest when seeded at A', () => {
    const r = personalizedPageRank(nodes, edges, new Map([['A', 1]]));
    expect(r.get('C')!).toBeGreaterThan(r.get('B')!);
    // ranks approximately sum to 1
    const sum = [...r.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 4);
  });

  it('personalization shifts mass toward the seeded node', () => {
    const seededA = personalizedPageRank(nodes, edges, new Map([['A', 1]]));
    const seededB = personalizedPageRank(nodes, edges, new Map([['B', 1]]));
    // A retains more of its own mass when it is the teleport seed
    expect(seededA.get('A')!).toBeGreaterThan(seededB.get('A')!);
  });

  it('handles empty graph and empty personalization', () => {
    expect(personalizedPageRank([], [], new Map()).size).toBe(0);
    const uniform = personalizedPageRank(nodes, [], new Map());
    // no edges, no seeds → uniform distribution
    expect(uniform.get('A')!).toBeCloseTo(1 / 3, 4);
  });
});

describe('combineSignals', () => {
  it('applies the default weights and sums to total', () => {
    const b = combineSignals(
      { lex: 1, sem: 1, graph: 1, path: 1, git: 1, mem: 1, note: 1 },
      DEFAULT_WEIGHTS,
    );
    expect(b.total).toBeCloseTo(1 + DEFAULT_WEIGHTS.w_note, 6); // six original weights sum to 1, w_note is added on top
    expect(b.lex).toBeCloseTo(0.25, 6);
    expect(b.sem).toBeCloseTo(0.25, 6);
    expect(b.note).toBeCloseTo(0.45, 6);
  });

  it('the six pre-existing weights are untouched by the note bridge', () => {
    const withoutNote = combineSignals(
      { lex: 1, sem: 1, graph: 1, path: 1, git: 1, mem: 1, note: 0 },
      DEFAULT_WEIGHTS,
    );
    expect(withoutNote.total).toBeCloseTo(1, 6);
  });
});
