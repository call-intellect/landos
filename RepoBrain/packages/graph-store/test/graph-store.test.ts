import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphStore, type NewFile, type NewSymbol, type NewEdge, type NewMemory } from '../src/index.js';

const MODEL_ID = 'intfloat/multilingual-e5-small';

function makeFile(overrides: Partial<NewFile> = {}): NewFile {
  return {
    path: 'src/app.ts',
    language: 'typescript',
    hash: 'h-file-1',
    size_bytes: 120,
    lines_count: 8,
    last_modified: 1_700_000_000_000,
    parse_status: 'ok',
    is_test: false,
    is_generated: false,
    has_secrets: false,
    package_id: null,
    git_last_commit: null,
    git_last_date: null,
    git_churn: 0,
    ...overrides,
  };
}

describe('GraphStore', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = GraphStore.open(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('upserts a package and a file, with incremental re-upsert by path', () => {
    const pkgId = store.upsertPackage({
      name: 'demo',
      root_path: '/repo/demo',
      manifest_path: '/repo/demo/package.json',
    });
    expect(pkgId).toBeGreaterThan(0);

    const fileId = store.upsertFile(makeFile({ package_id: pkgId }));
    expect(fileId).toBeGreaterThan(0);

    const fetched = store.getFile(fileId);
    expect(fetched?.path).toBe('src/app.ts');
    expect(fetched?.is_test).toBe(false); // 0/1 -> boolean at boundary
    expect(fetched?.package_id).toBe(pkgId);

    // Re-upsert by the same path must update in place (same id), not duplicate.
    const again = store.upsertFile(makeFile({ package_id: pkgId, hash: 'h-file-2', git_churn: 3 }));
    expect(again).toBe(fileId);
    expect(store.allFiles()).toHaveLength(1);
    expect(store.getFileByPath('src/app.ts')?.hash).toBe('h-file-2');
    expect(store.getFileByPath('src/app.ts')?.git_churn).toBe(3);
  });

  it('replaces a file’s symbols and inserts edges', () => {
    const fileId = store.upsertFile(makeFile());
    const symbols: NewSymbol[] = [
      {
        file_id: fileId,
        name: 'handleRequest',
        qualified_name: 'app.handleRequest',
        kind: 'function',
        signature: '(req: Request) => Response',
        docstring: 'Handles an incoming request.',
        start_line: 1,
        end_line: 4,
        visibility: 'public',
        exported: true,
        hash: 'sym-hash-1',
      },
      {
        file_id: fileId,
        name: 'InternalHelper',
        qualified_name: 'app.InternalHelper',
        kind: 'class',
        signature: null,
        docstring: null,
        start_line: 5,
        end_line: 8,
        visibility: 'internal',
        exported: false,
        hash: 'sym-hash-2',
      },
    ];

    const inserted = store.replaceFileSymbols(fileId, symbols);
    expect(inserted).toHaveLength(2);
    expect(inserted[0]!.id).toBeGreaterThan(0);
    expect(inserted[0]!.exported).toBe(true); // boolean round-trip
    expect(inserted[1]!.exported).toBe(false);
    expect(store.symbolsByFile(fileId)).toHaveLength(2);

    const [a, b] = inserted;
    const edges: NewEdge[] = [
      {
        source_type: 'symbol',
        source_id: a!.id,
        target_type: 'symbol',
        target_id: b!.id,
        edge_type: 'calls',
        confidence: 0.8,
        resolution: 'heuristic',
        file_id: fileId,
        line: 2,
      },
    ];
    store.insertEdges(edges);

    const from = store.edgesFrom('symbol', a!.id);
    expect(from).toHaveLength(1);
    expect(from[0]!.edge_type).toBe('calls');
    expect(from[0]!.confidence).toBeCloseTo(0.8, 6);
    expect(store.edgesTo('symbol', b!.id)).toHaveLength(1);

    const rank = store.edgesForRanking();
    expect(rank).toHaveLength(1);
    expect(rank[0]).toMatchObject({ source_id: a!.id, target_id: b!.id, edge_type: 'calls' });

    // replaceFileSymbols is a full replace: re-running with one symbol drops the rest.
    store.replaceFileSymbols(fileId, [symbols[0]!]);
    expect(store.symbolsByFile(fileId)).toHaveLength(1);
  });

  it('round-trips a Float32 vector within 1e-6 and tracks its source hash', () => {
    const fileId = store.upsertFile(makeFile());
    const [sym] = store.replaceFileSymbols(fileId, [
      {
        file_id: fileId,
        name: 'embedMe',
        qualified_name: 'app.embedMe',
        kind: 'function',
        signature: null,
        docstring: null,
        start_line: 1,
        end_line: 2,
        visibility: 'public',
        exported: true,
        hash: 'h',
      },
    ]);

    const dim = 5;
    const vec = new Float32Array([0.1, -0.25, 3.14159, 42, -0.000001]);
    store.upsertVector(sym!.id, MODEL_ID, dim, vec, 'src-hash-1');

    expect(store.getVectorMeta(sym!.id, MODEL_ID)).toEqual({ source_hash: 'src-hash-1' });

    const all = store.allVectors(MODEL_ID);
    expect(all).toHaveLength(1);
    expect(all[0]!.symbol_id).toBe(sym!.id);
    const read = all[0]!.vector;
    expect(read).toBeInstanceOf(Float32Array);
    expect(read.length).toBe(dim);
    for (let i = 0; i < dim; i++) {
      expect(read[i]!).toBeCloseTo(vec[i]!, 6);
    }

    // Re-embed: upsert updates the row + source hash rather than duplicating.
    const vec2 = new Float32Array([1, 2, 3, 4, 5]);
    store.upsertVector(sym!.id, MODEL_ID, dim, vec2, 'src-hash-2');
    expect(store.getVectorMeta(sym!.id, MODEL_ID)).toEqual({ source_hash: 'src-hash-2' });
    const all2 = store.allVectors(MODEL_ID);
    expect(all2).toHaveLength(1);
    expect(Array.from(all2[0]!.vector)).toEqual([1, 2, 3, 4, 5]);
  });

  it('finds symbols via FTS5 and is safe against special characters', () => {
    const fileId = store.upsertFile(makeFile());
    store.replaceFileSymbols(fileId, [
      {
        file_id: fileId,
        name: 'authenticateUser',
        qualified_name: 'auth.authenticateUser',
        kind: 'function',
        signature: '(token: string) => User',
        docstring: 'Verifies a session token.',
        start_line: 1,
        end_line: 3,
        visibility: 'public',
        exported: true,
        hash: 'h',
      },
    ]);

    const hits = store.searchSymbolsFts('authenticateUser', 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.item.name).toBe('authenticateUser');
    expect(typeof hits[0]!.bm25).toBe('number');

    // A query full of FTS operators must not throw; tokens are quoted literals.
    const messy = store.searchSymbolsFts('authenticateUser AND (token* OR "', 10);
    expect(messy.length).toBeGreaterThanOrEqual(1);

    // Empty / punctuation-only query returns no hits and runs no MATCH.
    expect(store.searchSymbolsFts('   ', 10)).toEqual([]);
    expect(store.searchSymbolsFts('***', 10)).toEqual([]);

    // Files FTS works over paths.
    const fileHits = store.searchFilesFts('app', 10);
    expect(fileHits.length).toBeGreaterThanOrEqual(1);
    expect(fileHits[0]!.item.path).toBe('src/app.ts');
  });

  it('inserts and searches memories with JSON array round-trips', () => {
    const mem: NewMemory = {
      type: 'architecture_decision',
      title: 'Use SQLite for the code graph',
      body: 'We chose better-sqlite3 for a single-file embedded graph store.',
      related_files: ['src/app.ts', 'src/db.ts'],
      related_symbols: ['app.handleRequest'],
      tags: ['storage', 'decision'],
      stale_status: 'fresh',
    };
    const id = store.insertMemory(mem);
    expect(id).toBeGreaterThan(0);

    const all = store.allMemories();
    expect(all).toHaveLength(1);
    expect(all[0]!.related_files).toEqual(['src/app.ts', 'src/db.ts']); // JSON text -> string[]
    expect(all[0]!.tags).toEqual(['storage', 'decision']);
    expect(all[0]!.stale_status).toBe('fresh');

    const hits = store.searchMemoriesFts('SQLite graph', 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.item.title).toBe('Use SQLite for the code graph');
    expect(store.searchMemoriesFts('', 10)).toEqual([]);
  });

  it('records index runs, settings, and capsule logs', () => {
    const runId = store.startIndexRun({
      index_commit: 'abc123',
      working_tree_dirty: true,
      mode: 'full',
      started_at: 1_700_000_000_000,
    });
    expect(runId).toBeGreaterThan(0);

    let latest = store.latestIndexRun();
    expect(latest?.id).toBe(runId);
    expect(latest?.working_tree_dirty).toBe(true); // 0/1 -> boolean
    expect(latest?.finished_at).toBeNull();

    store.finishIndexRun(runId, {
      files_total: 10,
      files_changed: 3,
      finished_at: 1_700_000_005_000,
    });
    latest = store.latestIndexRun();
    expect(latest?.files_total).toBe(10);
    expect(latest?.files_changed).toBe(3);
    expect(latest?.finished_at).toBe(1_700_000_005_000);

    // A newer run becomes "latest".
    const runId2 = store.startIndexRun({
      index_commit: 'def456',
      working_tree_dirty: false,
      mode: 'incremental',
      started_at: 1_700_000_010_000,
    });
    expect(store.latestIndexRun()?.id).toBe(runId2);

    // settings upsert
    expect(store.getSetting('missing')).toBeUndefined();
    store.setSetting('embedding_model', MODEL_ID);
    expect(store.getSetting('embedding_model')).toBe(MODEL_ID);
    store.setSetting('embedding_model', 'other-model');
    expect(store.getSetting('embedding_model')).toBe('other-model');

    // capsule log write should not throw
    expect(() =>
      store.logCapsule({
        task: 'add auth middleware',
        index_commit: 'abc123',
        capsule_tokens: 1500,
        naive_estimate: 12000,
        tokenizer_used: 'o200k_base',
        model: 'claude',
        created_at: 1_700_000_020_000,
      }),
    ).not.toThrow();
  });

  it('cascades deletes from files to symbols, edges, routes, tests, and vectors', () => {
    const fileId = store.upsertFile(makeFile());
    const [sym] = store.replaceFileSymbols(fileId, [
      {
        file_id: fileId,
        name: 'target',
        qualified_name: 'app.target',
        kind: 'function',
        signature: null,
        docstring: null,
        start_line: 1,
        end_line: 2,
        visibility: 'public',
        exported: true,
        hash: 'h',
      },
    ]);
    store.replaceFileEdges(fileId, [
      {
        source_type: 'file',
        source_id: fileId,
        target_type: 'symbol',
        target_id: sym!.id,
        edge_type: 'defines',
        confidence: 1,
        resolution: 'exact',
        file_id: fileId,
        line: 1,
      },
    ]);
    store.replaceFileRoutes(fileId, [
      {
        method: 'GET',
        path: '/health',
        handler_symbol_id: sym!.id,
        file_id: fileId,
        framework: 'express',
        line: 1,
      },
    ]);
    store.replaceFileTests(fileId, [
      { file_id: fileId, name: 'health works', target_symbol_id: sym!.id, start_line: 1, end_line: 2 },
    ]);
    store.upsertVector(sym!.id, MODEL_ID, 3, new Float32Array([1, 2, 3]), 'sh');

    expect(store.allRoutes()).toHaveLength(1);
    expect(store.edgesForRanking()).toHaveLength(1);
    expect(store.allVectors(MODEL_ID)).toHaveLength(1);

    store.deleteFileByPath('src/app.ts');

    expect(store.allFiles()).toHaveLength(0);
    expect(store.allSymbols()).toHaveLength(0);
    expect(store.edgesForRanking()).toHaveLength(0);
    expect(store.allRoutes()).toHaveLength(0);
    expect(store.allVectors(MODEL_ID)).toHaveLength(0);
  });

  it('runs the migration from a migrationsDir when provided', () => {
    const dir = new URL('../src/migrations/', import.meta.url);
    const s2 = GraphStore.open(':memory:', { migrationsDir: dir.pathname });
    const fid = s2.upsertFile(makeFile({ path: 'src/other.ts' }));
    expect(fid).toBeGreaterThan(0);
    s2.close();
  });
});
