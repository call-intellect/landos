import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DEFAULT_WEIGHTS, type RankingWeights } from '@repobrain/shared';

export interface RepoBrainConfig {
  weights: RankingWeights;
  budget: number;
  model: string;
  embeddingModel: string;
  /**
   * Semantic embeddings are OPT-IN (D18). RepoBrain is graph-first by default:
   * the deterministic tree-sitter graph + FTS is the core, and the AI agent supplies
   * the query terms. Enable only if you want raw-query semantic search as a secondary signal.
   */
  embeddingsEnabled: boolean;
  noteLimit: number;
}

const DEFAULTS: RepoBrainConfig = {
  weights: DEFAULT_WEIGHTS,
  budget: 8000,
  model: 'generic',
  embeddingModel: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
  embeddingsEnabled: false,
  noteLimit: 10,
};

export function loadConfig(root: string): RepoBrainConfig {
  const p = join(root, '.repobrain.yaml');
  if (!existsSync(p)) return DEFAULTS;
  try {
    const y = (parse(readFileSync(p, 'utf8')) ?? {}) as Record<string, any>;
    const w = y.ranking?.weights ?? {};
    const weights: RankingWeights = { ...DEFAULT_WEIGHTS };
    for (const k of Object.keys(DEFAULT_WEIGHTS) as (keyof RankingWeights)[]) {
      if (typeof w[k] === 'number') weights[k] = w[k];
    }
    return {
      weights,
      budget: typeof y.capsule?.default_budget === 'number' ? y.capsule.default_budget : DEFAULTS.budget,
      model: y.capsule?.default_model ?? DEFAULTS.model,
      embeddingModel: y.embedding?.model ?? DEFAULTS.embeddingModel,
      embeddingsEnabled: y.embedding?.enabled === true,
      noteLimit: typeof y.ranking?.note_limit === 'number' ? y.ranking.note_limit : DEFAULTS.noteLimit,
    };
  } catch {
    return DEFAULTS;
  }
}
