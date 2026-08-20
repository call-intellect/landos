/**
 * Pure, deterministic scoring math for the hybrid ranker (spec §9.3).
 *
 * No I/O, no randomness, no wall-clock — so the capsule is deterministic for a fixed
 * (task, index) per spec §9.2. These primitives are consumed by the ranker orchestration,
 * which fetches candidates from graph-store/embeddings and feeds them here.
 */

import type { RankingWeights, ScoreBreakdown } from '@repobrain/shared';

// ── Vectors ──────────────────────────────────────────────────────

/** Cosine similarity of two equal-length vectors. Returns 0 for a zero vector. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`cosine: length mismatch ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Normalization ────────────────────────────────────────────────

/** Min-max normalize values into [0,1]. Constant input → all zeros (no signal). */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (span === 0) return values.map(() => 0);
  return values.map((v) => (v - min) / span);
}

/**
 * Normalize SQLite FTS5 bm25() scores to [0,1] where higher = better.
 * FTS5 bm25() returns lower (more negative) = more relevant, so we invert then min-max.
 * Non-matching candidates should be passed as `null` and map to 0.
 */
export function normalizeBm25(rawScores: (number | null)[]): number[] {
  const present = rawScores.filter((s): s is number => s !== null);
  if (present.length === 0) return rawScores.map(() => 0);
  // invert: better (more negative) → larger positive
  const inverted = present.map((s) => -s);
  const min = Math.min(...inverted);
  const max = Math.max(...inverted);
  const span = max - min;
  return rawScores.map((s) => {
    if (s === null) return 0;
    if (span === 0) return 1; // all matched equally
    return (-s - min) / span;
  });
}

// ── Personalized PageRank (spec §9.3 w_graph; Aider Repo Map idea) ─

export interface PageRankEdge {
  source: string;
  target: string;
  weight: number; // edge confidence-weighted (spec §0.1.4)
}

export interface PageRankOptions {
  damping?: number; // d, default 0.85
  maxIterations?: number; // default 50
  tolerance?: number; // L1 convergence, default 1e-6
}

/**
 * Personalized PageRank over a directed, weighted graph via power iteration.
 *
 * `personalization` seeds the teleport distribution (lexical+semantic hit strengths).
 * Deterministic: fixed damping/iterations, sorted node processing, no randomness.
 * Dangling nodes (no out-edges) redistribute their mass along the personalization vector.
 *
 * @returns Map nodeId → rank (ranks sum to ~1 over the provided node set).
 */
export function personalizedPageRank(
  nodeIds: string[],
  edges: PageRankEdge[],
  personalization: Map<string, number>,
  opts: PageRankOptions = {},
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const maxIter = opts.maxIterations ?? 50;
  const tol = opts.tolerance ?? 1e-6;

  const nodes = [...nodeIds].sort();
  const n = nodes.length;
  if (n === 0) return new Map();
  const index = new Map<string, number>();
  nodes.forEach((id, i) => index.set(id, i));

  // Build normalized teleport vector p (sum = 1). Fallback to uniform.
  const p = new Float64Array(n);
  let pSum = 0;
  for (const [id, w] of personalization) {
    const i = index.get(id);
    if (i !== undefined && w > 0) {
      p[i]! += w;
      pSum += w;
    }
  }
  if (pSum === 0) {
    p.fill(1 / n);
  } else {
    for (let i = 0; i < n; i++) p[i]! /= pSum;
  }

  // Out-adjacency with per-source total weight (skip edges to unknown nodes).
  const outTargets: number[][] = Array.from({ length: n }, () => []);
  const outWeights: number[][] = Array.from({ length: n }, () => []);
  const outTotal = new Float64Array(n);
  for (const e of edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    const w = e.weight;
    if (s === undefined || t === undefined || !(w > 0)) continue;
    outTargets[s]!.push(t);
    outWeights[s]!.push(w);
    outTotal[s]! += w;
  }

  // Initialize rank at the teleport distribution.
  let rank = new Float64Array(p);
  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Float64Array(n);
    // teleport term
    for (let i = 0; i < n; i++) next[i] = (1 - damping) * p[i]!;
    // dangling mass (nodes with no out-edges) redistributed via p
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outTotal[i] === 0) dangling += rank[i]!;
    const danglingContribution = damping * dangling;
    for (let i = 0; i < n; i++) next[i]! += danglingContribution * p[i]!;
    // link term
    for (let s = 0; s < n; s++) {
      const total = outTotal[s]!;
      if (total === 0) continue;
      const share = (damping * rank[s]!) / total;
      const targets = outTargets[s]!;
      const weights = outWeights[s]!;
      for (let k = 0; k < targets.length; k++) {
        next[targets[k]!]! += share * weights[k]!;
      }
    }
    // convergence (L1)
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i]! - rank[i]!);
    rank = next;
    if (delta < tol) break;
  }

  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) out.set(nodes[i]!, rank[i]!);
  return out;
}

// ── Final combination (spec §9.3) ────────────────────────────────

export interface Signals {
  lex: number;
  sem: number;
  graph: number;
  path: number;
  git: number;
  mem: number;
  note: number;
}

/** score(node) = Σ w_x · signal_x (spec §9.3). Returns the total + breakdown. */
export function combineSignals(signals: Signals, weights: RankingWeights): ScoreBreakdown {
  const lex = weights.w_lex * signals.lex;
  const sem = weights.w_sem * signals.sem;
  const graph = weights.w_graph * signals.graph;
  const path = weights.w_path * signals.path;
  const git = weights.w_git * signals.git;
  const mem = weights.w_mem * signals.mem;
  const note = weights.w_note * signals.note;
  return { lex, sem, graph, path, git, mem, note, total: lex + sem + graph + path + git + mem + note };
}
