/**
 * @repobrain/graph-store — the typed SQLite data layer for RepoBrain's code graph.
 *
 * Wraps better-sqlite3 with prepared-statement caching and boundary conversions
 * so that every value returned matches the `@repobrain/shared` domain types
 * exactly: SQLite 0/1 integers become JS booleans, JSON-text columns become
 * arrays, and Float32 BLOBs round-trip as Float32Array.
 *
 * All timestamps are epoch milliseconds. Writes stamp `created_at`/`updated_at`
 * from a `now` value (defaults to Date.now()).
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type {
  FileRecord,
  SymbolRecord,
  EdgeRecord,
  RouteRecord,
  TestRecord,
  MemoryRecord,
  IndexRun,
  Language,
  SymbolKind,
  EdgeType,
  Resolution,
  NodeType,
  MemoryType,
  Visibility,
  ParseStatus,
} from '@repobrain/shared';
import { SCHEMA_SQL } from './schema.js';

// ─────────────────────────────────────────────────────────────────
// Public helper types
// ─────────────────────────────────────────────────────────────────

export interface FtsHit<T> {
  item: T;
  bm25: number;
}

export interface RankEdge {
  source_type: NodeType;
  source_id: number;
  target_type: NodeType;
  target_id: number;
  edge_type: EdgeType;
  confidence: number;
}

// New* input shapes: the persisted record minus the columns the store fills in.
export type NewFile = Omit<FileRecord, 'id' | 'created_at' | 'updated_at'>;
export type NewSymbol = Omit<SymbolRecord, 'id' | 'created_at' | 'updated_at'>;
export type NewEdge = Omit<EdgeRecord, 'id' | 'created_at'>;
export type NewRoute = Omit<RouteRecord, 'id' | 'created_at'>;
export type NewTest = Omit<TestRecord, 'id' | 'created_at'>;
export type NewMemory = Omit<MemoryRecord, 'id' | 'created_at' | 'updated_at'>;

// ─────────────────────────────────────────────────────────────────
// Row shapes (as SQLite returns them: booleans as 0/1, JSON as text)
// ─────────────────────────────────────────────────────────────────

interface FileRow {
  id: number;
  path: string;
  language: string;
  hash: string;
  size_bytes: number;
  lines_count: number;
  last_modified: number;
  parse_status: string;
  is_test: number;
  is_generated: number;
  has_secrets: number;
  package_id: number | null;
  git_last_commit: string | null;
  git_last_date: string | null;
  git_churn: number;
  created_at: number;
  updated_at: number;
}

interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  qualified_name: string;
  kind: string;
  signature: string | null;
  docstring: string | null;
  start_line: number;
  end_line: number;
  visibility: string;
  exported: number;
  hash: string;
  created_at: number;
  updated_at: number;
}

interface EdgeRow {
  id: number;
  source_type: string;
  source_id: number;
  target_type: string;
  target_id: number;
  edge_type: string;
  confidence: number;
  resolution: string;
  file_id: number | null;
  line: number | null;
  created_at: number;
}

interface RouteRow {
  id: number;
  method: string;
  path: string;
  handler_symbol_id: number | null;
  file_id: number;
  framework: string | null;
  line: number | null;
  created_at: number;
}

interface MemoryRow {
  id: number;
  type: string;
  title: string;
  body: string;
  related_files: string;
  related_symbols: string;
  tags: string;
  stale_status: string;
  created_at: number;
  updated_at: number;
}

interface IndexRunRow {
  id: number;
  index_commit: string | null;
  working_tree_dirty: number;
  mode: string;
  files_total: number;
  files_changed: number;
  started_at: number;
  finished_at: number | null;
}

// ─────────────────────────────────────────────────────────────────
// Boundary conversions
// ─────────────────────────────────────────────────────────────────

const b2i = (b: boolean): number => (b ? 1 : 0);
const i2b = (n: number): boolean => n !== 0;

function rowToFile(r: FileRow): FileRecord {
  return {
    id: r.id,
    path: r.path,
    language: r.language as Language,
    hash: r.hash,
    size_bytes: r.size_bytes,
    lines_count: r.lines_count,
    last_modified: r.last_modified,
    parse_status: r.parse_status as ParseStatus,
    is_test: i2b(r.is_test),
    is_generated: i2b(r.is_generated),
    has_secrets: i2b(r.has_secrets),
    package_id: r.package_id,
    git_last_commit: r.git_last_commit,
    git_last_date: r.git_last_date,
    git_churn: r.git_churn,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToSymbol(r: SymbolRow): SymbolRecord {
  return {
    id: r.id,
    file_id: r.file_id,
    name: r.name,
    qualified_name: r.qualified_name,
    kind: r.kind as SymbolKind,
    signature: r.signature,
    docstring: r.docstring,
    start_line: r.start_line,
    end_line: r.end_line,
    visibility: r.visibility as Visibility,
    exported: i2b(r.exported),
    hash: r.hash,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToEdge(r: EdgeRow): EdgeRecord {
  return {
    id: r.id,
    source_type: r.source_type as NodeType,
    source_id: r.source_id,
    target_type: r.target_type as NodeType,
    target_id: r.target_id,
    edge_type: r.edge_type as EdgeType,
    confidence: r.confidence,
    resolution: r.resolution as Resolution,
    file_id: r.file_id,
    line: r.line,
    created_at: r.created_at,
  };
}

function rowToRoute(r: RouteRow): RouteRecord {
  return {
    id: r.id,
    method: r.method,
    path: r.path,
    handler_symbol_id: r.handler_symbol_id,
    file_id: r.file_id,
    framework: r.framework,
    line: r.line,
    created_at: r.created_at,
  };
}

function rowToMemory(r: MemoryRow): MemoryRecord {
  return {
    id: r.id,
    type: r.type as MemoryType,
    title: r.title,
    body: r.body,
    related_files: JSON.parse(r.related_files) as string[],
    related_symbols: JSON.parse(r.related_symbols) as string[],
    tags: JSON.parse(r.tags) as string[],
    stale_status: r.stale_status as 'fresh' | 'stale',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToIndexRun(r: IndexRunRow): IndexRun {
  return {
    id: r.id,
    index_commit: r.index_commit,
    working_tree_dirty: i2b(r.working_tree_dirty),
    mode: r.mode as 'full' | 'incremental',
    files_total: r.files_total,
    files_changed: r.files_changed,
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
}

// Float32 BLOB <-> Float32Array. Reads copy into a fresh, 4-byte-aligned buffer
// so we never depend on better-sqlite3's Buffer offset/alignment or pooling.
function vectorToBlob(vec: Float32Array): Buffer {
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
  return Buffer.from(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength));
}

function blobToVector(buf: Buffer, dim: number): Float32Array {
  const out = new Float32Array(dim);
  new Uint8Array(out.buffer).set(new Uint8Array(buf.buffer, buf.byteOffset, dim * 4));
  return out;
}

// ─────────────────────────────────────────────────────────────────
// FTS5 query safety
// ─────────────────────────────────────────────────────────────────

/**
 * Turn arbitrary user/task text into a safe FTS5 MATCH string. We extract word
 * tokens (letters/digits/underscore) and OR them together, double-quoting each
 * so FTS5 treats it as a literal rather than a query operator. Returns null for
 * an effectively-empty query so the caller can skip MATCH entirely.
 */
function toMatchQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}" `).join('OR ').trim();
}

/**
 * Split identifiers into their component words so plain-language queries match
 * camelCase / snake_case / PascalCase code names in FTS (e.g. `generateGuestToken`
 * → "generate guest token"). Deterministic and model-free — this is what lets
 * graph-first search answer natural-word queries, not just exact identifiers (D18).
 */
export function subtokenize(...parts: Array<string | null | undefined>): string {
  const words = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const chunk of part.split(/[^\p{L}\p{N}]+/u)) {
      if (!chunk) continue;
      const split = chunk
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2') // camelCase → camel Case
        .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2'); // HTTPServer → HTTP Server
      for (const w of split.split(/\s+/)) if (w.length >= 2) words.add(w.toLowerCase());
    }
  }
  return [...words].join(' ');
}

// ─────────────────────────────────────────────────────────────────
// GraphStore
// ─────────────────────────────────────────────────────────────────

export class GraphStore {
  private readonly db: Database.Database;
  private readonly stmtCache = new Map<string, Database.Statement>();

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /** Open (or create) a store, set pragmas, and run the migration if fresh. */
  static open(dbPath: string, opts?: { migrationsDir?: string }): GraphStore {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // no-op for :memory:, harmless
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    const store = new GraphStore(db);
    store.migrate(opts?.migrationsDir);
    return store;
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` inside a single SQLite transaction (nestable via savepoints). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── internals ───────────────────────────────────────────────────

  /**
   * Apply the schema when the DB is fresh. The schema is inlined from
   * src/migrations/001_init.sql into src/schema.ts (SCHEMA_SQL) so it resolves
   * at runtime without a fragile dist-relative path (tsc does not copy .sql
   * into dist). Passing `migrationsDir` overrides this and reads 001_init.sql
   * from disk instead — handy for tests or alternate migration sets.
   */
  private migrate(migrationsDir?: string): void {
    const fresh = !this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='files'`)
      .get();
    const sql = migrationsDir
      ? fs.readFileSync(path.join(migrationsDir, '001_init.sql'), 'utf8')
      : SCHEMA_SQL;
    if (fresh) {
      this.db.exec(sql);
      return;
    }
    // In-place schema drift: add the `search_terms` subtoken column to older indexes
    // (D18 follow-up) so `index` doesn't crash on a pre-existing DB. Recreate the FTS
    // table + triggers with the new column, then rebuild the FTS from existing rows.
    const cols = this.db.prepare(`PRAGMA table_info(symbols)`).all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === 'search_terms')) {
      this.db.exec(`
        ALTER TABLE symbols ADD COLUMN search_terms TEXT;
        DROP TRIGGER IF EXISTS symbols_ai;
        DROP TRIGGER IF EXISTS symbols_ad;
        DROP TRIGGER IF EXISTS symbols_au;
        DROP TABLE IF EXISTS symbols_fts;
      `);
      this.db.exec(sql); // recreates symbols_fts + triggers with search_terms (others are no-ops)
      this.db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');`);
    }
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private now(): number {
    return Date.now();
  }

  // ── packages ────────────────────────────────────────────────────

  upsertPackage(rec: { name: string; root_path: string; manifest_path: string | null }): number {
    const row = this.stmt(
      `INSERT INTO packages (name, root_path, manifest_path)
       VALUES (@name, @root_path, @manifest_path)
       ON CONFLICT(root_path) DO UPDATE SET
         name = excluded.name,
         manifest_path = excluded.manifest_path
       RETURNING id`,
    ).get({
      name: rec.name,
      root_path: rec.root_path,
      manifest_path: rec.manifest_path,
    }) as { id: number };
    return row.id;
  }

  // ── files ───────────────────────────────────────────────────────

  upsertFile(rec: NewFile): number {
    const now = this.now();
    const row = this.stmt(
      `INSERT INTO files (
         path, language, hash, size_bytes, lines_count, last_modified,
         parse_status, is_test, is_generated, has_secrets, package_id,
         git_last_commit, git_last_date, git_churn, created_at, updated_at
       ) VALUES (
         @path, @language, @hash, @size_bytes, @lines_count, @last_modified,
         @parse_status, @is_test, @is_generated, @has_secrets, @package_id,
         @git_last_commit, @git_last_date, @git_churn, @created_at, @updated_at
       )
       ON CONFLICT(path) DO UPDATE SET
         language = excluded.language,
         hash = excluded.hash,
         size_bytes = excluded.size_bytes,
         lines_count = excluded.lines_count,
         last_modified = excluded.last_modified,
         parse_status = excluded.parse_status,
         is_test = excluded.is_test,
         is_generated = excluded.is_generated,
         has_secrets = excluded.has_secrets,
         package_id = excluded.package_id,
         git_last_commit = excluded.git_last_commit,
         git_last_date = excluded.git_last_date,
         git_churn = excluded.git_churn,
         updated_at = excluded.updated_at
       RETURNING id`,
    ).get({
      path: rec.path,
      language: rec.language,
      hash: rec.hash,
      size_bytes: rec.size_bytes,
      lines_count: rec.lines_count,
      last_modified: rec.last_modified,
      parse_status: rec.parse_status,
      is_test: b2i(rec.is_test),
      is_generated: b2i(rec.is_generated),
      has_secrets: b2i(rec.has_secrets),
      package_id: rec.package_id,
      git_last_commit: rec.git_last_commit,
      git_last_date: rec.git_last_date,
      git_churn: rec.git_churn,
      created_at: now,
      updated_at: now,
    }) as { id: number };
    return row.id;
  }

  getFileByPath(filePath: string): FileRecord | undefined {
    const row = this.stmt(`SELECT * FROM files WHERE path = ?`).get(filePath) as
      | FileRow
      | undefined;
    return row ? rowToFile(row) : undefined;
  }

  getFile(id: number): FileRecord | undefined {
    const row = this.stmt(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow | undefined;
    return row ? rowToFile(row) : undefined;
  }

  allFiles(): FileRecord[] {
    const rows = this.stmt(`SELECT * FROM files ORDER BY id`).all() as FileRow[];
    return rows.map(rowToFile);
  }

  /** Delete a file by path; FK ON DELETE CASCADE removes its symbols/edges/routes/tests/vectors. */
  deleteFileByPath(filePath: string): void {
    this.stmt(`DELETE FROM files WHERE path = ?`).run(filePath);
  }

  // ── symbols ─────────────────────────────────────────────────────

  replaceFileSymbols(fileId: number, symbols: NewSymbol[]): SymbolRecord[] {
    const now = this.now();
    const del = this.stmt(`DELETE FROM symbols WHERE file_id = ?`);
    const ins = this.stmt(
      `INSERT INTO symbols (
         file_id, name, qualified_name, kind, signature, docstring, search_terms,
         start_line, end_line, visibility, exported, hash, created_at, updated_at
       ) VALUES (
         @file_id, @name, @qualified_name, @kind, @signature, @docstring, @search_terms,
         @start_line, @end_line, @visibility, @exported, @hash, @created_at, @updated_at
       ) RETURNING *`,
    );
    return this.db.transaction((): SymbolRecord[] => {
      del.run(fileId);
      return symbols.map((s) => {
        const row = ins.get({
          file_id: fileId,
          name: s.name,
          qualified_name: s.qualified_name,
          kind: s.kind,
          signature: s.signature,
          docstring: s.docstring,
          search_terms: subtokenize(s.name, s.qualified_name, s.signature),
          start_line: s.start_line,
          end_line: s.end_line,
          visibility: s.visibility,
          exported: b2i(s.exported),
          hash: s.hash,
          created_at: now,
          updated_at: now,
        }) as SymbolRow;
        return rowToSymbol(row);
      });
    })();
  }

  getSymbol(id: number): SymbolRecord | undefined {
    const row = this.stmt(`SELECT * FROM symbols WHERE id = ?`).get(id) as SymbolRow | undefined;
    return row ? rowToSymbol(row) : undefined;
  }

  symbolsByFile(fileId: number): SymbolRecord[] {
    const rows = this.stmt(`SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line`).all(
      fileId,
    ) as SymbolRow[];
    return rows.map(rowToSymbol);
  }

  findSymbolsByName(name: string, kind?: SymbolKind): SymbolRecord[] {
    const rows = (
      kind
        ? this.stmt(`SELECT * FROM symbols WHERE name = ? AND kind = ? ORDER BY id`).all(name, kind)
        : this.stmt(`SELECT * FROM symbols WHERE name = ? ORDER BY id`).all(name)
    ) as SymbolRow[];
    return rows.map(rowToSymbol);
  }

  allSymbols(): SymbolRecord[] {
    const rows = this.stmt(`SELECT * FROM symbols ORDER BY id`).all() as SymbolRow[];
    return rows.map(rowToSymbol);
  }

  // ── edges ───────────────────────────────────────────────────────

  private insertEdgeStmt(): Database.Statement {
    return this.stmt(
      `INSERT INTO edges (
         source_type, source_id, target_type, target_id, edge_type,
         confidence, resolution, file_id, line, created_at
       ) VALUES (
         @source_type, @source_id, @target_type, @target_id, @edge_type,
         @confidence, @resolution, @file_id, @line, @created_at
       )`,
    );
  }

  private bindEdge(e: NewEdge, now: number): Record<string, unknown> {
    return {
      source_type: e.source_type,
      source_id: e.source_id,
      target_type: e.target_type,
      target_id: e.target_id,
      edge_type: e.edge_type,
      confidence: e.confidence,
      resolution: e.resolution,
      file_id: e.file_id,
      line: e.line,
      created_at: now,
    };
  }

  replaceFileEdges(fileId: number, edges: NewEdge[]): void {
    const now = this.now();
    const del = this.stmt(`DELETE FROM edges WHERE file_id = ?`);
    const ins = this.insertEdgeStmt();
    this.db.transaction(() => {
      del.run(fileId);
      for (const e of edges) ins.run(this.bindEdge(e, now));
    })();
  }

  insertEdges(edges: NewEdge[]): void {
    const now = this.now();
    const ins = this.insertEdgeStmt();
    this.db.transaction(() => {
      for (const e of edges) ins.run(this.bindEdge(e, now));
    })();
  }

  /** Delete all edges originating from a node type (used to rebuild note→file edges each index). */
  deleteEdgesBySourceType(type: NodeType): number {
    return this.stmt(`DELETE FROM edges WHERE source_type = ?`).run(type).changes;
  }

  edgesForRanking(): RankEdge[] {
    const rows = this.stmt(
      `SELECT source_type, source_id, target_type, target_id, edge_type, confidence FROM edges`,
    ).all() as Array<{
      source_type: string;
      source_id: number;
      target_type: string;
      target_id: number;
      edge_type: string;
      confidence: number;
    }>;
    return rows.map((r) => ({
      source_type: r.source_type as NodeType,
      source_id: r.source_id,
      target_type: r.target_type as NodeType,
      target_id: r.target_id,
      edge_type: r.edge_type as EdgeType,
      confidence: r.confidence,
    }));
  }

  edgesFrom(sourceType: NodeType, sourceId: number): EdgeRecord[] {
    const rows = this.stmt(
      `SELECT * FROM edges WHERE source_type = ? AND source_id = ? ORDER BY id`,
    ).all(sourceType, sourceId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  edgesTo(targetType: NodeType, targetId: number): EdgeRecord[] {
    const rows = this.stmt(
      `SELECT * FROM edges WHERE target_type = ? AND target_id = ? ORDER BY id`,
    ).all(targetType, targetId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  // ── routes / tests ──────────────────────────────────────────────

  replaceFileRoutes(fileId: number, routes: NewRoute[]): void {
    const now = this.now();
    const del = this.stmt(`DELETE FROM routes WHERE file_id = ?`);
    const ins = this.stmt(
      `INSERT INTO routes (method, path, handler_symbol_id, file_id, framework, line, created_at)
       VALUES (@method, @path, @handler_symbol_id, @file_id, @framework, @line, @created_at)`,
    );
    this.db.transaction(() => {
      del.run(fileId);
      for (const r of routes) {
        ins.run({
          method: r.method,
          path: r.path,
          handler_symbol_id: r.handler_symbol_id,
          file_id: fileId,
          framework: r.framework,
          line: r.line,
          created_at: now,
        });
      }
    })();
  }

  replaceFileTests(fileId: number, tests: NewTest[]): void {
    const now = this.now();
    const del = this.stmt(`DELETE FROM tests WHERE file_id = ?`);
    const ins = this.stmt(
      `INSERT INTO tests (file_id, name, target_symbol_id, start_line, end_line, created_at)
       VALUES (@file_id, @name, @target_symbol_id, @start_line, @end_line, @created_at)`,
    );
    this.db.transaction(() => {
      del.run(fileId);
      for (const t of tests) {
        ins.run({
          file_id: fileId,
          name: t.name,
          target_symbol_id: t.target_symbol_id,
          start_line: t.start_line,
          end_line: t.end_line,
          created_at: now,
        });
      }
    })();
  }

  allRoutes(): RouteRecord[] {
    const rows = this.stmt(`SELECT * FROM routes ORDER BY id`).all() as RouteRow[];
    return rows.map(rowToRoute);
  }

  // ── memories ────────────────────────────────────────────────────

  insertMemory(rec: NewMemory): number {
    const now = this.now();
    const info = this.stmt(
      `INSERT INTO memories (
         type, title, body, related_files, related_symbols, tags,
         stale_status, created_at, updated_at
       ) VALUES (
         @type, @title, @body, @related_files, @related_symbols, @tags,
         @stale_status, @created_at, @updated_at
       )`,
    ).run({
      type: rec.type,
      title: rec.title,
      body: rec.body,
      related_files: JSON.stringify(rec.related_files),
      related_symbols: JSON.stringify(rec.related_symbols),
      tags: JSON.stringify(rec.tags),
      stale_status: rec.stale_status,
      created_at: now,
      updated_at: now,
    });
    return Number(info.lastInsertRowid);
  }

  allMemories(): MemoryRecord[] {
    const rows = this.stmt(`SELECT * FROM memories ORDER BY id`).all() as MemoryRow[];
    return rows.map(rowToMemory);
  }

  getMemory(id: number): MemoryRecord | undefined {
    const row = this.stmt(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  /** Delete all memories of a given type. Used to refresh ingested second-brain notes
   *  idempotently on re-index (drop the old batch, then re-insert the current folder). */
  deleteMemoriesByType(type: MemoryType): number {
    const info = this.stmt(`DELETE FROM memories WHERE type = ?`).run(type);
    return info.changes;
  }

  /** Update a memory's staleness + resolved code references (used by the staleness pass). */
  updateMemoryMeta(
    id: number,
    patch: { stale_status?: 'fresh' | 'stale'; related_files?: string[] },
  ): void {
    const cur = this.stmt(`SELECT stale_status, related_files FROM memories WHERE id = ?`).get(id) as
      | { stale_status: string; related_files: string }
      | undefined;
    if (!cur) return;
    this.stmt(
      `UPDATE memories SET stale_status = @stale_status, related_files = @related_files, updated_at = @updated_at WHERE id = @id`,
    ).run({
      id,
      stale_status: patch.stale_status ?? cur.stale_status,
      related_files:
        patch.related_files !== undefined ? JSON.stringify(patch.related_files) : cur.related_files,
      updated_at: this.now(),
    });
  }

  countMemoriesByType(type: MemoryType): number {
    const row = this.stmt(`SELECT COUNT(*) AS n FROM memories WHERE type = ?`).get(type) as {
      n: number;
    };
    return row.n;
  }

  searchMemoriesFts(query: string, limit: number): FtsHit<MemoryRecord>[] {
    const match = toMatchQuery(query);
    if (match === null) return [];
    const rows = this.stmt(
      `SELECT m.*, bm25(memories_fts) AS bm25
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY bm25
        LIMIT ?`,
    ).all(match, limit) as Array<MemoryRow & { bm25: number }>;
    return rows.map((r) => ({ item: rowToMemory(r), bm25: r.bm25 }));
  }

  // ── vectors ─────────────────────────────────────────────────────

  upsertVector(
    symbolId: number,
    modelId: string,
    dim: number,
    vector: Float32Array,
    sourceHash: string,
  ): void {
    this.stmt(
      `INSERT INTO symbol_vectors (symbol_id, model_id, dim, vector, source_hash, updated_at)
       VALUES (@symbol_id, @model_id, @dim, @vector, @source_hash, @updated_at)
       ON CONFLICT(symbol_id, model_id) DO UPDATE SET
         dim = excluded.dim,
         vector = excluded.vector,
         source_hash = excluded.source_hash,
         updated_at = excluded.updated_at`,
    ).run({
      symbol_id: symbolId,
      model_id: modelId,
      dim,
      vector: vectorToBlob(vector),
      source_hash: sourceHash,
      updated_at: this.now(),
    });
  }

  getVectorMeta(symbolId: number, modelId: string): { source_hash: string } | undefined {
    const row = this.stmt(
      `SELECT source_hash FROM symbol_vectors WHERE symbol_id = ? AND model_id = ?`,
    ).get(symbolId, modelId) as { source_hash: string } | undefined;
    return row ? { source_hash: row.source_hash } : undefined;
  }

  allVectors(modelId: string): Array<{ symbol_id: number; vector: Float32Array }> {
    const rows = this.stmt(
      `SELECT symbol_id, dim, vector FROM symbol_vectors WHERE model_id = ? ORDER BY symbol_id`,
    ).all(modelId) as Array<{ symbol_id: number; dim: number; vector: Buffer }>;
    return rows.map((r) => ({
      symbol_id: r.symbol_id,
      vector: blobToVector(r.vector, r.dim),
    }));
  }

  // ── FTS ─────────────────────────────────────────────────────────

  searchSymbolsFts(query: string, limit: number): FtsHit<SymbolRecord>[] {
    const match = toMatchQuery(query);
    if (match === null) return [];
    const rows = this.stmt(
      `SELECT s.*, bm25(symbols_fts) AS bm25
         FROM symbols_fts
         JOIN symbols s ON s.id = symbols_fts.rowid
        WHERE symbols_fts MATCH ?
        ORDER BY bm25
        LIMIT ?`,
    ).all(match, limit) as Array<SymbolRow & { bm25: number }>;
    return rows.map((r) => ({ item: rowToSymbol(r), bm25: r.bm25 }));
  }

  searchFilesFts(query: string, limit: number): FtsHit<FileRecord>[] {
    const match = toMatchQuery(query);
    if (match === null) return [];
    const rows = this.stmt(
      `SELECT f.*, bm25(files_fts) AS bm25
         FROM files_fts
         JOIN files f ON f.id = files_fts.rowid
        WHERE files_fts MATCH ?
        ORDER BY bm25
        LIMIT ?`,
    ).all(match, limit) as Array<FileRow & { bm25: number }>;
    return rows.map((r) => ({ item: rowToFile(r), bm25: r.bm25 }));
  }

  // ── index runs (freshness) ──────────────────────────────────────

  startIndexRun(rec: {
    index_commit: string | null;
    working_tree_dirty: boolean;
    mode: 'full' | 'incremental';
    started_at: number;
  }): number {
    const info = this.stmt(
      `INSERT INTO index_runs (index_commit, working_tree_dirty, mode, started_at)
       VALUES (@index_commit, @working_tree_dirty, @mode, @started_at)`,
    ).run({
      index_commit: rec.index_commit,
      working_tree_dirty: b2i(rec.working_tree_dirty),
      mode: rec.mode,
      started_at: rec.started_at,
    });
    return Number(info.lastInsertRowid);
  }

  finishIndexRun(
    id: number,
    patch: { files_total: number; files_changed: number; finished_at: number },
  ): void {
    this.stmt(
      `UPDATE index_runs
          SET files_total = @files_total,
              files_changed = @files_changed,
              finished_at = @finished_at
        WHERE id = @id`,
    ).run({
      id,
      files_total: patch.files_total,
      files_changed: patch.files_changed,
      finished_at: patch.finished_at,
    });
  }

  latestIndexRun(): IndexRun | undefined {
    const row = this.stmt(`SELECT * FROM index_runs ORDER BY id DESC LIMIT 1`).get() as
      | IndexRunRow
      | undefined;
    return row ? rowToIndexRun(row) : undefined;
  }

  // ── settings + capsule logs ─────────────────────────────────────

  getSetting(key: string): string | undefined {
    const row = this.stmt(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : undefined;
  }

  setSetting(key: string, value: string): void {
    this.stmt(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  logCapsule(rec: {
    task: string;
    index_commit: string | null;
    capsule_tokens: number;
    naive_estimate: number;
    tokenizer_used: string;
    model: string | null;
    created_at: number;
  }): void {
    this.stmt(
      `INSERT INTO capsule_logs (
         task, index_commit, capsule_tokens, naive_estimate, tokenizer_used, model, created_at
       ) VALUES (
         @task, @index_commit, @capsule_tokens, @naive_estimate, @tokenizer_used, @model, @created_at
       )`,
    ).run({
      task: rec.task,
      index_commit: rec.index_commit,
      capsule_tokens: rec.capsule_tokens,
      naive_estimate: rec.naive_estimate,
      tokenizer_used: rec.tokenizer_used,
      model: rec.model,
      created_at: rec.created_at,
    });
  }

  allCapsuleLogs(): Array<{
    task: string;
    capsule_tokens: number;
    naive_estimate: number;
    tokenizer_used: string;
    model: string | null;
    created_at: number;
  }> {
    return this.stmt(
      `SELECT task, capsule_tokens, naive_estimate, tokenizer_used, model, created_at
       FROM capsule_logs ORDER BY created_at`,
    ).all() as Array<{
      task: string;
      capsule_tokens: number;
      naive_estimate: number;
      tokenizer_used: string;
      model: string | null;
      created_at: number;
    }>;
  }

  capsuleStats(): { count: number; capsule_tokens: number; naive_estimate: number; saved: number } {
    const row = this.stmt(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(capsule_tokens), 0) AS capsule_tokens,
              COALESCE(SUM(naive_estimate), 0) AS naive_estimate
       FROM capsule_logs`,
    ).get() as { count: number; capsule_tokens: number; naive_estimate: number };
    return {
      count: row.count,
      capsule_tokens: row.capsule_tokens,
      naive_estimate: row.naive_estimate,
      saved: Math.max(0, row.naive_estimate - row.capsule_tokens),
    };
  }
}
