import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { indexRepo, Ignorer, walk, type IndexResult } from '../src/index.js';

const root = join(process.cwd(), 'examples/typescript-app');
const dbPath = join(tmpdir(), 'rb-indexer-test.sqlite');

describe('indexRepo (TS example, no embeddings for speed)', () => {
  let store: GraphStore;
  let result: IndexResult;

  beforeAll(async () => {
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    result = await indexRepo({ root, dbPath, full: true, embed: false });
    store = GraphStore.open(dbPath);
  });

  afterAll(() => {
    store?.close();
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  });

  it('indexes all TS files with no parse errors or secrets', () => {
    expect(result.filesTotal).toBeGreaterThanOrEqual(15);
    expect(result.parseErrors).toBe(0);
    expect(result.secretsFound).toBe(0);
    expect(result.symbols).toBeGreaterThan(30);
  });

  it('extracts key symbols with correct kinds and export flags', () => {
    const createLead = store.findSymbolsByName('createLead');
    expect(createLead.length).toBe(1);
    expect(createLead[0]!.kind).toBe('function');
    expect(createLead[0]!.exported).toBe(true);
    expect(store.findSymbolsByName('LeadInput')[0]!.kind).toBe('interface');
    expect(store.findSymbolsByName('calcTotal')[0]!.kind).toBe('function');
  });

  it('builds a heuristic call edge createLead → sendLeadToCrm with confidence < 1', () => {
    const createLead = store.findSymbolsByName('createLead')[0]!;
    const target = store.findSymbolsByName('sendLeadToCrm')[0]!;
    const calls = store
      .edgesFrom('symbol', createLead.id)
      .filter((e) => e.edge_type === 'calls' && e.target_id === target.id);
    expect(calls.length).toBe(1);
    expect(calls[0]!.resolution).toBe('heuristic');
    expect(calls[0]!.confidence).toBeGreaterThan(0);
    expect(calls[0]!.confidence).toBeLessThan(1);
  });

  it('builds calcTotal → applyDiscount call edge (cross-language gold path)', () => {
    const calcTotal = store.findSymbolsByName('calcTotal')[0]!;
    const applyDiscount = store.findSymbolsByName('applyDiscount')[0]!;
    const calls = store
      .edgesFrom('symbol', calcTotal.id)
      .filter((e) => e.edge_type === 'calls' && e.target_id === applyDiscount.id);
    expect(calls.length).toBe(1);
  });

  it('resolves import edges (TS ESM .js → .ts) and defines edges', () => {
    const byType = new Map<string, number>();
    for (const e of store.edgesForRanking()) byType.set(e.edge_type, (byType.get(e.edge_type) ?? 0) + 1);
    expect(byType.get('imports') ?? 0).toBeGreaterThan(0);
    expect(byType.get('defines') ?? 0).toBe(result.symbols);
    expect(byType.get('tested_by') ?? 0).toBeGreaterThan(0);
  });
});

describe('ignore rules for gitignored directories', () => {
  const repo = join(tmpdir(), `rb-ignore-${process.pid}`);
  let ignorer: Ignorer;

  beforeAll(() => {
    rmSync(repo, { recursive: true, force: true });
    for (const dir of ['src', 'eval/.work/clone', 'eval/probes', 'evaluation', 'nested/.work']) {
      mkdirSync(join(repo, dir), { recursive: true });
    }
    writeFileSync(join(repo, '.gitignore'), '/eval/.work/\nnode_modules/\n', 'utf8');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(repo, 'eval', '.work', 'clone', 'foreign.ts'), 'export const b = 2;\n', 'utf8');
    writeFileSync(join(repo, 'eval', 'probes', 'probe.ts'), 'export const c = 3;\n', 'utf8');
    writeFileSync(join(repo, 'evaluation', 'own.ts'), 'export const d = 4;\n', 'utf8');
    writeFileSync(join(repo, 'nested', '.work', 'own.ts'), 'export const e = 5;\n', 'utf8');
    ignorer = Ignorer.load(repo);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('matches an anchored dir pattern against the repo-relative path, not the basename', () => {
    expect(ignorer.shouldIgnoreDir('eval/.work')).toBe(true);
    expect(ignorer.shouldIgnoreDir('node_modules')).toBe(true);
    expect(ignorer.shouldIgnoreDir('eval/probes')).toBe(false);
  });

  it('keeps directories that only look alike (negative case)', () => {
    expect(ignorer.shouldIgnoreDir('evaluation')).toBe(false);
    expect(ignorer.shouldIgnoreDir('nested/.work')).toBe(false);
  });

  it('excludes files inside an excluded directory, whatever route reaches them', () => {
    expect(ignorer.shouldIgnoreFile('eval/.work/clone/foreign.ts')).toBe(true);
    expect(ignorer.shouldIgnoreFile('eval/probes/probe.ts')).toBe(false);
    expect(ignorer.shouldIgnoreFile('nested/.work/own.ts')).toBe(false);
  });

  it('walks the repo without a single file from the excluded directory', async () => {
    const seen: string[] = [];
    for await (const f of walk(repo, ignorer)) seen.push(f.relPath);
    expect(seen.filter((p) => p.startsWith('eval/.work/'))).toEqual([]);
    expect(seen).toContain('src/a.ts');
    expect(seen).toContain('eval/probes/probe.ts');
    expect(seen).toContain('evaluation/own.ts');
    expect(seen).toContain('nested/.work/own.ts');
  });
});
