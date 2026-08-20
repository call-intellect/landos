/**
 * @repobrain/team-sync — pack/unpack the shareable code-graph artifact (spec §13).
 *
 * A team can share RepoBrain's derived code graph (files/symbols/edges/memories)
 * without shipping source bodies: RepoBrain never stores file bodies, only
 * skeletons (signatures/docstrings) and team memories. `packGraph` compresses the
 * raw SQLite graph DB into a single portable artifact plus a JSON manifest, after
 * scanning every piece of *stored text* for secrets (spec §13 safety gate).
 * `unpackGraph` restores the artifact into a fresh SQLite file on another machine.
 *
 * Compression prefers Node's built-in zstd (`node:zlib`, Node >= 22/24); if that
 * is unavailable it transparently falls back to gzip and names the artifact `.gz`.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  zstdCompressSync,
  zstdDecompressSync,
  gzipSync,
  gunzipSync,
} from 'node:zlib';
import { GraphStore } from '@repobrain/graph-store';
import { scanForSecrets } from '@repobrain/security';

// ─────────────────────────────────────────────────────────────────
// Compression backend (prefer zstd, fall back to gzip)
// ─────────────────────────────────────────────────────────────────

const ZSTD_OK =
  typeof zstdCompressSync === 'function' && typeof zstdDecompressSync === 'function';

const COMPRESSION: 'zstd' | 'gzip' = ZSTD_OK ? 'zstd' : 'gzip';
const ARTIFACT_NAME = ZSTD_OK ? 'graph.sqlite.zst' : 'graph.sqlite.gz';

/** team-sync tool version, stamped into the manifest for compatibility checks. */
const TOOL_VERSION = '0.1.0';

/** Current artifact schema version (spec §13). */
const SCHEMA_VERSION = 1;

function compress(buf: Buffer): Buffer {
  return ZSTD_OK ? zstdCompressSync(buf) : gzipSync(buf);
}

function decompress(buf: Buffer, artifactName: string): Buffer {
  // Honour the artifact's own extension so a `.gz` artifact still restores even
  // on a machine that does have zstd, and vice versa.
  if (artifactName.endsWith('.gz')) return gunzipSync(buf);
  return zstdDecompressSync(buf);
}

// ─────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────

export interface PackManifest {
  schema_version: number; // 1
  tool_version: string; // e.g. '0.1.0'
  index_commit: string | null; // git sha the graph was indexed at, if known
  created_at: number; // epoch ms the artifact was packed
  languages: string[]; // distinct file languages, sorted
  counts: { files: number; symbols: number; edges: number; memories: number };
  artifact: string; // 'graph.sqlite.zst' (or 'graph.sqlite.gz' on gzip fallback)
  compression: 'zstd' | 'gzip';
}

export interface PackResult {
  artifactPath: string;
  manifestPath: string;
  manifest: PackManifest;
  bytes: number; // size of the written (compressed) artifact
}

/**
 * Thrown by `packGraph` when any secret is detected in the text that would be
 * embedded in the artifact. No artifact or manifest is written when this throws.
 */
export class SecretsInArtifactError extends Error {
  findings: { where: string; type: string }[];

  constructor(findings: { where: string; type: string }[]) {
    const where = findings.map((f) => f.where).join(', ');
    super(
      `Refusing to pack code-graph artifact: ${findings.length} secret finding(s) in stored text (${where})`,
    );
    this.name = 'SecretsInArtifactError';
    this.findings = findings;
    Object.setPrototypeOf(this, SecretsInArtifactError.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────
// packGraph
// ─────────────────────────────────────────────────────────────────

/**
 * Pack the code graph at `dbPath` into `outDir/graph.sqlite.zst` + `manifest.json`.
 *
 * Steps (spec §13):
 *  1. Open the graph store (read-only usage).
 *  2. Scan all stored text — symbol signatures/docstrings, memory titles/bodies,
 *     and file paths — for secrets. If any are found, throw and write nothing.
 *  3. Checkpoint + close, then compress the raw SQLite file bytes.
 *  4. Write the artifact and a pretty-printed manifest.
 */
export function packGraph(dbPath: string, outDir: string): PackResult {
  const store = GraphStore.open(dbPath);

  // Gather everything we need while the store is open, so we can close it (which
  // checkpoints the WAL into the main DB file) before reading the file bytes.
  const files = store.allFiles();
  const symbols = store.allSymbols();
  const memories = store.allMemories();
  const edgeCount = store.edgesForRanking().length;

  const indexCommit: string | null =
    store.getSetting('index_commit') ?? store.latestIndexRun()?.index_commit ?? null;

  const languages = [...new Set(files.map((f) => f.language))].sort();

  const manifest: PackManifest = {
    schema_version: SCHEMA_VERSION,
    tool_version: TOOL_VERSION,
    index_commit: indexCommit,
    created_at: Date.now(),
    languages,
    counts: {
      files: files.length,
      symbols: symbols.length,
      edges: edgeCount,
      memories: memories.length,
    },
    artifact: ARTIFACT_NAME,
    compression: COMPRESSION,
  };

  // ── Secret gate (spec §13) ──────────────────────────────────────
  const findings: { where: string; type: string }[] = [];

  for (const s of symbols) {
    const text = `${s.signature ?? ''}\n${s.docstring ?? ''}`;
    const res = scanForSecrets(text);
    if (res.hasSecrets) {
      for (const f of res.findings) {
        findings.push({ where: `symbol:${s.qualified_name}`, type: f.type });
      }
    }
  }

  for (const m of memories) {
    const text = `${m.title}\n${m.body}`;
    const res = scanForSecrets(text);
    if (res.hasSecrets) {
      for (const f of res.findings) {
        findings.push({ where: `memory:${m.id}`, type: f.type });
      }
    }
  }

  for (const file of files) {
    const res = scanForSecrets(file.path);
    if (res.hasSecrets) {
      for (const f of res.findings) {
        findings.push({ where: `file:${file.path}`, type: f.type });
      }
    }
  }

  // Checkpoint the WAL into the main DB file. GraphStore does not expose the raw
  // better-sqlite3 handle (so we cannot call `pragma('wal_checkpoint(TRUNCATE)')`
  // directly); closing the store is the equivalent: SQLite checkpoints on the
  // last connection close and removes the -wal/-shm sidecars, leaving a complete
  // single-file snapshot to read.
  store.close();

  if (findings.length > 0) {
    // Do NOT write the artifact — the graph would leak a secret.
    throw new SecretsInArtifactError(findings);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const raw = fs.readFileSync(dbPath); // main DB file only, never the WAL
  const compressed = compress(raw);

  const artifactPath = path.join(outDir, ARTIFACT_NAME);
  const manifestPath = path.join(outDir, 'manifest.json');

  fs.writeFileSync(artifactPath, compressed);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { artifactPath, manifestPath, manifest, bytes: compressed.byteLength };
}

// ─────────────────────────────────────────────────────────────────
// unpackGraph
// ─────────────────────────────────────────────────────────────────

/**
 * Restore a packed artifact into a fresh SQLite file at `destDbPath`, creating
 * the destination directory if needed. Decompression is chosen from the artifact
 * extension (`.gz` → gzip, otherwise zstd).
 */
export function unpackGraph(artifactPath: string, destDbPath: string): void {
  const compressed = fs.readFileSync(artifactPath);
  const raw = decompress(compressed, artifactPath);

  fs.mkdirSync(path.dirname(destDbPath), { recursive: true });
  fs.writeFileSync(destDbPath, raw);
}
