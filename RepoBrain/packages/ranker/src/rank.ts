import type { GraphStore } from '@repobrain/graph-store';
import type { Embedder } from '@repobrain/embeddings';
import type { SymbolRecord, FileRecord, RankingWeights, ScoreBreakdown, MemoryRecord } from '@repobrain/shared';
import { DEFAULT_WEIGHTS } from '@repobrain/shared';
import {
  cosine,
  minMaxNormalize,
  normalizeBm25,
  personalizedPageRank,
  combineSignals,
  type PageRankEdge,
} from './scoring.js';

export interface RankedSymbol {
  symbol: SymbolRecord;
  file: FileRecord;
  score: number;
  breakdown: ScoreBreakdown;
  reasons: string[];
}

export interface RankOptions {
  weights?: RankingWeights;
  limit?: number; // top-N symbols returned (default 40)
  semTopK?: number; // semantic candidate pool (default 40)
  lexLimit?: number; // FTS hits (default 40)
  maxCandidates?: number; // safety cap (default 400)
  noteLimit?: number; // second-brain notes walked for the note→code bridge (default 10)
}

const DEFAULT_MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';

function symNode(id: number): string {
  return 's' + id;
}
function fileNode(id: number): string {
  return 'f' + id;
}

function dirOverlap(a: string, b: string): number {
  const da = a.split('/').slice(0, -1);
  const db = b.split('/').slice(0, -1);
  const n = Math.min(da.length, db.length);
  let shared = 0;
  for (let i = 0; i < n; i++) {
    if (da[i] === db[i]) shared++;
    else break;
  }
  const denom = Math.max(da.length, db.length, 1);
  return shared / denom;
}

function memoryMatches(mem: MemoryRecord, file: FileRecord, sym: SymbolRecord): boolean {
  return (
    mem.related_files.includes(file.path) ||
    mem.related_symbols.includes(sym.qualified_name) ||
    mem.related_symbols.includes(sym.name)
  );
}

/**
 * Rank symbols for a task using the hybrid formula (spec §9.3).
 * Cross-language bridge (§0.1.3): semantic (e5 cosine) candidates + PPR personalization
 * seeded from semantic hits — so a Russian task reaches English identifiers.
 */
export async function rankForTask(
  store: GraphStore,
  embedder: Embedder | null,
  task: string,
  opts: RankOptions = {},
): Promise<RankedSymbol[]> {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const limit = opts.limit ?? 40;
  const semTopK = opts.semTopK ?? 40;
  const lexLimit = opts.lexLimit ?? 40;
  const maxCandidates = opts.maxCandidates ?? 400;
  const modelId = store.getSetting('model_id') ?? DEFAULT_MODEL;

  // ── semantic ──
  const semBySym = new Map<number, number>();
  if (embedder) {
    const qvec = await embedder.embedQuery(task);
    for (const { symbol_id, vector } of store.allVectors(modelId)) {
      semBySym.set(symbol_id, cosine(qvec, vector));
    }
  }
  const semTop = [...semBySym.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, semTopK);

  // ── lexical ──
  const symFts = store.searchSymbolsFts(task, lexLimit);
  const lexIds = symFts.map((h) => h.item.id);
  const lexNormArr = normalizeBm25(symFts.map((h) => h.bm25));
  const lexBySym = new Map<number, number>();
  lexIds.forEach((id, i) => lexBySym.set(id, lexNormArr[i] ?? 0));
  const fileFts = store.searchFilesFts(task, lexLimit);

  // ── notes → code bridge: the 'documents' edges a Russian query can already reach ──
  // Fan-out damping: a note that documents 30 files says far less about any single one of
  // them than a note that documents 3. Without it the broadest note in the top-N floods the
  // capsule and buries the precise note ranked just below it (measured on vibeceh-platform).
  const noteHits = store.searchMemoriesFts(task, opts.noteLimit ?? 10);
  const noteNorm = normalizeBm25(noteHits.map((h) => h.bm25));
  const noteFileScore = new Map<number, number>();
  noteHits.forEach((h, i) => {
    const documented = store.edgesFrom('memory', h.item.id).filter((e) => e.target_type === 'file');
    if (documented.length === 0) return;
    const damping = Math.sqrt(documented.length);
    for (const e of documented) {
      const w = ((noteNorm[i] ?? 0) * e.confidence) / damping;
      noteFileScore.set(e.target_id, Math.max(noteFileScore.get(e.target_id) ?? 0, w));
    }
  });
  const noteMax = Math.max(0, ...noteFileScore.values());
  if (noteMax > 0) for (const [id, w] of noteFileScore) noteFileScore.set(id, w / noteMax);

  // ── candidate assembly ──
  const candidateIds = new Set<number>();
  for (const id of lexBySym.keys()) candidateIds.add(id);
  for (const [id] of semTop) candidateIds.add(id);
  for (const fh of fileFts) for (const s of store.symbolsByFile(fh.item.id)) candidateIds.add(s.id);
  for (const fileId of noteFileScore.keys()) for (const s of store.symbolsByFile(fileId)) candidateIds.add(s.id);
  // 1-hop graph neighbours (callees/callers) of current seeds
  for (const id of [...candidateIds]) {
    for (const e of store.edgesFrom('symbol', id)) if (e.target_type === 'symbol') candidateIds.add(e.target_id);
    for (const e of store.edgesTo('symbol', id)) if (e.source_type === 'symbol') candidateIds.add(e.source_id);
    if (candidateIds.size > maxCandidates) break;
  }

  // ── personalization (seed = lexical + semantic) ──
  // NB: seeding PPR with raw cosine (band ~0.75–0.87) keeps the teleport soft, so PPR
  // retains real graph-centrality — which is what keeps central services (e.g.
  // llm-router) in the capsule. D15's "peaked seeds" collapsed that signal and
  // regressed retrieval on kora, so it was reverted (see DECISIONS D16).
  const personalization = new Map<string, number>();
  for (const [id, s] of lexBySym) personalization.set(symNode(id), (personalization.get(symNode(id)) ?? 0) + s);
  for (const [id, s] of semTop) personalization.set(symNode(id), (personalization.get(symNode(id)) ?? 0) + s);
  for (const fh of fileFts) personalization.set(fileNode(fh.item.id), (personalization.get(fileNode(fh.item.id)) ?? 0) + 0.5);
  for (const [fileId, w] of noteFileScore) personalization.set(fileNode(fileId), (personalization.get(fileNode(fileId)) ?? 0) + w);

  // ── graph (files + symbols) ──
  const allSyms = store.allSymbols();
  const allFilesList = store.allFiles();
  const nodeIds: string[] = [];
  for (const s of allSyms) nodeIds.push(symNode(s.id));
  for (const f of allFilesList) nodeIds.push(fileNode(f.id));
  const edges: PageRankEdge[] = [];
  for (const e of store.edgesForRanking()) {
    const src = e.source_type === 'symbol' ? symNode(e.source_id) : e.source_type === 'file' ? fileNode(e.source_id) : null;
    const tgt = e.target_type === 'symbol' ? symNode(e.target_id) : e.target_type === 'file' ? fileNode(e.target_id) : null;
    if (!src || !tgt) continue;
    edges.push({ source: src, target: tgt, weight: Math.max(e.confidence, 0.05) });
    if (e.edge_type === 'defines') edges.push({ source: tgt, target: src, weight: 0.5 }); // file↔symbol interflow
  }
  const ppr = personalizedPageRank(nodeIds, edges, personalization);

  // ── candidate signal computation ──
  const fileById = new Map(allFilesList.map((f) => [f.id, f] as const));
  const cands: SymbolRecord[] = [];
  for (const id of candidateIds) {
    const s = store.getSymbol(id);
    if (s) cands.push(s);
  }
  if (cands.length === 0) return [];

  // seed files for path affinity = files of the strongest lex+sem hits
  const seedScore = new Map<number, number>();
  for (const [id, s] of lexBySym) seedScore.set(id, (seedScore.get(id) ?? 0) + s);
  for (const [id, s] of semTop) seedScore.set(id, (seedScore.get(id) ?? 0) + s);
  const seedFilePaths = [
    ...[...seedScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id]) => store.getSymbol(id)?.file_id),
    ...[...noteFileScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([fileId]) => fileId),
  ]
    .map((fid) => (fid !== undefined ? fileById.get(fid)?.path : undefined))
    .filter((p): p is string => !!p);

  const memories = store.allMemories();

  const pprVals = cands.map((s) => ppr.get(symNode(s.id)) ?? 0);
  const pprNorm = minMaxNormalize(pprVals);
  const semVals = cands.map((s) => semBySym.get(s.id) ?? 0);
  const semNorm = minMaxNormalize(semVals);
  const churnVals = cands.map((s) => fileById.get(s.file_id)?.git_churn ?? 0);
  const churnNorm = minMaxNormalize(churnVals);
  const dateVals = cands.map((s) => {
    const d = fileById.get(s.file_id)?.git_last_date;
    return d ? Date.parse(d) || 0 : 0;
  });
  const dateNorm = minMaxNormalize(dateVals);

  const ranked: RankedSymbol[] = cands.map((sym, i) => {
    const file = fileById.get(sym.file_id)!;
    const lex = lexBySym.get(sym.id) ?? 0;
    const sem = semNorm[i] ?? 0;
    const graph = pprNorm[i] ?? 0;
    const path = seedFilePaths.length ? Math.max(...seedFilePaths.map((p) => dirOverlap(file.path, p))) : 0;
    const git = 0.5 * (dateNorm[i] ?? 0) + 0.5 * (churnNorm[i] ?? 0);
    const mem = memories.some((m) => memoryMatches(m, file, sym)) ? 1 : 0;
    const note = noteFileScore.get(sym.file_id) ?? 0;

    const breakdown = combineSignals({ lex, sem, graph, path, git, mem, note }, weights);
    const reasons: string[] = [];
    if (sem > 0.6) reasons.push('semantic match to task');
    if (lex > 0) reasons.push('lexical hit');
    if (graph > 0.5) reasons.push('structurally central in code graph');
    if (path > 0.5) reasons.push('same module as relevant code');
    if (mem > 0) reasons.push('referenced by team memory');
    if (note > 0) reasons.push('описан заметкой второго мозга');
    if (reasons.length === 0) reasons.push('graph-related to relevant code');

    return {
      symbol: sym,
      file,
      score: Math.round(breakdown.total * 1e6) / 1e6,
      breakdown,
      reasons,
    };
  });

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0) ||
      a.symbol.start_line - b.symbol.start_line,
  );
  return ranked.slice(0, limit);
}
