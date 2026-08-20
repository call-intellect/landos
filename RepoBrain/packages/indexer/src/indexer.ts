import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { GraphStore } from '@repobrain/graph-store';
import type { NewSymbol, NewEdge, NewFile, NewRoute } from '@repobrain/graph-store';
import { createEmbedder, embeddingText, EmbedderUnavailableError, type Embedder } from '@repobrain/embeddings';
import { scanForSecrets } from '@repobrain/security';
import type { SymbolRecord, NodeType } from '@repobrain/shared';
import { EMBEDDING_MODEL_DIM } from '@repobrain/shared';
import { detectLanguage, grammarFor } from './languages.js';
import { Ignorer } from './ignore.js';
import { walk, looksBinary } from './walk.js';
import { extractFile, type FileExtraction } from './extraction.js';
import { detectFileRoutes } from './file-routes.js';
import { hashContent } from './hash.js';
import { isGitRepo, headCommit, workingTreeDirty, fileGitMeta } from './git.js';
import { resolveImport, isTestPath } from './resolve.js';
import { ingestSecondBrain } from './second-brain.js';
import { ingestAgentMemory } from './agent-memory.js';
import { ingestGeneratedBrain, type BrainLevel } from './second-brain-gen.js';
import { checkStaleness } from './staleness.js';
import { buildNoteCodeEdges } from './note-code-links.js';

export interface IndexOptions {
  root: string;
  dbPath?: string; // default <root>/.repobrain/graph.sqlite
  full?: boolean;
  embed?: boolean; // default true
  modelId?: string; // default multilingual-e5-small
  cacheDir?: string; // model cache; default ~/.cache/repobrain/models (shared across projects)
  maxFileSizeBytes?: number;
  churnWindowDays?: number;
  onProgress?: (msg: string) => void;
  /**
   * Second-brain (knowledge/docs) folder to ingest as the WHY/HOW search channel.
   * Absolute or relative to `root`. Omit to auto-detect `<root>/second-brain`.
   * Set to `false` to skip ingestion entirely.
   */
  secondBrainDir?: string | false;
  /**
   * Agent-memory folder (`memory/*.md`) to ingest as `agent_memory` records.
   * Absolute or relative to `root`. Omit to auto-detect `<root>/memory`.
   * Set to `false` to skip ingestion entirely.
   */
  agentMemoryDir?: string | false;
  /**
   * Generate a code-grounded brain skeleton from the graph (the WHY/HOW layer for a fresh repo
   * that has no hand-written notes). `true`/`false` force on/off; omit for AUTO — generate only
   * when no hand-written second-brain folder is found. Optional level (default L1).
   */
  generateBrain?: boolean;
  generateBrainLevel?: BrainLevel;
}

export interface IndexResult {
  mode: 'full' | 'incremental';
  filesTotal: number;
  filesChanged: number;
  filesUnchanged: number;
  filesDeleted: number;
  symbols: number;
  edges: number;
  embedded: number;
  secretsFound: number;
  parseErrors: number;
  indexCommit: string | null;
  dirty: boolean;
  elapsedMs: number;
  embeddingsAvailable: boolean;
  secondBrainNotes: number; // notes ingested from the second-brain folder (0 if none)
  agentMemoryRecords: number; // records ingested from the agent memory folder (0 if none)
  generatedBrainCards: number; // code-grounded cards generated from the graph (0 if off)
  staleNotes: number; // hand notes flagged stale (cite code that no longer exists)
  foreignRefs: number; // refs skipped as not ours to judge — silence made visible
}

const DEFAULT_MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';

interface PendingFile {
  fileId: number;
  relPath: string;
  dialect: 'typescript' | 'javascript' | 'python';
  isTest: boolean;
  symbols: SymbolRecord[];
  extraction: FileExtraction;
}

export async function indexRepo(opts: IndexOptions): Promise<IndexResult> {
  const startedAt = Date.now();
  const root = opts.root;
  const dbPath = opts.dbPath ?? join(root, '.repobrain', 'graph.sqlite');
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const churnWindow = opts.churnWindowDays ?? 90;
  const wantEmbed = opts.embed ?? true;
  const log = opts.onProgress ?? (() => {});

  mkdirSync(dirname(dbPath), { recursive: true });
  const store = GraphStore.open(dbPath);

  const gitRepo = isGitRepo(root);
  const commit = gitRepo ? headCommit(root) : null;
  const dirty = gitRepo ? workingTreeDirty(root) : false;
  const hadPriorIndex = store.latestIndexRun() !== undefined;
  const mode: 'full' | 'incremental' = opts.full || !hadPriorIndex ? 'full' : 'incremental';
  const runId = store.startIndexRun({
    index_commit: commit,
    working_tree_dirty: dirty,
    mode,
    started_at: startedAt,
  });

  // ── embedder (graceful degradation per §9.4) ──
  let embedder: Embedder | null = null;
  let embeddingsAvailable = false;
  if (wantEmbed) {
    try {
      const cacheDir = opts.cacheDir ?? join(homedir(), '.cache', 'repobrain', 'models');
      embedder = await createEmbedder({ modelId, cacheDir });
      embeddingsAvailable = true;
    } catch (e) {
      if (e instanceof EmbedderUnavailableError) {
        log(`⚠ embeddings unavailable (${e.message}) — indexing without semantic vectors`);
      } else throw e;
    }
  }

  const ignorer = Ignorer.load(root);
  const seen = new Set<string>();
  const pending: PendingFile[] = [];
  const toEmbed: { symbolId: number; text: string; sourceHash: string }[] = [];

  let filesTotal = 0;
  let filesChanged = 0;
  let filesUnchanged = 0;
  let secretsFound = 0;
  let parseErrors = 0;

  // ── Pass A: reconcile files + symbols + vectors ──
  for await (const wf of walk(root, ignorer, { maxSizeBytes: opts.maxFileSizeBytes })) {
    const language = detectLanguage(wf.relPath);
    const grammar = grammarFor(language);
    if (!grammar) continue; // unsupported language
    seen.add(wf.relPath);
    filesTotal++;

    const buf = readFileSync(wf.absPath);
    if (looksBinary(buf)) continue;
    const content = buf.toString('utf8');
    const hash = hashContent(content);

    const existing = store.getFileByPath(wf.relPath);
    if (existing && existing.hash === hash && mode === 'incremental') {
      filesUnchanged++;
      continue; // unchanged — keep file, symbols, edges, vectors
    }
    filesChanged++;

    // secret scan at index time (§7.3)
    const scan = scanForSecrets(content);
    if (scan.hasSecrets) secretsFound += scan.findings.length;

    // parse + extract
    let extraction: FileExtraction;
    let parseStatus: 'ok' | 'partial_parse' | 'parse_error' = 'ok';
    try {
      extraction = await extractFile(content, grammar.dialect, grammar.wasm);
      if (extraction.parseError) parseStatus = 'partial_parse';
    } catch {
      parseErrors++;
      parseStatus = 'parse_error';
      extraction = { symbols: [], refs: [], imports: [], routes: [], exportedNames: [], parseError: true };
    }

    const gm = gitRepo ? fileGitMeta(root, wf.relPath, churnWindow) : { last_commit: null, last_date: null, churn: 0 };
    const isTest = isTestPath(wf.relPath);

    const newFile: NewFile = {
      path: wf.relPath,
      language,
      hash,
      size_bytes: wf.size,
      lines_count: content.length === 0 ? 0 : content.split('\n').length,
      last_modified: Math.round(wf.mtimeMs),
      parse_status: parseStatus,
      is_test: isTest,
      is_generated: false,
      has_secrets: scan.hasSecrets,
      package_id: null,
      git_last_commit: gm.last_commit,
      git_last_date: gm.last_date,
      git_churn: gm.churn,
    };
    const fileId = store.upsertFile(newFile);

    const newSymbols: NewSymbol[] = extraction.symbols.map((s) => ({
      file_id: fileId,
      name: s.name,
      qualified_name: s.qualified_name,
      kind: s.kind,
      signature: s.signature,
      docstring: s.docstring,
      start_line: s.start_line,
      end_line: s.end_line,
      visibility: s.visibility,
      exported: s.exported,
      hash: hashContent(`${s.kind}|${s.qualified_name}|${s.signature}|${s.docstring ?? ''}`),
    }));
    const inserted = store.replaceFileSymbols(fileId, newSymbols);

    // collect embeddings for changed symbols (incremental by source_hash)
    if (embedder) {
      for (const sym of inserted) {
        const text = embeddingText({
          path: wf.relPath,
          name: sym.name,
          qualified_name: sym.qualified_name,
          signature: sym.signature,
          docstring: sym.docstring,
        });
        const sourceHash = hashContent(text);
        const meta = store.getVectorMeta(sym.id, modelId);
        if (!meta || meta.source_hash !== sourceHash) {
          toEmbed.push({ symbolId: sym.id, text, sourceHash });
        }
      }
    }

    pending.push({ fileId, relPath: wf.relPath, dialect: grammar.dialect, isTest, symbols: inserted, extraction });
  }

  // ── delete files no longer present ──
  let filesDeleted = 0;
  for (const f of store.allFiles()) {
    if (!seen.has(f.path)) {
      store.deleteFileByPath(f.path);
      filesDeleted++;
    }
  }

  // ── batch embed changed symbols ──
  let embedded = 0;
  if (embedder && toEmbed.length > 0) {
    log(`embedding ${toEmbed.length} symbols…`);
    const vectors = await embedder.embedPassages(toEmbed.map((t) => t.text));
    store.transaction(() => {
      for (let i = 0; i < toEmbed.length; i++) {
        const t = toEmbed[i]!;
        store.upsertVector(t.symbolId, modelId, embedder.dim, vectors[i]!, t.sourceHash);
        embedded++;
      }
    });
  }

  // ── Pass B: rebuild edges for changed files (global symbol index for resolution) ──
  const fileSet = new Set(store.allFiles().map((f) => f.path));
  const allSyms = store.allSymbols();
  const nameToSymbols = new Map<string, SymbolRecord[]>();
  for (const s of allSyms) {
    const arr = nameToSymbols.get(s.name) ?? [];
    arr.push(s);
    nameToSymbols.set(s.name, arr);
  }
  const fileIdByPath = new Map(store.allFiles().map((f) => [f.path, f.id] as const));

  let edges = 0;
  for (const pf of pending) {
    const fileEdges: NewEdge[] = [];

    // defines (file → symbol, exact)
    for (const sym of pf.symbols) {
      fileEdges.push(edge('file', pf.fileId, 'symbol', sym.id, 'defines', 1.0, 'exact', pf.fileId, sym.start_line));
    }

    // imports (file → file, exact)
    const importedFileIds = new Set<number>();
    for (const imp of pf.extraction.imports) {
      const target = resolveImport(pf.relPath, imp.source, fileSet, pf.dialect);
      if (target) {
        const tid = fileIdByPath.get(target);
        if (tid !== undefined && tid !== pf.fileId) {
          importedFileIds.add(tid);
          fileEdges.push(edge('file', pf.fileId, 'file', tid, 'imports', 1.0, 'exact', pf.fileId, imp.line));
        }
      }
    }

    // calls (symbol → symbol, heuristic) + tested_by
    const localSorted = [...pf.symbols].sort((a, b) => a.start_line - b.start_line);
    for (const ref of pf.extraction.refs) {
      const targets = (nameToSymbols.get(ref.name) ?? []).filter((t) => t.file_id !== pf.fileId || true);
      const defTargets = targets.filter((t) => t.kind === 'function' || t.kind === 'method' || t.kind === 'class');
      const chosen = defTargets.length > 0 ? defTargets : targets;
      if (chosen.length === 0) continue;

      if (pf.isTest) {
        for (const t of chosen.slice(0, 5)) {
          fileEdges.push(edge('symbol', t.id, 'file', pf.fileId, 'tested_by', 0.6, 'heuristic', pf.fileId, ref.line));
        }
        continue;
      }
      const caller = enclosingSymbol(localSorted, ref.line);
      if (!caller) continue;
      for (const t of chosen.slice(0, 5)) {
        if (t.id === caller.id) continue;
        const importedBoost = importedFileIds.has(t.file_id);
        const confidence = importedBoost ? 0.85 : chosen.length === 1 ? 0.7 : 0.4;
        fileEdges.push(edge('symbol', caller.id, 'symbol', t.id, 'calls', confidence, 'heuristic', pf.fileId, ref.line));
      }
    }

    store.replaceFileEdges(pf.fileId, fileEdges);
    edges += fileEdges.length;

    // routes (handler resolution best-effort: enclosing symbol at the route line)
    const localSortedR = [...pf.symbols].sort((a, b) => a.start_line - b.start_line);
    const astRoutes: NewRoute[] = pf.extraction.routes.map((rt) => ({
      method: rt.method,
      path: rt.path,
      handler_symbol_id: enclosingSymbol(localSortedR, rt.line)?.id ?? null,
      file_id: pf.fileId,
      framework: rt.framework,
      line: rt.line,
    }));
    const symbolByName = new Map(pf.symbols.map((s) => [s.name, s] as const));
    const fileRoutes: NewRoute[] = detectFileRoutes(pf.relPath, pf.extraction.exportedNames).map((rt) => ({
      method: rt.method,
      path: rt.path,
      handler_symbol_id: symbolByName.get(rt.method)?.id ?? null,
      file_id: pf.fileId,
      framework: rt.framework,
      line: rt.line,
    }));
    store.replaceFileRoutes(pf.fileId, pf.isTest ? [] : [...astRoutes, ...fileRoutes]);
  }

  // ── second-brain (WHY/HOW) ingestion — the double-search knowledge channel ──
  let secondBrainNotes = 0;
  let handBrainFound = false;
  if (opts.secondBrainDir !== false) {
    const dirOpt = typeof opts.secondBrainDir === 'string' ? opts.secondBrainDir : undefined;
    const sb = ingestSecondBrain(store, root, { dir: dirOpt, onProgress: log });
    if (sb) {
      secondBrainNotes = sb.notes;
      handBrainFound = true;
    }
  }

  // ── agent memory (`memory/*.md`) ingestion — records the agent wrote about itself and the owner ──
  let agentMemoryRecords = 0;
  if (opts.agentMemoryDir !== false) {
    const dirOpt = typeof opts.agentMemoryDir === 'string' ? opts.agentMemoryDir : undefined;
    const am = ingestAgentMemory(store, root, { dir: dirOpt, onProgress: log });
    if (am) agentMemoryRecords = am.notes;
  }

  // ── code-grounded brain generation ── AUTO: generate the skeleton when there are no hand-written
  // notes (day-one WHY/HOW for a fresh repo); explicit true/false overrides. Always safe: measured
  // to not regress retrieval when hand notes exist (docs/DECISIONS.md).
  let generatedBrainCards = 0;
  const wantGen = opts.generateBrain ?? !handBrainFound;
  if (wantGen) {
    const g = ingestGeneratedBrain(store, { level: opts.generateBrainLevel, onProgress: log });
    generatedBrainCards = g.cards;
  } else {
    store.deleteMemoriesByType('generated_brain'); // stale skeleton if hand notes now exist
  }

  // ── staleness: flag hand notes whose cited code no longer exists (drift is the enemy) ──
  const stale = handBrainFound ? checkStaleness(store, log, root) : { stale: 0, foreignRefs: 0 };

  // ── note↔code edges (H2a): link every note to the code files it documents, from related_files ──
  if (secondBrainNotes > 0 || generatedBrainCards > 0) buildNoteCodeEdges(store, log);

  store.setSetting('model_id', modelId);
  store.setSetting('embedding_dim', String(embedder?.dim ?? EMBEDDING_MODEL_DIM));
  store.finishIndexRun(runId, {
    files_total: filesTotal,
    files_changed: filesChanged,
    finished_at: Date.now(),
  });
  store.close();

  return {
    mode,
    filesTotal,
    filesChanged,
    filesUnchanged,
    filesDeleted,
    symbols: allSyms.length,
    edges,
    embedded,
    secretsFound,
    parseErrors,
    indexCommit: commit,
    dirty,
    elapsedMs: Date.now() - startedAt,
    embeddingsAvailable,
    secondBrainNotes,
    agentMemoryRecords,
    generatedBrainCards,
    staleNotes: stale.stale,
    foreignRefs: stale.foreignRefs,
  };
}

function enclosingSymbol(sortedByStart: SymbolRecord[], line: number): SymbolRecord | null {
  let best: SymbolRecord | null = null;
  for (const s of sortedByStart) {
    if (s.start_line <= line && line <= s.end_line) {
      if (!best || s.start_line > best.start_line) best = s;
    }
  }
  return best;
}

function edge(
  sourceType: NodeType,
  sourceId: number,
  targetType: NodeType,
  targetId: number,
  edgeType: NewEdge['edge_type'],
  confidence: number,
  resolution: 'exact' | 'heuristic',
  fileId: number,
  line: number,
): NewEdge {
  return {
    source_type: sourceType,
    source_id: sourceId,
    target_type: targetType,
    target_id: targetId,
    edge_type: edgeType,
    confidence,
    resolution,
    file_id: fileId,
    line,
  };
}
