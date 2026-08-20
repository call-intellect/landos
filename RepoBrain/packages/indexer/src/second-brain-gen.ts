/**
 * Code-grounded second-brain generator.
 *
 * Philosophy (see docs/DECISIONS.md): the second brain MUST be grounded in code — anything not
 * derivable from code is a bug (hallucination or drift). So we generate the structural skeleton
 * *deterministically* from the graph — never inventing rationale. The WHY stays a stub the agent
 * fills at authoring time, anchored + dated. This is what makes double-search work on a fresh repo
 * that has no hand-written notes.
 *
 * Granularity is a knob (L0/L1/L2), chosen by measurement (precision-per-token), not opinion:
 *   L0 — structure only: path, exports, used-by, depends-on (pure graph edges; ~zero drift).
 *   L1 — + a grounded one-line purpose (file role from naming + key export; blank if none).
 *   L2 — + key signatures and routes table.
 * Each card embeds a subtokenized `Terms:` line so natural-word FTS queries match glued identifiers
 * (the memories FTS tokenizer, unlike symbols_fts, does not split camelCase).
 */

import { basename, extname } from 'node:path';
import type { GraphStore } from '@repobrain/graph-store';
import { subtokenize } from '@repobrain/graph-store';

export type BrainLevel = 'L0' | 'L1' | 'L2';

export interface GenerateBrainOptions {
  level?: BrainLevel; // default L1
  maxCards?: number; // max per-file cards (significance-ranked). default 60
  onProgress?: (msg: string) => void;
}

export interface GeneratedCard {
  title: string;
  body: string;
  section: string; // top-level folder, drives section weighting (e.g. '02_architecture')
  path: string; // synthetic source path, cited in the capsule (tags[0])
  documents: string[]; // code file paths this card describes (seeds note↔code edges, H2a)
}

export interface GenerateBrainResult {
  cards: number;
  level: BrainLevel;
}

interface FileAgg {
  fileId: number;
  path: string;
  symbols: number;
  importers: number[]; // file ids that import this
  imports: number[]; // file ids this imports
  score: number;
}

/** Humanize a filename into space-separated words (also the searchable title). */
function humanize(path: string): string {
  const base = basename(path, extname(path));
  const words = subtokenize(base).trim();
  return words || base;
}

/** A grounded one-line role from naming convention + top export (no invented behavior). */
function roleOf(path: string, topExport: string | null): string {
  const b = basename(path).toLowerCase();
  let role = 'module';
  if (b.includes('.service.')) role = 'service';
  else if (b.includes('.controller.')) role = 'HTTP controller (routes)';
  else if (b.includes('.worker.')) role = 'background worker';
  else if (b.includes('.cron.')) role = 'scheduled job (cron)';
  else if (b.includes('.dto.')) role = 'data shapes (DTO)';
  else if (b.includes('.module.')) role = 'DI module';
  else if (b.includes('.guard.')) role = 'access guard';
  else if (b.includes('.resolver.')) role = 'resolver';
  else if (/(^|\/)(index|main|app|server|cli)\.[a-z]+$/.test(path)) role = 'entry point';
  return topExport ? `${role} — key export \`${topExport}\`` : role;
}

/**
 * Build the code-grounded cards from the graph. Returns a module-map card plus per-file cards for
 * the most significant files (significance = symbol count + 2× importer count).
 */
export function generateBrainCards(store: GraphStore, opts: GenerateBrainOptions = {}): GeneratedCard[] {
  const level = opts.level ?? 'L1';
  const files = store.allFiles().filter((f) => !f.is_generated);
  // Coverage must SCALE with repo size, not be absolute. Measured: ~200 cards suits a 5k-file repo
  // (kora), but the SAME 200 floods a 410-file repo (vibeceh) — the memory channel drowns in cards and
  // both retrieval and hand-note precision drop. So ~6% of files, floored at 30, capped at 250.
  const maxCards = opts.maxCards ?? Math.min(250, Math.max(30, Math.round(files.length * 0.06)));
  const symCount = new Map<number, number>();
  for (const s of store.allSymbols()) symCount.set(s.file_id, (symCount.get(s.file_id) ?? 0) + 1);

  const importers = new Map<number, number[]>();
  const imports = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, k: number, v: number): void => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  for (const e of store.edgesForRanking()) {
    if (e.edge_type === 'imports' && e.source_type === 'file' && e.target_type === 'file') {
      push(importers, e.target_id, e.source_id);
      push(imports, e.source_id, e.target_id);
    }
  }

  const aggs: FileAgg[] = files
    .map((f) => {
      const symbols = symCount.get(f.id) ?? 0;
      const imp = importers.get(f.id) ?? [];
      return { fileId: f.id, path: f.path, symbols, importers: imp, imports: imports.get(f.id) ?? [], score: symbols + imp.length * 2 };
    })
    .filter((a) => a.symbols > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));

  const cards: GeneratedCard[] = [];
  cards.push(moduleMapCard(store, files, aggs, symCount, importers));

  for (const a of aggs.slice(0, maxCards)) {
    cards.push(fileCard(store, a, level));
  }
  return cards;
}

function moduleMapCard(
  store: GraphStore,
  files: { id: number; path: string }[],
  aggs: FileAgg[],
  symCount: Map<number, number>,
  importers: Map<number, number[]>,
): GeneratedCard {
  const dirCount = new Map<string, number>();
  for (const f of files) {
    const seg = f.path.split('/').slice(0, 2).join('/');
    dirCount.set(seg, (dirCount.get(seg) ?? 0) + 1);
  }
  const topDirs = [...dirCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const godFiles = aggs.slice(0, 12);
  const entrypoints = files
    .filter((f) => (importers.get(f.id)?.length ?? 0) === 0 && (symCount.get(f.id) ?? 0) > 0)
    .filter((f) => /(^|\/)(index|main|app|server|cli|__main__)\.[a-z]+$/i.test(f.path))
    .slice(0, 12);

  const lines: string[] = [];
  lines.push('# Module map', '', '_Generated from the code graph. Structural facts only._', '');
  lines.push('## Top modules (dir → files)');
  for (const [dir, n] of topDirs) lines.push(`- \`${dir}\` — ${n} files`);
  lines.push('', '## Central files (most connected)');
  for (const g of godFiles) lines.push(`- \`${g.path}\` — ${g.symbols} symbols, imported by ${g.importers.length}`);
  if (entrypoints.length) {
    lines.push('', '## Entry points');
    for (const e of entrypoints) lines.push(`- \`${e.path}\``);
  }
  const terms = subtokenize(...topDirs.map((d) => d[0]), ...godFiles.map((g) => g.path));
  lines.push('', `Terms: ${terms}`);
  return { title: 'Module map', body: lines.join('\n'), section: '02_architecture', path: 'generated/02_architecture/module-map.md', documents: godFiles.map((g) => g.path) };
}

function fileCard(store: GraphStore, a: FileAgg, level: BrainLevel): GeneratedCard {
  const syms = store.symbolsByFile(a.fileId);
  const exported = syms.filter((s) => s.exported);
  const key = (exported.length ? exported : syms).slice(0, 12);
  const topExport = key[0]?.name ?? null;
  const title = humanize(a.path);

  const lines: string[] = [`# ${title}`, '', `Path: \`${a.path}\``];
  if (level !== 'L0') lines.push(`Purpose: ${roleOf(a.path, topExport)}`);
  if (key.length) lines.push(`Exports: ${key.map((s) => `\`${s.name}\``).join(', ')}`);

  const importerPaths = a.importers
    .map((id) => store.getFile(id)?.path)
    .filter((p): p is string => !!p)
    .slice(0, 8);
  const importPaths = a.imports
    .map((id) => store.getFile(id)?.path)
    .filter((p): p is string => !!p)
    .slice(0, 8);
  if (importerPaths.length) lines.push(`Used by: ${importerPaths.map((p) => `\`${p}\``).join(', ')}`);
  if (importPaths.length) lines.push(`Depends on: ${importPaths.map((p) => `\`${p}\``).join(', ')}`);

  if (level === 'L2') {
    const sigs = key.filter((s) => s.signature).slice(0, 8);
    if (sigs.length) {
      lines.push('', 'Signatures:');
      for (const s of sigs) lines.push(`- \`${s.signature}\``);
    }
    const routes = store.allRoutes().filter((r) => r.file_id === a.fileId);
    if (routes.length) {
      lines.push('', 'Routes:');
      for (const r of routes.slice(0, 12)) lines.push(`- ${r.method} ${r.path}`);
    }
  }

  // subtokenized terms so natural-word FTS queries match glued identifiers (title, exports, path)
  const terms = subtokenize(a.path, ...key.map((s) => s.name), ...key.map((s) => s.signature ?? ''));
  lines.push('', `Terms: ${terms}`);

  const slug = a.path.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  return { title, body: lines.join('\n'), section: '01_projects', path: `generated/01_projects/${slug}.md`, documents: [a.path] };
}

/**
 * Generate + store the code-grounded brain as `generated_brain` memories. Idempotent: clears the
 * prior generated batch first (leaves hand-written `second_brain` notes untouched).
 */
export function ingestGeneratedBrain(
  store: GraphStore,
  opts: GenerateBrainOptions = {},
): GenerateBrainResult {
  const log = opts.onProgress ?? (() => {});
  const level = opts.level ?? 'L1';
  const cards = generateBrainCards(store, opts);
  store.deleteMemoriesByType('generated_brain');
  store.transaction(() => {
    for (const c of cards) {
      store.insertMemory({
        type: 'generated_brain',
        title: c.title,
        body: c.body,
        related_files: c.documents, // seeds note↔code edges (H2a)
        related_symbols: [],
        tags: [c.path, c.section],
        stale_status: 'fresh',
      });
    }
  });
  log(`generated-brain: wrote ${cards.length} code-grounded cards (${level})`);
  return { cards: cards.length, level };
}
