/**
 * @repobrain/embeddings — LOCAL multilingual embedding model wrapper (spec §0.1.3, §9.4).
 *
 * RepoBrain bridges Russian task text to English code identifiers using a local
 * embedding model. No network at query time — the model is downloaded once and cached
 * under `.models` (see {@link createEmbedder} `cacheDir`). We use `Xenova/multilingual-e5-small`
 * (dim 384) via transformers.js, mean-pool the token embeddings and L2-normalize the result.
 *
 * The e5 family REQUIRES asymmetric prefixes:
 *   - `query: `   for the task/query being searched with ({@link Embedder.embedQuery})
 *   - `passage: ` for the indexed code chunks ({@link Embedder.embedPassages})
 * Getting these wrong silently degrades retrieval, so they are added here — callers pass
 * raw text.
 */

import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';

/**
 * Default model — Qwen3-Embedding-0.6B (ONNX, 1024-dim, 100+ langs incl. Russian + code).
 * Chosen over multilingual-e5-small after a head-to-head on the RU→EN-code task
 * (relevant−distractor cosine margin 0.13–0.31 vs e5's 0.04–0.06; see DECISIONS D17).
 * e5 remains selectable via config for a lighter/faster index.
 */
const DEFAULT_MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
/** Passages are embedded in chunks of this many to bound peak memory. */
const BATCH_SIZE = 16;

/** Embedding recipe differs per model family (prefixes/instruction + pooling). */
type ModelFamily = 'e5' | 'qwen3' | 'generic';
function familyOf(modelId: string): ModelFamily {
  const m = modelId.toLowerCase();
  if (m.includes('qwen3')) return 'qwen3';
  if (m.includes('e5')) return 'e5';
  return 'generic';
}
/** One-line task instruction for instruction-tuned retrievers (Qwen3). */
const QUERY_INSTRUCTION = 'Given a coding task in any language, retrieve the most relevant code.';

/**
 * Thrown when the embedding model cannot be loaded (e.g. `offline: true` and the model
 * is not cached). The ranker catches this to degrade gracefully to lexical-only signals
 * per spec §9.4 rather than failing the whole request.
 */
export class EmbedderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmbedderUnavailableError';
  }
}

/** A loaded, reusable local embedder. */
export interface Embedder {
  /** The resolved model id backing this embedder. */
  readonly modelId: string;
  /** Embedding dimensionality (384 for the default model). */
  readonly dim: number;
  /** Embed a single query/task string. Prepends the e5 `query: ` prefix. */
  embedQuery(text: string): Promise<Float32Array>;
  /** Embed indexed code chunks. Prepends the e5 `passage: ` prefix to each; batched. */
  embedPassages(texts: string[]): Promise<Float32Array[]>;
}

export interface CreateEmbedderOptions {
  /** HF model id. Default {@link DEFAULT_MODEL_ID}. */
  modelId?: string;
  /** Directory the model is cached in. Default `<cwd>/.models`. */
  cacheDir?: string;
  /**
   * If true, forbid network access (`env.allowRemoteModels = false`). When the model is
   * not cached this throws {@link EmbedderUnavailableError} instead of hitting the network.
   */
  offline?: boolean;
  /** Weight precision. Default `'fp32'`. */
  dtype?: 'fp32' | 'q8';
}

/**
 * The transformers.js feature-extraction pipeline is dynamically typed as a union over all
 * task pipelines; we only ever call it as `(input, options) => Promise<Tensor>`. This is the
 * minimal shape we rely on.
 */
type FeatureExtractor = (
  input: string | string[],
  options: { pooling: 'mean' | 'last_token' | 'cls'; normalize: boolean },
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

/**
 * Load the local embedding model once and return a reusable {@link Embedder}.
 *
 * The pipeline is loaded eagerly here and reused across every `embedQuery`/`embedPassages`
 * call. Any load failure (missing model, offline + not cached, corrupt cache) is wrapped in
 * {@link EmbedderUnavailableError}.
 */
export async function createEmbedder(opts: CreateEmbedderOptions = {}): Promise<Embedder> {
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const cacheDir = opts.cacheDir ?? path.join(process.cwd(), '.models');
  const family = familyOf(modelId);
  // Qwen3 in fp32 is large; q8 keeps size/speed reasonable with negligible quality loss
  // (verified on the RU→EN probe). e5 stays fp32.
  const dtype = opts.dtype ?? (family === 'qwen3' ? 'q8' : 'fp32');
  // Pooling + text formatting are family-specific; getting them wrong silently wrecks recall.
  const pooling: 'mean' | 'last_token' = family === 'qwen3' ? 'last_token' : 'mean';
  const formatQuery =
    family === 'qwen3'
      ? (t: string) => `Instruct: ${QUERY_INSTRUCTION}\nQuery: ${t}`
      : family === 'e5'
        ? (t: string) => `query: ${t}`
        : (t: string) => t;
  const formatPassage = family === 'e5' ? (t: string) => `passage: ${t}` : (t: string) => t;

  // `env` is a process-global singleton in transformers.js. Set both fields explicitly on
  // every call so a prior (e.g. offline) invocation cannot leak configuration into this one.
  env.cacheDir = cacheDir;
  env.allowRemoteModels = opts.offline !== true;

  let extractor: FeatureExtractor;
  try {
    extractor = (await pipeline('feature-extraction', modelId, {
      dtype,
    })) as unknown as FeatureExtractor;
  } catch (err) {
    const where = opts.offline
      ? `offline and not cached in "${cacheDir}"`
      : `could not be loaded from "${cacheDir}"`;
    throw new EmbedderUnavailableError(
      `Embedding model "${modelId}" is unavailable (${where}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  /** Run the pipeline on already-formatted inputs and split the tensor into per-input vectors. */
  async function run(formatted: string[]): Promise<Float32Array[]> {
    if (formatted.length === 0) return [];
    const out = await extractor(formatted, { pooling, normalize: true });
    const flat = out.data;
    const dims = out.dims;
    // A batch input yields dims [n, dim]; a degenerate single yields [dim].
    const n = dims.length >= 2 ? dims[0] ?? formatted.length : formatted.length;
    const width = dims[dims.length - 1] ?? 0;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      const vec = new Float32Array(width);
      for (let j = 0; j < width; j++) vec[j] = flat[i * width + j] ?? 0;
      vectors.push(vec);
    }
    return vectors;
  }

  // Determine dimensionality dynamically from the model (384 for e5, 1024 for Qwen3-0.6B, …).
  const [probe] = await run([formatPassage('probe')]);
  const dim = probe?.length ?? 0;
  if (dim === 0) {
    throw new EmbedderUnavailableError(`Embedding model "${modelId}" produced a zero-length vector`);
  }

  return {
    modelId,
    dim,
    async embedQuery(text: string): Promise<Float32Array> {
      const [vec] = await run([formatQuery(text)]);
      if (!vec) {
        throw new Error(`Embedding failed to produce a vector for query (model "${modelId}")`);
      }
      return vec;
    },
    async embedPassages(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      // Chunk to bound peak memory; process chunks sequentially, preserving order.
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const chunk = texts.slice(i, i + BATCH_SIZE).map(formatPassage);
        const vecs = await run(chunk);
        for (const v of vecs) out.push(v);
      }
      return out;
    },
  };
}

/**
 * Build the passage text embedded for a symbol skeleton. The indexer calls this and feeds
 * the result to {@link Embedder.embedPassages}. Fields are joined by ` \n ` in the order
 * [path, qualified_name || name, signature, docstring], skipping empty ones.
 */
export function embeddingText(sym: {
  name: string;
  qualified_name?: string;
  signature?: string | null;
  docstring?: string | null;
  path?: string;
}): string {
  const parts: Array<string | null | undefined> = [
    sym.path,
    sym.qualified_name || sym.name,
    sym.signature,
    sym.docstring,
  ];
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(' \n ');
}
