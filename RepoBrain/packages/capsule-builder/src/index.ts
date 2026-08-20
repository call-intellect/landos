import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphStore } from '@repobrain/graph-store';
import type { Embedder } from '@repobrain/embeddings';
import { rankForTask, type RankedSymbol } from '@repobrain/ranker';
import { countTokens } from '@repobrain/token-meter';
import { scanForSecrets } from '@repobrain/security';
import { subtokenize } from '@repobrain/graph-store';
import { rankKnowledgeScored, isKnowledgeNote } from '@repobrain/memory';
import type {
  ContextCapsule,
  CapsuleItem,
  ContextDepth,
  Freshness,
  Language,
  RankingWeights,
  SymbolRecord,
  FileRecord,
  MemoryRecord,
} from '@repobrain/shared';

export interface BuildCapsuleOptions {
  root: string;
  budget?: number; // token budget, default 8000
  model?: string; // for the tokenizer, default 'generic'
  weights?: RankingWeights;
  freshness: Freshness;
  rankLimit?: number; // symbols to rank, default 80
  noteLimit?: number; // second-brain notes walked for the note→code bridge, default 10
  /**
   * Cap a single file's share of the code budget (default 0.5). Stops one large,
   * top-ranked file rendered `full` from starving the capsule down to 2-3 files and
   * dropping other correctly-ranked files (observed on kora: livekit ranked #7 but
   * excluded). Small repos are unaffected (their files fit under the cap anyway).
   */
  perFileCapFraction?: number;
}

export interface CapsuleResult {
  capsule: ContextCapsule;
  markdown: string;
}

interface RankedFile {
  file: FileRecord;
  score: number;
  symbols: RankedSymbol[]; // ranked symbols within this file (desc)
}

function fenceLang(language: Language): string {
  switch (language) {
    case 'typescript':
    case 'tsx':
      return 'ts';
    case 'javascript':
    case 'jsx':
      return 'js';
    case 'python':
      return 'python';
    default:
      return '';
  }
}

function groupByFile(ranked: RankedSymbol[]): RankedFile[] {
  const byFile = new Map<number, RankedFile>();
  for (const r of ranked) {
    let rf = byFile.get(r.file.id);
    if (!rf) {
      rf = { file: r.file, score: r.score, symbols: [] };
      byFile.set(r.file.id, rf);
    }
    rf.score = Math.max(rf.score, r.score);
    rf.symbols.push(r);
  }
  return [...byFile.values()].sort(
    (a, b) => b.score - a.score || (a.file.path < b.file.path ? -1 : 1),
  );
}

function renderFull(content: string, lang: string): string {
  return '```' + lang + '\n' + content.trimEnd() + '\n```';
}

function renderExcerpt(content: string, symbols: RankedSymbol[], lang: string): string {
  const lines = content.split('\n');
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const s of symbols.slice(0, 4)) {
    const a = Math.max(1, s.symbol.start_line);
    const b = Math.min(lines.length, s.symbol.end_line);
    const key = `${a}-${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(lines.slice(a - 1, b).join('\n'));
  }
  return '```' + lang + '\n' + parts.join('\n\n') + '\n```';
}

function renderSkeleton(store: GraphStore, file: FileRecord, lang: string): string {
  const syms = store.symbolsByFile(file.id).sort((a, b) => a.start_line - b.start_line);
  const lines: string[] = [`// ${file.path}`];
  for (const s of syms) {
    if (s.docstring) lines.push(`// ${s.docstring.slice(0, 120)}`);
    const sig = s.signature || `${s.kind} ${s.name}`;
    lines.push(sig.endsWith(')') || sig.includes('(') ? `${sig} { /* … */ }` : sig);
  }
  return '```' + lang + '\n' + lines.join('\n') + '\n```';
}

function renderSignatures(symbols: RankedSymbol[]): string {
  return symbols
    .slice(0, 8)
    .map((s) => `- \`${s.symbol.signature || s.symbol.name}\` (${s.symbol.qualified_name})`)
    .join('\n');
}

/**
 * Render one memory/second-brain note as a cited, budget-capped snippet.
 * - second-brain notes are prefixed with their source path (tags[0]) so the agent can open
 *   the full note; the snippet is a window around the first query-term match (fallback: head).
 * - the whole thing is trimmed to `capTokens` so several notes fit the memory budget.
 * Returns null if nothing meaningful fits.
 */
function renderMemoryNote(
  item: { type: string; title: string; body: string; tags: string[]; stale_status?: string },
  task: string,
  tok: (s: string) => number,
  capTokens: number,
): string | null {
  const path = isKnowledgeNote(item.type) ? item.tags[0] : undefined;
  // Warn the agent when a note cites code that no longer exists — outdated WHY is worse than none.
  const stale = item.stale_status === 'stale' ? '⚠ possibly outdated — ' : '';
  const header = path ? `${stale}[${path}] ${item.title}` : `${stale}${item.title}`;
  const snippet = snippetForQuery(item.body, task);
  let text = snippet ? `${header} — ${snippet}` : header;
  // greedily trim the snippet (not the header) until it fits the per-note cap
  if (tok(text) > capTokens) {
    let lo = 0;
    let hi = snippet.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = `${header} — ${snippet.slice(0, mid)}…`;
      if (tok(candidate) <= capTokens) lo = mid;
      else hi = mid - 1;
    }
    text = lo > 0 ? `${header} — ${snippet.slice(0, lo)}…` : header;
  }
  return tok(text) <= capTokens ? text : null;
}

/** A ~one-paragraph window of `body` around the first query-term hit; head of body otherwise. */
function snippetForQuery(body: string, task: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const terms = (task.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).slice(0, 12);
  let at = -1;
  const lower = flat.toLowerCase();
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const WIN = 480;
  if (at < 0) return flat.slice(0, WIN);
  const start = Math.max(0, at - 80);
  return (start > 0 ? '…' : '') + flat.slice(start, start + WIN);
}

/**
 * Query expansion for the knowledge channel (H1), via the code hits (pseudo-relevance feedback).
 * The code graph already nails the right files (kora 3/3); their identifiers are the bridge to the
 * right note — `security.md` names `encryption.service.ts`, `llm-router.md` names the router file.
 * So enrich the note query with subtokens of the TOP code hits' filenames + symbol names. General
 * (derived from the index, no hardcoding), bounded to `max` new terms to avoid drift.
 */
function codeTermsForNotes(ranked: RankedSymbol[], task: string, max = 12): string {
  const have = new Set(subtokenize(task).split(' '));
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const r of ranked.slice(0, 10)) {
    const base = r.file.path.split('/').pop() ?? r.file.path;
    for (const w of subtokenize(base, r.symbol.name).split(' ')) {
      if (w.length < 3 || have.has(w) || seen.has(w)) continue;
      seen.add(w);
      terms.push(w);
      if (terms.length >= max) return terms.join(' ');
    }
  }
  return terms.join(' ');
}

const DEPTH_ORDER: ContextDepth[] = ['full', 'excerpt', 'skeleton', 'signature'];

export async function buildCapsule(
  store: GraphStore,
  embedder: Embedder | null,
  task: string,
  opts: BuildCapsuleOptions,
): Promise<CapsuleResult> {
  const budget = opts.budget ?? 8000;
  const model = opts.model ?? 'generic';
  const tok = (t: string) => countTokens(t, model).tokens;
  const tokenizerUsed = countTokens('x', model).tokenizer;

  const ranked = await rankForTask(store, embedder, task, {
    weights: opts.weights,
    limit: opts.rankLimit ?? 80,
    noteLimit: opts.noteLimit,
  });
  const rankedFiles = groupByFile(ranked);

  // budget split (§9.5)
  const codeBudget = Math.floor(budget * 0.7); // full/excerpt/skeleton/signature code
  const testBudget = Math.floor(budget * 0.15);
  const memoryBudget = Math.floor(budget * 0.1);
  // No single file may consume more than this share of the code budget (see options).
  const perFileCap = Math.max(600, Math.floor(codeBudget * (opts.perFileCapFraction ?? 0.5)));

  const items: CapsuleItem[] = [];
  const includedFileIds = new Set<number>();
  const relatedSymbols = new Set<string>();
  let codeUsed = 0;

  for (const rf of rankedFiles) {
    if (codeUsed >= codeBudget) break;
    const lang = fenceLang(rf.file.language);
    let content = '';
    try {
      content = readFileSync(join(opts.root, rf.file.path), 'utf8');
    } catch {
      content = '';
    }
    if (rf.file.has_secrets && content) content = scanForSecrets(content).redacted;

    // candidate renderings by depth, richest first. `allowed` caps this file's spend so a
    // single large file can't swallow the whole capsule (it degrades to excerpt/skeleton
    // instead, leaving room for other ranked files).
    const remaining = codeBudget - codeUsed;
    const allowed = Math.min(remaining, perFileCap);
    const renderings: { depth: ContextDepth; block: string }[] = [];
    if (content && !rf.file.has_secrets) {
      renderings.push({ depth: 'full', block: renderFull(content, lang) });
      renderings.push({ depth: 'excerpt', block: renderExcerpt(content, rf.symbols, lang) });
    }
    renderings.push({ depth: 'skeleton', block: renderSkeleton(store, rf.file, lang) });
    renderings.push({ depth: 'signature', block: renderSignatures(rf.symbols) });

    let chosen: { depth: ContextDepth; block: string; tokens: number } | null = null;
    for (const r of renderings) {
      const t = tok(r.block);
      if (t <= allowed) {
        chosen = { ...r, tokens: t };
        break;
      }
    }
    // if even signatures don't fit, still record a reference (0 content)
    if (!chosen) {
      const sigBlock = renderSignatures(rf.symbols);
      chosen = { depth: 'signature', block: sigBlock, tokens: tok(sigBlock) };
      if (chosen.tokens > remaining) continue; // truly no room
    }
    codeUsed += chosen.tokens;
    includedFileIds.add(rf.file.id);
    const top = rf.symbols[0]!;
    for (const s of rf.symbols.slice(0, 5)) relatedSymbols.add(s.symbol.qualified_name);
    items.push({
      kind: 'file',
      path: rf.file.path,
      symbol: top.symbol.qualified_name,
      depth: chosen.depth,
      reason: top.reasons.join('; '),
      score: rf.score,
      breakdown: top.breakdown,
      content: chosen.block,
    });
  }

  // ── related tests ──
  const relatedTests = new Set<string>();
  for (const fid of includedFileIds) {
    for (const s of store.symbolsByFile(fid)) {
      for (const e of store.edgesFrom('symbol', s.id)) {
        if (e.edge_type === 'tested_by' && e.target_type === 'file') {
          const tf = store.getFile(e.target_id);
          if (tf) relatedTests.add(tf.path);
        }
      }
    }
  }
  let testUsed = 0;
  for (const tp of relatedTests) {
    const line = `- ${tp}`;
    const t = tok(line);
    if (testUsed + t > testBudget) break;
    testUsed += t;
  }

  // ── memory notes (double-search WHY/HOW channel) ──
  // Notes (esp. ingested second-brain docs) can be thousands of tokens; render a cited
  // snippet, not the whole note, and cap each so several fit. `continue` (not `break`) so a
  // single large note can't shut out the rest — the earlier `break` dropped every big note.
  const memoryNotes: string[] = [];
  let memUsed = 0;
  // Spread the memory budget over more, shorter notes (~6-8) so a correct-but-mid-ranked note
  // isn't cut by a 3-note ceiling. Recall of the right note matters more than a long snippet.
  const perNoteCap = Math.max(90, Math.floor(memoryBudget / 6));
  // Knowledge query = task + terms bridged from the top code hits (H1 expansion), scored by section +
  // title weighting (H3). Expansion pulls the right note across a vocabulary gap (e.g. a Russian-titled
  // security note reached via the English identifier `encryption.service.ts`).
  const noteQuery = `${task} ${codeTermsForNotes(ranked, task)}`.trim();
  const scored = new Map<number, { item: MemoryRecord; score: number }>();
  for (const s of rankKnowledgeScored(store, noteQuery, 30)) scored.set(s.item.id, { item: s.item, score: s.score });

  // H2a: BLEND (not override) an edge bonus for a note that documents a code file already in the capsule —
  // weighted by that file's rank. This lifts a lexically-weak-but-correct note (auth doc reached via
  // `jwt.service.ts`) without burying a lexically-strong one (its own doc gets the bonus too).
  const EDGE_W = 5;
  let fr = 0;
  const nInc = includedFileIds.size;
  for (const fid of includedFileIds) {
    const bonus = EDGE_W * (nInc - fr);
    fr++;
    for (const e of store.edgesTo('file', fid)) {
      if (e.edge_type !== 'documents' || e.source_type !== 'memory') continue;
      const existing = scored.get(e.source_id);
      if (existing) existing.score += bonus;
      else {
        const m = store.getMemory(e.source_id);
        if (m) scored.set(m.id, { item: m, score: bonus });
      }
    }
  }
  const mergedNotes = [...scored.values()].sort((a, b) => b.score - a.score).map((s) => s.item);

  for (const item of mergedNotes) {
    if (memUsed >= memoryBudget) break;
    const note = renderMemoryNote(item, task, (s) => tok(s), Math.min(perNoteCap, memoryBudget - memUsed));
    if (!note) continue;
    memUsed += tok(note);
    memoryNotes.push(note);
  }

  // ── possible impact: importers of the top included file ──
  const possibleImpact: string[] = [];
  const topFile = rankedFiles.find((rf) => includedFileIds.has(rf.file.id));
  if (topFile) {
    for (const e of store.edgesTo('file', topFile.file.id)) {
      if (e.edge_type === 'imports' && e.source_type === 'file') {
        const imp = store.getFile(e.source_id);
        if (imp && !possibleImpact.includes(imp.path)) possibleImpact.push(imp.path);
      }
    }
  }

  const markdown = renderMarkdown({
    task,
    freshness: opts.freshness,
    items,
    relatedSymbols: [...relatedSymbols],
    relatedTests: [...relatedTests],
    possibleImpact,
    memoryNotes,
    model,
  });
  const tokenEstimate = tok(markdown);

  const capsule: ContextCapsule = {
    task,
    budget,
    model,
    freshness: opts.freshness,
    items,
    related_symbols: [...relatedSymbols],
    related_tests: [...relatedTests],
    possible_impact: possibleImpact,
    memory_notes: memoryNotes,
    token_estimate: tokenEstimate,
    tokenizer_used: tokenizerUsed,
  };
  return { capsule, markdown };
}

function freshnessLine(f: Freshness): string {
  const commit = f.index_commit ? f.index_commit.slice(0, 7) : 'uncommitted';
  const state = f.dirty ? 'working tree DIRTY' : 'clean';
  return `index @ ${commit}, ${state}, ${f.changed_since_index} files changed since index`;
}

function renderMarkdown(x: {
  task: string;
  freshness: Freshness;
  items: CapsuleItem[];
  relatedSymbols: string[];
  relatedTests: string[];
  possibleImpact: string[];
  memoryNotes: string[];
  model: string;
}): string {
  const out: string[] = [];
  out.push('# Context Capsule');
  out.push(`Task: ${x.task}`);
  out.push(`Freshness: ${freshnessLine(x.freshness)}`);
  out.push('');
  out.push('Relevant files (why):');
  x.items.forEach((it, i) => {
    out.push(`${i + 1}. ${it.path}  — ${it.reason} (score ${it.score?.toFixed(2)}, ${it.depth})`);
  });
  out.push('');
  for (const it of x.items) {
    out.push(`## ${it.path} (${it.depth})`);
    if (it.content) out.push(it.content);
    out.push('');
  }
  if (x.relatedSymbols.length) {
    out.push('Relevant symbols: ' + x.relatedSymbols.slice(0, 20).join(', '));
  }
  if (x.relatedTests.length) {
    out.push('Related tests: ' + x.relatedTests.join(', '));
  }
  if (x.possibleImpact.length) {
    out.push('Possible impact: ' + x.possibleImpact.slice(0, 8).join(', '));
  }
  if (x.memoryNotes.length) {
    out.push('Memory:');
    for (const m of x.memoryNotes) out.push(`  - ${m}`);
  }
  return out.join('\n');
}
