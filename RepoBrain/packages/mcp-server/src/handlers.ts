/**
 * Pure MCP tool handlers (spec §10.1) — each maps a RepoBrain call onto the
 * unified response envelope (spec §10.2). They take an already-opened `RepoBrain`
 * and typed input, and return an `Envelope`; they touch no stdio and no SDK, so
 * they are directly unit-testable. `src/index.ts` registers thin wrappers.
 */
import type { RepoBrain } from '@repobrain/core';
import type { SymbolKind, MemoryType, Freshness } from '@repobrain/shared';
import type { Envelope, EnvelopeItem } from './envelope.js';

// ─────────────────────────────────────────────────────────────────
// Input shapes (kept in sync with the Zod inputSchemas in index.ts)
// ─────────────────────────────────────────────────────────────────

export interface SearchCodeInput {
  query: string;
  limit?: number;
}
export interface FindSymbolInput {
  name: string;
  kind?: SymbolKind;
}
export interface TargetInput {
  target: string;
}
export interface PathInput {
  path: string;
}
export interface RoutesInput {
  filter?: string;
}
export interface CapsuleInput {
  task: string;
  token_budget?: number;
  model?: string;
  package?: string;
}
export interface RememberInputArgs {
  note: string;
  type?: MemoryType;
  related_files?: string[];
}
export interface QueryInput {
  query: string;
}

// ─────────────────────────────────────────────────────────────────
// Envelope helpers
// ─────────────────────────────────────────────────────────────────

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const unique = (xs: string[]): string[] => [...new Set(xs)];

/** Build a complete envelope from a partial, filling required defaults. */
function envelope(
  base: { summary: string; freshness: Freshness } & Partial<Envelope>,
): Envelope {
  return {
    summary: base.summary,
    items: base.items ?? [],
    recommended_next_files: base.recommended_next_files ?? [],
    token_estimate: base.token_estimate ?? 0,
    confidence: base.confidence ?? 0.5,
    freshness: base.freshness,
    next_actions: base.next_actions ?? [],
  };
}

/** Returned when the repo has no index — tools must not crash (spec §7.5). */
export function notIndexedEnvelope(message?: string): Envelope {
  return envelope({
    summary:
      (message ? `${message} ` : '') +
      'RepoBrain has no index for this repository. Run `repobrain index` in the repo root, then retry.',
    freshness: { index_commit: null, dirty: false, changed_since_index: 0 },
    confidence: 0,
    next_actions: ['Run `repobrain index` in the repository root, then call this tool again.'],
  });
}

// ─────────────────────────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────────────────────────

export async function searchCode(brain: RepoBrain, input: SearchCodeInput): Promise<Envelope> {
  const results = await brain.searchCode(input.query, input.limit);
  const items: EnvelopeItem[] = results.map((r) => ({
    type: 'symbol',
    path: r.path,
    symbol: r.symbol,
    reason: r.reason,
    score: r.score,
  }));
  return envelope({
    summary: `${results.length} match${results.length === 1 ? '' : 'es'} for "${input.query}".`,
    items,
    recommended_next_files: unique(results.map((r) => r.path)).slice(0, 5),
    confidence: results.length ? 0.7 : 0.2,
    freshness: brain.freshness(),
    next_actions: results.length
      ? [`Open ${results[0]!.path} to inspect ${results[0]!.symbol}.`]
      : ['Broaden the query, or run make_context_capsule for task-oriented context.'],
  });
}

export function findSymbol(brain: RepoBrain, input: FindSymbolInput): Envelope {
  const hits = brain.findSymbol(input.name, input.kind);
  const items: EnvelopeItem[] = hits.map((h) => ({
    type: 'symbol',
    path: h.path,
    symbol: h.symbol.qualified_name,
    reason: `${h.symbol.kind} ${h.symbol.qualified_name} — ${h.path}:${h.symbol.start_line}`,
    resolution: 'exact',
  }));
  return envelope({
    summary: `${hits.length} symbol${hits.length === 1 ? '' : 's'} named "${input.name}"${
      input.kind ? ` (kind ${input.kind})` : ''
    }.`,
    items,
    recommended_next_files: unique(hits.map((h) => h.path)).slice(0, 5),
    confidence: hits.length ? 0.9 : 0.2,
    freshness: brain.freshness(),
    next_actions: hits.length
      ? [`Read ${hits[0]!.path} around line ${hits[0]!.symbol.start_line}.`]
      : ['Try search_code for a fuzzy/semantic lookup.'],
  });
}

export function findReferences(brain: RepoBrain, input: TargetInput): Envelope {
  const hits = brain.references(input.target);
  const items: EnvelopeItem[] = hits.map((h) => ({
    type: 'symbol',
    path: h.path,
    symbol: h.symbol.qualified_name,
    reason: `references ${input.target}${h.line != null ? ` at ${h.path}:${h.line}` : ''} (heuristic)`,
    confidence: h.confidence,
    resolution: h.resolution,
  }));
  const avg = hits.length ? hits.reduce((s, h) => s + h.confidence, 0) / hits.length : 0;
  return envelope({
    summary: `${hits.length} heuristic reference${hits.length === 1 ? '' : 's'} to "${input.target}" (call-graph based).`,
    items,
    recommended_next_files: unique(hits.map((h) => h.path)).slice(0, 5),
    // heuristic tool → lower overall confidence than the exact edges
    confidence: clamp01(avg * 0.9),
    freshness: brain.freshness(),
    next_actions: hits.length ? [`Review usages in ${hits[0]!.path}.`] : [],
  });
}

export function getFileOverview(brain: RepoBrain, input: PathInput): Envelope {
  const ov = brain.fileOverview(input.path);
  if (!ov) {
    return envelope({
      summary: `No file "${input.path}" in the index (paths are repo-relative, POSIX separators).`,
      confidence: 0.2,
      freshness: brain.freshness(),
      next_actions: ['Check the path, or run get_architecture_summary to list modules.'],
    });
  }
  const items: EnvelopeItem[] = ov.symbols.map((s) => ({
    type: 'symbol',
    path: ov.file.path,
    symbol: s.qualified_name,
    reason: `${s.kind}${s.signature ? ` ${s.signature}` : ''} (lines ${s.start_line}-${s.end_line})`,
  }));
  const importList = ov.imports.length ? ` Imports: ${ov.imports.slice(0, 6).join(', ')}.` : '';
  const importedByList = ov.importedBy.length
    ? ` Imported by: ${ov.importedBy.slice(0, 6).join(', ')}.`
    : '';
  return envelope({
    summary:
      `${ov.file.path} — ${ov.symbols.length} symbol${ov.symbols.length === 1 ? '' : 's'}, ` +
      `${ov.file.lines_count} lines, ${ov.imports.length} import(s), ${ov.importedBy.length} importer(s).` +
      importList +
      importedByList,
    items,
    recommended_next_files: unique([ov.file.path, ...ov.imports]).slice(0, 5),
    confidence: 0.9,
    freshness: brain.freshness(),
    next_actions: [
      `Read ${ov.file.path}.`,
      ...(ov.importedBy.length ? [`Check importers: ${ov.importedBy.slice(0, 3).join(', ')}.`] : []),
    ],
  });
}

function edgeEnvelope(brain: RepoBrain, dir: 'callers' | 'callees', target: string): Envelope {
  const hits = dir === 'callers' ? brain.callers(target) : brain.callees(target);
  const verb = dir === 'callers' ? 'called by' : 'calls';
  const items: EnvelopeItem[] = hits.map((h) => ({
    type: 'symbol',
    path: h.path,
    symbol: h.symbol.qualified_name,
    reason: `${target} ${verb} ${h.symbol.qualified_name}${h.line != null ? ` (${h.path}:${h.line})` : ''}`,
    confidence: h.confidence,
    resolution: h.resolution,
  }));
  const avg = hits.length ? hits.reduce((s, h) => s + h.confidence, 0) / hits.length : 0;
  const noun = dir === 'callers' ? 'caller' : 'callee';
  return envelope({
    summary: `${target} has ${hits.length} ${noun}${hits.length === 1 ? '' : 's'} (heuristic call-graph edges).`,
    items,
    recommended_next_files: unique(hits.map((h) => h.path)).slice(0, 5),
    confidence: clamp01(avg * 0.9),
    freshness: brain.freshness(),
    next_actions: hits.length ? [`Inspect ${hits[0]!.path}.`] : [],
  });
}

export function getCallers(brain: RepoBrain, input: TargetInput): Envelope {
  return edgeEnvelope(brain, 'callers', input.target);
}
export function getCallees(brain: RepoBrain, input: TargetInput): Envelope {
  return edgeEnvelope(brain, 'callees', input.target);
}

export function getRoutes(brain: RepoBrain, input: RoutesInput): Envelope {
  const routes = brain.routes(input.filter);
  const items: EnvelopeItem[] = routes.map((r) => ({
    type: 'route',
    path: `${r.method} ${r.path}`,
    reason: r.framework ? `${r.framework} route` : 'route',
  }));
  return envelope({
    summary: routes.length
      ? `${routes.length} route${routes.length === 1 ? '' : 's'}${input.filter ? ` matching "${input.filter}"` : ''}.`
      : `No routes found${input.filter ? ` for "${input.filter}"` : ' in the index'}.`,
    items,
    confidence: routes.length ? 0.9 : 0.4,
    freshness: brain.freshness(),
  });
}

export function getImpact(brain: RepoBrain, input: TargetInput): Envelope {
  const imp = brain.impact(input.target);
  const items: EnvelopeItem[] = [
    ...imp.importers.map(
      (p): EnvelopeItem => ({ type: 'file', path: p, reason: `imports ${imp.file ?? input.target}` }),
    ),
    ...imp.tests.map((p): EnvelopeItem => ({ type: 'test', path: p, reason: `tests ${input.target}` })),
  ];
  const callerNote = imp.callers.length
    ? `: ${imp.callers.slice(0, 8).join(', ')}${imp.callers.length > 8 ? ', …' : ''}`
    : '';
  return envelope({
    summary:
      `${input.target}${imp.file ? ` (${imp.file})` : ''} — ` +
      `${imp.importers.length} importer(s), ${imp.tests.length} test(s), ${imp.callers.length} caller(s)${callerNote}.`,
    items,
    recommended_next_files: unique([...(imp.file ? [imp.file] : []), ...imp.importers]).slice(0, 5),
    confidence: 0.7,
    freshness: brain.freshness(),
    next_actions: imp.tests.length ? [`Run affected tests: ${imp.tests.slice(0, 5).join(', ')}.`] : [],
  });
}

/** Shared capsule→envelope mapping, reused by the pure handler and the wrapper. */
export function capsuleToEnvelope(
  capsule: Awaited<ReturnType<RepoBrain['capsule']>>['capsule'],
  warnings: { warning: string }[],
  freshness: Freshness,
): Envelope {
  const items: EnvelopeItem[] = capsule.items.map((it) => ({
    type: it.kind,
    path: it.path,
    symbol: it.symbol,
    reason: it.reason,
    score: it.score,
    confidence: it.confidence,
  }));
  const paths = unique(capsule.items.map((it) => it.path).filter((p): p is string => !!p));
  let summary =
    `Context capsule for "${capsule.task}": ${capsule.items.length} item(s), ` +
    `~${capsule.token_estimate} tokens (${capsule.tokenizer_used}). ` +
    'The full rendered capsule (markdown) is included as a second text block.';
  if (warnings.length) summary += ` ⚠ ${warnings.map((w) => w.warning).join('; ')}`;

  const nextActions: string[] = [];
  if (paths.length) nextActions.push(`Read the top files: ${paths.slice(0, 3).join(', ')}.`);
  if (capsule.related_tests.length)
    nextActions.push(`Run related tests: ${capsule.related_tests.slice(0, 3).join(', ')}.`);
  if (capsule.possible_impact.length)
    nextActions.push(`Consider impact on: ${capsule.possible_impact.slice(0, 3).join(', ')}.`);

  return envelope({
    summary,
    items,
    recommended_next_files: paths.slice(0, 5),
    token_estimate: capsule.token_estimate,
    confidence: clamp01(freshness.dirty ? 0.65 : 0.8),
    freshness,
    next_actions: nextActions,
  });
}

/** Returns the envelope plus the rendered markdown (for the extra content block). */
export async function makeContextCapsuleFull(
  brain: RepoBrain,
  input: CapsuleInput,
): Promise<{ envelope: Envelope; markdown: string }> {
  const { capsule, markdown, warnings } = await brain.capsule(input.task, {
    budget: input.token_budget,
    model: input.model,
  });
  return { envelope: capsuleToEnvelope(capsule, warnings, brain.freshness()), markdown };
}

export async function makeContextCapsule(brain: RepoBrain, input: CapsuleInput): Promise<Envelope> {
  return (await makeContextCapsuleFull(brain, input)).envelope;
}

export function getArchitectureSummary(brain: RepoBrain): Envelope {
  const a = brain.architecture();
  const items: EnvelopeItem[] = a.godFiles.map((g) => ({
    type: 'file',
    path: g.path,
    reason: `${g.symbols} symbol(s), imported by ${g.importedBy} file(s)`,
    score: g.symbols + g.importedBy * 2,
  }));
  const langs = Object.entries(a.languages)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  const modules = a.modules
    .slice(0, 5)
    .map((m) => `${m.dir}(${m.files})`)
    .join(', ');
  return envelope({
    summary:
      `Architecture — ${a.counts.files} files, ${a.counts.symbols} symbols, ${a.counts.edges} edges, ` +
      `${a.counts.routes} routes. Languages: ${langs || 'n/a'}. ` +
      `Top modules: ${modules || 'n/a'}. ` +
      `Entry points: ${a.entrypoints.slice(0, 5).join(', ') || 'n/a'}.`,
    items,
    recommended_next_files: unique([...a.entrypoints, ...a.godFiles.map((g) => g.path)]).slice(0, 5),
    confidence: 0.9,
    freshness: brain.freshness(),
    next_actions: a.entrypoints.length
      ? [`Start at an entry point: ${a.entrypoints.slice(0, 3).join(', ')}.`]
      : [],
  });
}

export function rememberDecision(brain: RepoBrain, input: RememberInputArgs): Envelope {
  const id = brain.remember({
    note: input.note,
    type: input.type,
    related_files: input.related_files,
  });
  return envelope({
    summary: `Saved memory #${id}.`,
    confidence: 1,
    freshness: brain.freshness(),
    next_actions: ['Use get_team_memory to retrieve saved decisions in future tasks.'],
  });
}

export function getTeamMemory(brain: RepoBrain, input: QueryInput): Envelope {
  const mems = brain.teamMemory(input.query);
  const items: EnvelopeItem[] = mems.map((m) => ({
    type: 'memory',
    reason: m.title,
    ...(m.related_symbols[0] ? { symbol: m.related_symbols[0] } : {}),
    ...(m.related_files[0] ? { path: m.related_files[0] } : {}),
  }));
  return envelope({
    summary: mems.length
      ? `${mems.length} team-memory note${mems.length === 1 ? '' : 's'} for "${input.query}".`
      : `No team memory for "${input.query}".`,
    items,
    recommended_next_files: unique(mems.flatMap((m) => m.related_files)).slice(0, 5),
    confidence: mems.length ? 0.8 : 0.3,
    freshness: brain.freshness(),
  });
}

export function getTokenStats(brain: RepoBrain): Envelope {
  const s = brain.tokenStats();
  return envelope({
    summary:
      `≈${s.saved} tokens saved across ${s.count} capsule${s.count === 1 ? '' : 's'} ` +
      `(capsules cost ${s.capsule_tokens}; naive exploration ≈ ${s.naive_estimate}).`,
    token_estimate: s.capsule_tokens,
    confidence: 1,
    freshness: brain.freshness(),
  });
}
