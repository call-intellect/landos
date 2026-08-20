import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { GraphStore } from '@repobrain/graph-store';
import { createEmbedder, EmbedderUnavailableError, type Embedder } from '@repobrain/embeddings';
import { indexRepo, git } from '@repobrain/indexer';
import { buildCapsule } from '@repobrain/capsule-builder';
import type { Freshness } from '@repobrain/shared';

export interface EvalTask {
  task: string;
  lang?: string;
  cross_language?: boolean;
  gold_files: string[];
  gold_symbols?: string[];
}

export interface TaskResult {
  task: string;
  crossLanguage: boolean;
  recall: number;
  precision: number;
  foundGold: string[];
  missedGold: string[];
  capsuleTokens: number;
  capsuleFileCount: number;
}

export interface EvalReport {
  exampleDir: string;
  budget: number;
  model: string;
  embeddingsAvailable: boolean;
  tasks: TaskResult[];
  recall: number; // mean recall@budget over all tasks
  crossLangRecall: number; // mean over cross_language tasks
  precision: number;
  meanCapsuleTokens: number;
  passed: boolean; // recall >= 0.8 && crossLangRecall >= 0.7
}

export interface RunEvalOptions {
  exampleDir: string; // e.g. examples/typescript-app
  dbPath?: string;
  budget?: number;
  model?: string;
  reindex?: boolean; // default: index if no db
  cacheDir?: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function loadTasks(exampleDir: string): EvalTask[] {
  const p = join(exampleDir, 'eval', 'tasks.yaml');
  const raw = parse(readFileSync(p, 'utf8')) as EvalTask[];
  return raw ?? [];
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const exampleDir = opts.exampleDir;
  const budget = opts.budget ?? 8000;
  const model = opts.model ?? 'generic';
  const dbPath = opts.dbPath ?? join(exampleDir, '.repobrain', 'graph.sqlite');

  if (opts.reindex || !existsSync(dbPath)) {
    await indexRepo({ root: exampleDir, dbPath, full: true, cacheDir: opts.cacheDir });
  }

  const store = GraphStore.open(dbPath);

  let embedder: Embedder | null = null;
  let embeddingsAvailable = false;
  try {
    embedder = await createEmbedder({ cacheDir: opts.cacheDir });
    embeddingsAvailable = true;
  } catch (e) {
    if (!(e instanceof EmbedderUnavailableError)) throw e;
  }

  const run = store.latestIndexRun();
  const freshness: Freshness = {
    index_commit: run?.index_commit ?? null,
    dirty: git.isGitRepo(exampleDir) ? git.workingTreeDirty(exampleDir) : false,
    changed_since_index: git.isGitRepo(exampleDir) ? git.changedSince(exampleDir, run?.index_commit ?? null) : 0,
  };

  const tasks = loadTasks(exampleDir);
  const results: TaskResult[] = [];

  for (const t of tasks) {
    const { capsule } = await buildCapsule(store, embedder, t.task, {
      root: exampleDir,
      budget,
      model,
      freshness,
    });
    const capsulePaths = new Set(capsule.items.map((i) => i.path).filter((p): p is string => !!p));
    const gold = t.gold_files;
    const found = gold.filter((g) => capsulePaths.has(g));
    const recall = gold.length ? found.length / gold.length : 1;
    const precision = capsulePaths.size ? found.length / capsulePaths.size : 0;
    results.push({
      task: t.task,
      crossLanguage: !!t.cross_language,
      recall,
      precision,
      foundGold: found,
      missedGold: gold.filter((g) => !capsulePaths.has(g)),
      capsuleTokens: capsule.token_estimate,
      capsuleFileCount: capsulePaths.size,
    });
  }
  store.close();

  const recall = mean(results.map((r) => r.recall));
  const crossLangRecall = mean(results.filter((r) => r.crossLanguage).map((r) => r.recall));
  const precision = mean(results.map((r) => r.precision));
  const meanCapsuleTokens = mean(results.map((r) => r.capsuleTokens));

  return {
    exampleDir,
    budget,
    model,
    embeddingsAvailable,
    tasks: results,
    recall,
    crossLangRecall,
    precision,
    meanCapsuleTokens,
    passed: recall >= 0.8 && crossLangRecall >= 0.7,
  };
}
