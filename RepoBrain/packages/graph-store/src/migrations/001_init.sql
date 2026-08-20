-- RepoBrain graph store — migration 001 (init).
-- Canonical schema per docs/DATA_MODEL.md (spec §8). Library-agnostic SQL:
-- executes identically under better-sqlite3 or node:sqlite. Requires FTS5.

PRAGMA foreign_keys = ON;

-- ── packages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS packages (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  root_path     TEXT NOT NULL,
  manifest_path TEXT,
  UNIQUE(root_path)
);

-- ── files ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  language        TEXT NOT NULL,
  hash            TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  lines_count     INTEGER NOT NULL,
  last_modified   INTEGER NOT NULL,
  parse_status    TEXT NOT NULL DEFAULT 'ok',
  is_test         INTEGER NOT NULL DEFAULT 0,
  is_generated    INTEGER NOT NULL DEFAULT 0,
  has_secrets     INTEGER NOT NULL DEFAULT 0,
  package_id      INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  git_last_commit TEXT,
  git_last_date   TEXT,
  git_churn       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_package ON files(package_id);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);

-- ── symbols ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS symbols (
  id             INTEGER PRIMARY KEY,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind           TEXT NOT NULL,
  signature      TEXT,
  docstring      TEXT,
  search_terms   TEXT,
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'unknown',
  exported       INTEGER NOT NULL DEFAULT 0,
  hash           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qname ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

-- ── symbol_vectors (local embeddings) ─────────────────────────────
CREATE TABLE IF NOT EXISTS symbol_vectors (
  symbol_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vector      BLOB NOT NULL,
  source_hash TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (symbol_id, model_id)
);

-- ── edges (confidence + resolution, spec §0.1.4) ──────────────────
CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id   INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  edge_type   TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  resolution  TEXT NOT NULL DEFAULT 'exact',
  file_id     INTEGER REFERENCES files(id) ON DELETE CASCADE,
  line        INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);

-- ── routes ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routes (
  id                INTEGER PRIMARY KEY,
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,
  handler_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  file_id           INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  framework         TEXT,
  line              INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routes_handler ON routes(handler_symbol_id);

-- ── tests ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tests (
  id               INTEGER PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  start_line       INTEGER NOT NULL,
  end_line         INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tests_target ON tests(target_symbol_id);

-- ── memories ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memories (
  id               INTEGER PRIMARY KEY,
  type             TEXT NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  related_files    TEXT NOT NULL DEFAULT '[]',
  related_symbols  TEXT NOT NULL DEFAULT '[]',
  tags             TEXT NOT NULL DEFAULT '[]',
  stale_status     TEXT NOT NULL DEFAULT 'fresh',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- ── index_runs (freshness) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS index_runs (
  id                 INTEGER PRIMARY KEY,
  index_commit       TEXT,
  working_tree_dirty INTEGER NOT NULL DEFAULT 0,
  mode               TEXT NOT NULL,
  files_total        INTEGER NOT NULL DEFAULT 0,
  files_changed      INTEGER NOT NULL DEFAULT 0,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER
);

-- ── capsule_logs (ROI) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS capsule_logs (
  id             INTEGER PRIMARY KEY,
  task           TEXT NOT NULL,
  index_commit   TEXT,
  capsule_tokens INTEGER NOT NULL,
  naive_estimate INTEGER NOT NULL,
  tokenizer_used TEXT NOT NULL,
  model          TEXT,
  created_at     INTEGER NOT NULL
);

-- ── settings ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── FTS5 (spec §9.3 w_lex) + sync triggers ────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, qualified_name, signature, docstring, search_terms,
  content='symbols', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, qualified_name, signature, docstring, search_terms)
  VALUES (new.id, new.name, new.qualified_name, coalesce(new.signature,''), coalesce(new.docstring,''), coalesce(new.search_terms,''));
END;
CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, signature, docstring, search_terms)
  VALUES ('delete', old.id, old.name, old.qualified_name, coalesce(old.signature,''), coalesce(old.docstring,''), coalesce(old.search_terms,''));
END;
CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, signature, docstring, search_terms)
  VALUES ('delete', old.id, old.name, old.qualified_name, coalesce(old.signature,''), coalesce(old.docstring,''), coalesce(old.search_terms,''));
  INSERT INTO symbols_fts(rowid, name, qualified_name, signature, docstring, search_terms)
  VALUES (new.id, new.name, new.qualified_name, coalesce(new.signature,''), coalesce(new.docstring,''), coalesce(new.search_terms,''));
END;

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  path, content='files', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, path) VALUES (new.id, new.path);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, path) VALUES ('delete', old.id, old.path);
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, path) VALUES ('delete', old.id, old.path);
  INSERT INTO files_fts(rowid, path) VALUES (new.id, new.path);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, body, tags, content='memories', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags)
  VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags)
  VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
