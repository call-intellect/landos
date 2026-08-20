/**
 * @repobrain/shared — core domain types and contracts shared across all packages.
 *
 * Mirrors the data model (spec §8) and the MCP response envelope (spec §10.2).
 * These types are the stable "contract" of the system; packages depend on them,
 * not on each other's internals.
 */

// ─────────────────────────────────────────────────────────────────
// Enums / unions
// ─────────────────────────────────────────────────────────────────

export type Language =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'unknown';

/** spec §8 symbols.kind */
export type SymbolKind =
  | 'module'
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'constant'
  | 'variable'
  | 'route_handler'
  | 'test_case';

/** spec §8 edges.edge_type */
export type EdgeType =
  | 'imports'
  | 'exports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'uses_type'
  | 'defines'
  | 'tested_by'
  | 'route_to_handler'
  | 'depends_on'
  | 'same_module'
  // memory → file: a knowledge note documents/describes a code file (H2a note↔code link).
  | 'documents';

/**
 * spec §0.1(4), §8: edges carry a resolution quality.
 * `exact`     → imports/exports/defines (confidence 1.0)
 * `heuristic` → calls/references (confidence < 1.0, tags.scm based)
 */
export type Resolution = 'exact' | 'heuristic';

export type ParseStatus = 'ok' | 'partial_parse' | 'parse_error';

/** spec §8 memories.type */
export type MemoryType =
  | 'architecture_decision'
  | 'bug_resolution'
  | 'project_convention'
  | 'known_issue'
  | 'failed_attempt'
  | 'agent_note'
  // A note ingested from the repo's second-brain / knowledge folder (the WHY/HOW layer).
  // Kept distinct so re-index can refresh only these without touching team decisions.
  | 'second_brain'
  // A card auto-generated from the code graph (the code-grounded structural skeleton).
  // Distinct from second_brain so it can be refreshed/compared independently.
  | 'generated_brain'
  // A record written by the agent's own memory layer (`memory/*.md`), living in the repo
  // so it survives a move or a clone. Refreshed as its own batch on every index.
  | 'agent_memory';

export type Visibility = 'public' | 'private' | 'protected' | 'internal' | 'unknown';

/** A graph node is addressed by (type, id). */
export type NodeType = 'file' | 'symbol' | 'route' | 'test' | 'memory' | 'package';

// ─────────────────────────────────────────────────────────────────
// Graph store records (spec §8)
// ─────────────────────────────────────────────────────────────────

export interface FileRecord {
  id: number;
  path: string; // repo-relative, POSIX separators
  language: Language;
  hash: string; // content hash (for incremental indexing, spec §0.1(5))
  size_bytes: number;
  lines_count: number;
  last_modified: number; // mtime, epoch ms
  parse_status: ParseStatus;
  is_test: boolean;
  is_generated: boolean;
  has_secrets: boolean; // spec §7.3 — if true, body is NOT stored, only skeleton
  package_id: number | null;
  git_last_commit: string | null;
  git_last_date: string | null; // ISO
  git_churn: number; // commits touching this file within the churn window
  created_at: number;
  updated_at: number;
}

export interface SymbolRecord {
  id: number;
  file_id: number;
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  signature: string | null;
  docstring: string | null;
  start_line: number;
  end_line: number;
  visibility: Visibility;
  exported: boolean;
  hash: string; // hash of the symbol's skeleton — drives incremental re-embedding
  created_at: number;
  updated_at: number;
}

export interface EdgeRecord {
  id: number;
  source_type: NodeType;
  source_id: number;
  target_type: NodeType;
  target_id: number;
  edge_type: EdgeType;
  confidence: number; // 0..1 — spec §0.1(4)
  resolution: Resolution;
  file_id: number | null;
  line: number | null;
  created_at: number;
}

export interface RouteRecord {
  id: number;
  method: string; // GET/POST/...
  path: string;
  handler_symbol_id: number | null;
  file_id: number;
  framework: string | null;
  line: number | null;
  created_at: number;
}

/** spec §8 lists a `tests` table without columns; minimal inferred shape. */
export interface TestRecord {
  id: number;
  file_id: number;
  name: string;
  target_symbol_id: number | null; // symbol under test, if resolved
  start_line: number;
  end_line: number;
  created_at: number;
}

export interface MemoryRecord {
  id: number;
  type: MemoryType;
  title: string;
  body: string;
  related_files: string[]; // paths
  related_symbols: string[]; // qualified names
  tags: string[];
  stale_status: 'fresh' | 'stale';
  created_at: number;
  updated_at: number;
}

export interface PackageRecord {
  id: number;
  name: string;
  root_path: string;
  manifest_path: string | null;
}

export interface IndexRun {
  id: number;
  index_commit: string | null; // git HEAD sha at index time
  working_tree_dirty: boolean;
  mode: 'full' | 'incremental';
  files_total: number;
  files_changed: number;
  started_at: number;
  finished_at: number | null;
}

/** spec §8 symbol_vectors — local embedding of a symbol's skeleton. */
export interface SymbolVector {
  symbol_id: number;
  model_id: string; // e.g. "intfloat/multilingual-e5-small"
  dim: number;
  vector: Float32Array;
  source_hash: string; // hash of embedded text — re-embed only when changed
  updated_at: number;
}

/** spec §14 — saved-estimate ROI logging. */
export interface CapsuleLog {
  id: number;
  task: string;
  index_commit: string | null;
  capsule_tokens: number; // actual cost of the produced capsule
  naive_estimate: number; // tokens an agent would spend reading files by hand + grep overhead
  tokenizer_used: string;
  model: string | null;
  created_at: number;
}

// ─────────────────────────────────────────────────────────────────
// Ranking (spec §9.3)
// ─────────────────────────────────────────────────────────────────

export interface RankingWeights {
  w_lex: number; // lexical BM25/FTS5
  w_sem: number; // semantic cosine (local embeddings) — RU→EN bridge
  w_graph: number; // personalized PageRank over the code graph
  w_path: number; // same package/directory affinity
  w_git: number; // git recency + churn
  w_mem: number; // team memory boost
  w_note: number; // second-brain note --documents--> file bridge (RU query reaches EN code)
}

/** spec §9.3 default weights. Overridable in .repobrain.yaml, tuned via eval (§15). */
export const DEFAULT_WEIGHTS: RankingWeights = {
  w_lex: 0.25,
  w_sem: 0.25,
  w_graph: 0.25,
  w_path: 0.1,
  w_git: 0.075,
  w_mem: 0.075,
  w_note: 0.45,
};

/** Per-node contribution breakdown, surfaced as the capsule's "why". */
export interface ScoreBreakdown {
  lex: number;
  sem: number;
  graph: number;
  path: number;
  git: number;
  mem: number;
  note: number;
  total: number;
}

// ─────────────────────────────────────────────────────────────────
// Context Capsule (spec §9)
// ─────────────────────────────────────────────────────────────────

/** spec §0.1(5), §7.5 — freshness stamp on every capsule and MCP response. */
export interface Freshness {
  index_commit: string | null;
  dirty: boolean; // working tree dirty vs index_commit
  changed_since_index: number; // files changed since index
}

export type ContextDepth = 'full' | 'excerpt' | 'skeleton' | 'signature';

export interface CapsuleItem {
  kind: 'file' | 'symbol' | 'test' | 'memory';
  path?: string;
  symbol?: string; // qualified name
  depth: ContextDepth;
  reason: string; // human-readable "why" (spec §9.6)
  score: number;
  breakdown?: ScoreBreakdown;
  confidence?: number; // for heuristic edges surfaced in the reason
  content?: string; // the rendered chunk (full/excerpt/skeleton/signature)
}

export interface ContextCapsule {
  task: string;
  budget: number; // token budget
  model: string | null;
  freshness: Freshness;
  items: CapsuleItem[];
  related_symbols: string[];
  related_tests: string[];
  possible_impact: string[];
  memory_notes: string[];
  token_estimate: number;
  tokenizer_used: string;
}

// ─────────────────────────────────────────────────────────────────
// MCP unified envelope (spec §10.2) — every tool returns this shape
// ─────────────────────────────────────────────────────────────────

export interface EnvelopeItem {
  type: 'file' | 'symbol' | 'route' | 'test' | 'memory' | 'package';
  path?: string;
  symbol?: string;
  reason: string;
  score?: number;
  confidence?: number; // heuristic tools (find_references, get_callers/callees) set this
  resolution?: Resolution;
}

export interface Envelope {
  summary: string;
  items: EnvelopeItem[];
  recommended_next_files: string[];
  token_estimate: number;
  confidence: number;
  freshness: Freshness;
  next_actions: string[];
}

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

/** multilingual-e5-small embedding dimensionality (spec §0.1(3)). */
export const EMBEDDING_MODEL_DIM = 384;

/** Default token-budget distribution (spec §9.5). Fractions of the budget. */
export const BUDGET_DISTRIBUTION = {
  architecture: 0.1,
  code: 0.35,
  skeletons: 0.25,
  tests: 0.15,
  memories: 0.1,
  safety: 0.05,
} as const;
