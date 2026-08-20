import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GraphStore, type NewFile, type NewSymbol, type NewMemory } from '@repobrain/graph-store';
import { packGraph, unpackGraph, SecretsInArtifactError } from '../src/index.js';

// Every path lives under one unique temp dir so cleanup is a single rm.
const workDir = path.join(os.tmpdir(), `team-sync-test-${randomUUID()}`);
fs.mkdirSync(workDir, { recursive: true });

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

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

function makeSymbol(fileId: number, overrides: Partial<NewSymbol> = {}): NewSymbol {
  return {
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
    ...overrides,
  };
}

function makeMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    type: 'architecture_decision',
    title: 'Use a single SQLite graph',
    body: 'The whole code graph lives in one SQLite file for portability.',
    related_files: ['src/app.ts'],
    related_symbols: ['app.handleRequest'],
    tags: ['storage'],
    stale_status: 'fresh',
    ...overrides,
  };
}

/** Seed a fresh graph DB at `dbPath` and return it closed. */
function seedDb(dbPath: string, symbol?: Partial<NewSymbol>): void {
  const store = GraphStore.open(dbPath);
  const pkgId = store.upsertPackage({
    name: 'demo',
    root_path: '/repo/demo',
    manifest_path: '/repo/demo/package.json',
  });
  const fileId = store.upsertFile(makeFile({ package_id: pkgId }));
  store.replaceFileSymbols(fileId, [makeSymbol(fileId, symbol)]);
  store.insertMemory(makeMemory());
  store.close();
}

describe('team-sync pack/unpack', () => {
  it('packs a graph into a zstd artifact + manifest, then round-trips it', () => {
    const dbPath = path.join(workDir, `graph-${randomUUID()}.sqlite`);
    const outDir = path.join(workDir, `pack-${randomUUID()}`);
    seedDb(dbPath);

    const result = packGraph(dbPath, outDir);

    // Artifact + manifest exist on disk.
    expect(fs.existsSync(result.artifactPath)).toBe(true);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);

    // Manifest content.
    expect(result.manifest.compression).toBe('zstd');
    expect(result.manifest.artifact).toBe('graph.sqlite.zst');
    expect(result.manifest.schema_version).toBe(1);
    expect(result.manifest.counts.symbols).toBeGreaterThanOrEqual(1);
    expect(result.manifest.counts.memories).toBeGreaterThanOrEqual(1);
    expect(result.manifest.languages).toContain('typescript');

    // Manifest file parses and matches the returned object.
    const onDisk = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    expect(onDisk).toEqual(result.manifest);

    // Unpack into a new DB and confirm the symbol + memory survived.
    const destDbPath = path.join(workDir, `restored-${randomUUID()}.sqlite`);
    unpackGraph(result.artifactPath, destDbPath);
    expect(fs.existsSync(destDbPath)).toBe(true);

    const restored = GraphStore.open(destDbPath);
    try {
      const symbols = restored.allSymbols();
      expect(symbols).toHaveLength(1);
      expect(symbols[0]!.qualified_name).toBe('app.handleRequest');

      const memories = restored.allMemories();
      expect(memories).toHaveLength(1);
      expect(memories[0]!.title).toBe('Use a single SQLite graph');
    } finally {
      restored.close();
    }
  });

  it('refuses to pack when stored text contains a secret', () => {
    const dbPath = path.join(workDir, `graph-secret-${randomUUID()}.sqlite`);
    const outDir = path.join(workDir, `pack-secret-${randomUUID()}`);
    // An AWS access key id embedded in a symbol signature.
    seedDb(dbPath, {
      signature: 'const key = "AKIAIOSFODNN7EXAMPLE"',
    });

    expect(() => packGraph(dbPath, outDir)).toThrow(SecretsInArtifactError);

    // Nothing was written because the pack was refused.
    expect(fs.existsSync(path.join(outDir, 'graph.sqlite.zst'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'manifest.json'))).toBe(false);

    // The error carries the location + type of the finding.
    try {
      packGraph(dbPath, outDir);
      throw new Error('expected packGraph to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsInArtifactError);
      const findings = (err as SecretsInArtifactError).findings;
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings[0]!.where).toBe('symbol:app.handleRequest');
      expect(findings.some((f) => f.type === 'aws_access_key_id')).toBe(true);
    }
  });
});
