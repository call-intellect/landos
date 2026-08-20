import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GraphStore } from '@repobrain/graph-store';
import { createEmbedder, EmbedderUnavailableError, type Embedder } from '@repobrain/embeddings';
import { rankForTask } from '@repobrain/ranker';
import { buildCapsule, type CapsuleResult } from '@repobrain/capsule-builder';
import { countTokens } from '@repobrain/token-meter';
import { rememberDecision, searchMemory, preActionWarnings, codeQueryLanguageWarning, type RememberInput, type MemoryWarning } from '@repobrain/memory';
import type {
  Freshness,
  SymbolRecord,
  FileRecord,
  RouteRecord,
  MemoryRecord,
  RankingWeights,
  SymbolKind,
  Resolution,
} from '@repobrain/shared';
import * as git from './git.js';

export interface OpenOptions {
  dbPath?: string;
  cacheDir?: string;
  embed?: boolean; // default FALSE — graph-first. Semantic embeddings are opt-in (see D18).
}

export interface CapsuleOptions {
  budget?: number;
  model?: string;
  weights?: RankingWeights;
  noteLimit?: number;
}

export interface SearchResult {
  path: string;
  symbol: string;
  kind: SymbolKind;
  score: number;
  reason: string;
}

export interface SymbolHit {
  symbol: SymbolRecord;
  path: string;
}

export interface EdgeHit {
  symbol: SymbolRecord;
  path: string;
  confidence: number;
  resolution: Resolution;
  line: number | null;
}

export interface FileOverview {
  file: FileRecord;
  symbols: SymbolRecord[];
  imports: string[];
  importedBy: string[];
}

export interface ImpactResult {
  target: string;
  file: string | null;
  importers: string[];
  callers: string[];
  tests: string[];
}

export interface ArchitectureSummary {
  languages: Record<string, number>;
  counts: { files: number; symbols: number; edges: number; routes: number };
  modules: { dir: string; files: number }[];
  entrypoints: string[];
  godFiles: { path: string; symbols: number; importedBy: number }[];
  routes: RouteRecord[];
}

export class NotIndexedError extends Error {}

export class RepoBrain {
  private constructor(
    readonly root: string,
    readonly store: GraphStore,
    readonly embedder: Embedder | null,
  ) {}

  static async open(root: string, opts: OpenOptions = {}): Promise<RepoBrain> {
    const dbPath = opts.dbPath ?? join(root, '.repobrain', 'graph.sqlite');
    if (!existsSync(dbPath)) {
      throw new NotIndexedError(`No index found at ${dbPath}. Run \`repobrain index\` first.`);
    }
    const store = GraphStore.open(dbPath);
    let embedder: Embedder | null = null;
    if (opts.embed === true) {
      try {
        // Query with the SAME model the index was built with — otherwise vectors are a
        // different dim/space and semantic ranking is silently broken (a real bug hit when
        // the default model changed under an existing index).
        const modelId = store.getSetting('model_id') ?? undefined;
        embedder = await createEmbedder({ cacheDir: opts.cacheDir, modelId });
      } catch (e) {
        if (!(e instanceof EmbedderUnavailableError)) throw e;
      }
    }
    return new RepoBrain(root, store, embedder);
  }

  close(): void {
    this.store.close();
  }

  get embeddingsAvailable(): boolean {
    return this.embedder !== null;
  }

  freshness(): Freshness {
    const run = this.store.latestIndexRun();
    const gitRepo = git.isGitRepo(this.root);
    return {
      index_commit: run?.index_commit ?? null,
      dirty: gitRepo ? git.workingTreeDirty(this.root) : false,
      changed_since_index: gitRepo ? git.changedSince(this.root, run?.index_commit ?? null) : 0,
    };
  }

  async capsule(
    task: string,
    opts: CapsuleOptions = {},
  ): Promise<CapsuleResult & { warnings: MemoryWarning[] }> {
    const freshness = this.freshness();
    const model = opts.model ?? 'generic';
    const langWarning = codeQueryLanguageWarning(task);
    const warnings = [...(langWarning ? [langWarning] : []), ...preActionWarnings(this.store, task)];
    const result = await buildCapsule(this.store, this.embedder, task, {
      root: this.root,
      budget: opts.budget,
      model,
      weights: opts.weights,
      noteLimit: opts.noteLimit,
      freshness,
    });
    for (const w of warnings) result.capsule.memory_notes.unshift(`⚠ ${w.warning}`);

    // ROI logging (spec §14). naive_estimate models what an agent spends WITHOUT RepoBrain:
    // it reads the relevant files FULLY (no skeletonization) and, not knowing which files
    // matter, wastes ~50% more on wrong guesses/re-reads, plus a per-file grep/ls scan.
    // This is a heuristic estimate (documented as such); the real win grows with repo size.
    let fullTokens = 0;
    for (const it of result.capsule.items) {
      if (!it.path) continue;
      try {
        fullTokens += countTokens(readFileSync(join(this.root, it.path), 'utf8'), model).tokens;
      } catch {
        /* ignore */
      }
    }
    const naive = Math.round(fullTokens * 1.5) + this.store.allFiles().length * 30;
    this.store.logCapsule({
      task,
      index_commit: freshness.index_commit,
      capsule_tokens: result.capsule.token_estimate,
      naive_estimate: naive,
      tokenizer_used: result.capsule.tokenizer_used,
      model,
      created_at: Date.now(),
    });
    return { ...result, warnings };
  }

  async searchCode(query: string, limit = 15): Promise<SearchResult[]> {
    const ranked = await rankForTask(this.store, this.embedder, query, { limit });
    return ranked.map((r) => ({
      path: r.file.path,
      symbol: r.symbol.qualified_name,
      kind: r.symbol.kind,
      score: r.score,
      reason: r.reasons.join('; '),
    }));
  }

  findSymbol(name: string, kind?: SymbolKind): SymbolHit[] {
    return this.store.findSymbolsByName(name, kind).map((symbol) => ({
      symbol,
      path: this.store.getFile(symbol.file_id)?.path ?? '?',
    }));
  }

  fileOverview(path: string): FileOverview | null {
    const file = this.store.getFileByPath(path);
    if (!file) return null;
    const symbols = this.store.symbolsByFile(file.id).sort((a, b) => a.start_line - b.start_line);
    const imports: string[] = [];
    for (const e of this.store.edgesFrom('file', file.id)) {
      if (e.edge_type === 'imports' && e.target_type === 'file') {
        const f = this.store.getFile(e.target_id);
        if (f) imports.push(f.path);
      }
    }
    const importedBy: string[] = [];
    for (const e of this.store.edgesTo('file', file.id)) {
      if (e.edge_type === 'imports' && e.source_type === 'file') {
        const f = this.store.getFile(e.source_id);
        if (f) importedBy.push(f.path);
      }
    }
    return { file, symbols, imports, importedBy };
  }

  private resolveSymbols(target: string): SymbolRecord[] {
    const asId = Number(target);
    if (Number.isInteger(asId) && asId > 0) {
      const s = this.store.getSymbol(asId);
      return s ? [s] : [];
    }
    return this.store.findSymbolsByName(target);
  }

  callers(target: string): EdgeHit[] {
    const out: EdgeHit[] = [];
    for (const sym of this.resolveSymbols(target)) {
      for (const e of this.store.edgesTo('symbol', sym.id)) {
        if (e.edge_type !== 'calls' || e.source_type !== 'symbol') continue;
        const s = this.store.getSymbol(e.source_id);
        if (s) out.push(this.edgeHit(s, e.confidence, e.resolution, e.line));
      }
    }
    return dedupeEdgeHits(out);
  }

  callees(target: string): EdgeHit[] {
    const out: EdgeHit[] = [];
    for (const sym of this.resolveSymbols(target)) {
      for (const e of this.store.edgesFrom('symbol', sym.id)) {
        if (e.edge_type !== 'calls' || e.target_type !== 'symbol') continue;
        const s = this.store.getSymbol(e.target_id);
        if (s) out.push(this.edgeHit(s, e.confidence, e.resolution, e.line));
      }
    }
    return dedupeEdgeHits(out);
  }

  references(target: string): EdgeHit[] {
    // heuristic: callers are the references-to-a-symbol we can resolve
    return this.callers(target);
  }

  routes(filter?: string): RouteRecord[] {
    const all = this.store.allRoutes();
    if (!filter) return all;
    const f = filter.toLowerCase();
    return all.filter((r) => r.path.toLowerCase().includes(f) || r.method.toLowerCase().includes(f));
  }

  impact(target: string): ImpactResult {
    const syms = this.resolveSymbols(target);
    const file = syms[0] ? this.store.getFile(syms[0].file_id) : undefined;
    const importers: string[] = [];
    const tests: string[] = [];
    if (file) {
      for (const e of this.store.edgesTo('file', file.id)) {
        if (e.edge_type === 'imports' && e.source_type === 'file') {
          const f = this.store.getFile(e.source_id);
          if (f && !importers.includes(f.path)) importers.push(f.path);
        }
      }
    }
    for (const sym of syms) {
      for (const e of this.store.edgesFrom('symbol', sym.id)) {
        if (e.edge_type === 'tested_by' && e.target_type === 'file') {
          const f = this.store.getFile(e.target_id);
          if (f && !tests.includes(f.path)) tests.push(f.path);
        }
      }
    }
    const callers = this.callers(target).map((h) => h.symbol.qualified_name);
    return { target, file: file?.path ?? null, importers, callers, tests };
  }

  architecture(): ArchitectureSummary {
    const files = this.store.allFiles();
    const symbols = this.store.allSymbols();
    const edges = this.store.edgesForRanking();
    const languages: Record<string, number> = {};
    for (const f of files) languages[f.language] = (languages[f.language] ?? 0) + 1;

    const moduleCounts = new Map<string, number>();
    const importedByCount = new Map<number, number>();
    const symbolCount = new Map<number, number>();
    for (const f of files) {
      const seg = f.path.split('/').slice(0, 2).join('/');
      moduleCounts.set(seg, (moduleCounts.get(seg) ?? 0) + 1);
    }
    for (const s of symbols) symbolCount.set(s.file_id, (symbolCount.get(s.file_id) ?? 0) + 1);
    for (const e of edges) {
      if (e.edge_type === 'imports' && e.target_type === 'file') {
        importedByCount.set(e.target_id, (importedByCount.get(e.target_id) ?? 0) + 1);
      }
    }
    const entrypoints = files
      .filter((f) => (importedByCount.get(f.id) ?? 0) === 0 && (symbolCount.get(f.id) ?? 0) > 0)
      .map((f) => f.path)
      .filter((p) => /(main|index|app|server|cli|__main__)\.[a-z]+$/i.test(p) || true)
      .slice(0, 10);
    const godFiles = files
      .map((f) => ({ path: f.path, symbols: symbolCount.get(f.id) ?? 0, importedBy: importedByCount.get(f.id) ?? 0 }))
      .sort((a, b) => b.symbols + b.importedBy * 2 - (a.symbols + a.importedBy * 2))
      .slice(0, 5);

    return {
      languages,
      counts: { files: files.length, symbols: symbols.length, edges: edges.length, routes: this.store.allRoutes().length },
      modules: [...moduleCounts.entries()].map(([dir, f]) => ({ dir, files: f })).sort((a, b) => b.files - a.files),
      entrypoints,
      godFiles,
      routes: this.store.allRoutes(),
    };
  }

  remember(input: RememberInput): number {
    return rememberDecision(this.store, input);
  }
  teamMemory(query: string, limit = 10): MemoryRecord[] {
    return searchMemory(this.store, query, limit);
  }
  tokenStats(): { count: number; capsule_tokens: number; naive_estimate: number; saved: number } {
    return this.store.capsuleStats();
  }

  private edgeHit(symbol: SymbolRecord, confidence: number, resolution: Resolution, line: number | null): EdgeHit {
    return { symbol, path: this.store.getFile(symbol.file_id)?.path ?? '?', confidence, resolution, line };
  }
}

function dedupeEdgeHits(hits: EdgeHit[]): EdgeHit[] {
  const seen = new Map<number, EdgeHit>();
  for (const h of hits) {
    const prev = seen.get(h.symbol.id);
    if (!prev || h.confidence > prev.confidence) seen.set(h.symbol.id, h);
  }
  return [...seen.values()];
}
