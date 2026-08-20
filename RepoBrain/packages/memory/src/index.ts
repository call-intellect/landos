import { subtokenize } from '@repobrain/graph-store';
import type { GraphStore } from '@repobrain/graph-store';
import type { MemoryRecord, MemoryType } from '@repobrain/shared';

export interface RememberInput {
  note: string;
  type?: MemoryType;
  title?: string;
  related_files?: string[];
  related_symbols?: string[];
  tags?: string[];
}

/** Write a team-memory note (spec §11). Returns the new memory id. */
export function rememberDecision(store: GraphStore, input: RememberInput): number {
  const title = input.title ?? firstLine(input.note).slice(0, 80);
  return store.insertMemory({
    type: input.type ?? 'agent_note',
    title,
    body: input.note,
    related_files: input.related_files ?? [],
    related_symbols: input.related_symbols ?? [],
    tags: input.tags ?? [],
    stale_status: 'fresh',
  });
}

/** Search team memory (FTS over title/body/tags). */
export function searchMemory(store: GraphStore, query: string, limit = 10): MemoryRecord[] {
  return store.searchMemoriesFts(query, limit).map((h) => h.item);
}

/**
 * Section weight for an ingested second-brain note (H3). The kora baseline showed the
 * *correct* architecture/project notes buried (rank 7–23) under `05_история` session logs
 * that share words with the query. We up-weight canonical knowledge and down-weight noisy
 * time-stamped history. Matched by the leading folder number in `tags[1]` so it is language-
 * agnostic (kora uses Cyrillic folder names like `05_история`, `04_не-сделано`).
 */
export function sectionWeight(tags: string[]): number {
  const section = tags[1] ?? '';
  const num = (section.match(/^(\d{2})/) ?? [])[1];
  switch (num) {
    case '02': return 1.5; // architecture (ADRs, module-map, data-model, pitfalls, security)
    case '01': return 1.4; // projects/features
    case '03': return 1.3; // processes (cross-cutting flows)
    case '13': return 1.1; // glossary
    case '04': return 1.0; // not-done
    case '00': return 0.7; // system protocols (meta — how to write the brain, rarely the answer)
    case '05': return 0.6; // history/session logs (noisy, time-stamped)
    case '06': return 1.1; // marketing/positioning (curated product reference)
    default: return 1.0;
  }
}

function tokenSet(s: string): Set<string> {
  return new Set(subtokenize(s).split(' ').filter((w) => w.length >= 3));
}

/**
 * Title-overlap boost (H3): a note whose TITLE matches the query terms is more likely the
 * canonical note for the topic (`llm-router.md` titled "LlmRouter" for an llm-router query).
 * General signal, not a per-query hack. Titles are subtokenized so glued names like
 * `LlmRouter` split to `llm router`. Returns a multiplier in [1, 2].
 */
export function titleBoost(title: string, query: string): number {
  const q = tokenSet(query);
  if (q.size === 0) return 1;
  const t = tokenSet(title);
  let overlap = 0;
  for (const w of q) if (t.has(w)) overlap++;
  return 1 + overlap / q.size;
}

/**
 * Rank knowledge notes for a task: FTS candidates re-weighted by section + title overlap (H3).
 * Returns MemoryRecord[] best-first. Rank-based relevance (not raw bm25) keeps the factors
 * meaningful without bm25 normalization quirks. Non-second_brain memories weight 1.0.
 */
/** Knowledge notes = code-grounded layers that carry a section tag and cite a source path. */
export function isKnowledgeNote(type: string): boolean {
  return type === 'second_brain' || type === 'generated_brain';
}

export interface ScoredNote {
  item: MemoryRecord;
  score: number;
}

/** Section+title-weighted knowledge ranking WITH scores, so callers (the capsule) can blend in other
 *  signals — e.g. the H2a note↔code edge bonus — instead of concatenating separate ordered lists. */
export function rankKnowledgeScored(store: GraphStore, query: string, poolSize = 30): ScoredNote[] {
  const hits = store.searchMemoriesFts(query, poolSize);
  const scored = hits.map((h, i) => {
    const know = isKnowledgeNote(h.item.type);
    const sec = know ? sectionWeight(h.item.tags) : 1.0;
    const title = know ? titleBoost(h.item.title, query) : 1.0;
    // FTS relevance by position (best hit = poolSize), scaled by section + title factors
    return { item: h.item, score: (hits.length - i) * sec * title };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function searchKnowledgeRanked(store: GraphStore, query: string, limit = 8, poolSize = 30): MemoryRecord[] {
  return rankKnowledgeScored(store, query, poolSize).slice(0, limit).map((s) => s.item);
}

export interface MemoryWarning {
  memory?: MemoryRecord;
  warning: string;
}

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

/**
 * Code graph FTS is lexical over english identifiers (D18: the RU→EN embedding bridge is off by
 * default). A russian query is no longer a dead end — the note→code bridge pulls the files a
 * second-brain note documents — but english identifiers still rank measurably better, so nudge
 * without claiming the code is unreachable. Suppressed when the query already carries a latin
 * identifier — mixed queries land fine and the reminder would be noise.
 */
export function codeQueryLanguageWarning(task: string): MemoryWarning | null {
  if (!CYRILLIC.test(task) || LATIN_WORD.test(task)) return null;
  return {
    warning:
      'Запрос к коду задан по-русски — по-русски находится второй мозг и код, описанный его ' +
      'заметками. Английские имена кода (напр. createLead, LeadInput, store page) дадут точнее: ' +
      'если нужного не видно, перезапроси make_context_capsule ими.',
  };
}

/**
 * Pre-action warnings (spec §11): surface `failed_attempt` / `known_issue` notes that match
 * the task, so an agent is warned before repeating a known mistake.
 */
export function preActionWarnings(store: GraphStore, task: string, limit = 5): MemoryWarning[] {
  const hits = store.searchMemoriesFts(task, limit * 3).map((h) => h.item);
  const warnings: MemoryWarning[] = [];
  for (const m of hits) {
    if (m.type === 'failed_attempt' || m.type === 'known_issue') {
      const label = m.type === 'failed_attempt' ? 'Previously failed' : 'Known issue';
      warnings.push({ memory: m, warning: `${label}: ${m.title}` });
    }
    if (warnings.length >= limit) break;
  }
  return warnings;
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}
