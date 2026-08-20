/**
 * Second-brain ingestion — the "double search" WHY/HOW channel.
 *
 * RepoBrain's graph answers WHERE/WHAT from code. A repo's second-brain folder
 * (a curated markdown knowledge base: architecture notes, pitfalls, module maps)
 * answers WHY/HOW. This reads that folder and stores each note in the `memories`
 * table so the capsule builder — which already merges `searchMemoriesFts(task)` —
 * returns code AND its rationale in one shot. No embeddings, deterministic FTS.
 *
 * Notes are stored with type `second_brain` so re-index can refresh only this
 * batch (delete + re-insert) without disturbing team decisions.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, extname, sep } from 'node:path';
import type { GraphStore } from '@repobrain/graph-store';

export interface IngestSecondBrainOptions {
  /** Folder to ingest. Absolute, or relative to `root`. Default: auto-detect `<root>/second-brain`. */
  dir?: string;
  /** Skip notes whose body (after frontmatter) is shorter than this many chars. Default 0. */
  minBodyChars?: number;
  onProgress?: (msg: string) => void;
}

export interface IngestSecondBrainResult {
  dir: string; // absolute folder actually ingested
  notes: number; // notes inserted
  skipped: number; // files skipped (empty/too small)
}

/** Default folder names to probe under the repo root, in order. */
const DEFAULT_DIRS = ['second-brain', 'second-brain-kit/second-brain', '.second-brain'];

/** Resolve the folder to ingest, or null if none exists. */
export function resolveSecondBrainDir(root: string, dir?: string): string | null {
  if (dir) {
    const abs = dir.startsWith(sep) ? dir : join(root, dir);
    return existsSync(abs) ? abs : null;
  }
  for (const d of DEFAULT_DIRS) {
    const abs = join(root, d);
    if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
  }
  return null;
}

/**
 * Ingest the second-brain folder into `memories`. Returns null when no folder is
 * found (the common case for repos without a knowledge base — a no-op, not an error).
 */
export function ingestSecondBrain(
  store: GraphStore,
  root: string,
  opts: IngestSecondBrainOptions = {},
): IngestSecondBrainResult | null {
  const log = opts.onProgress ?? (() => {});
  const dir = resolveSecondBrainDir(root, opts.dir);
  if (!dir) return null;

  const minBody = opts.minBodyChars ?? 0;
  const files = collectMarkdown(dir);

  // Idempotent refresh: drop the previous ingested batch, re-insert the current folder.
  const removed = store.deleteMemoriesByType('second_brain');
  if (removed) log(`second-brain: cleared ${removed} stale notes`);

  let notes = 0;
  let skipped = 0;
  store.transaction(() => {
    for (const abs of files) {
      let raw: string;
      try {
        raw = readFileSync(abs, 'utf8');
      } catch {
        skipped++;
        continue;
      }
      const { body } = stripFrontmatter(raw);
      if (body.trim().length < minBody) {
        skipped++;
        continue;
      }
      const rel = relative(root, abs);
      const relFromBrain = relative(dir, abs);
      const section = relFromBrain.split(sep)[0] ?? '';
      const title = extractTitle(raw, abs);
      store.insertMemory({
        type: 'second_brain',
        title,
        body,
        related_files: [], // populated later by staleness step (code files this note is about)
        related_symbols: [],
        // tags[0] is the source note path — the capsule cites it so the agent can open the full note.
        tags: [rel, section].filter(Boolean),
        stale_status: 'fresh',
      });
      notes++;
    }
  });

  log(`second-brain: ingested ${notes} notes from ${relative(root, dir) || dir}`);
  return { dir, notes, skipped };
}

/** Recursively collect `.md` / `.markdown` files under `dir`, sorted for determinism. */
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue; // skip dotfiles/dirs
      const abs = join(d, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
      } else if (/\.(md|markdown)$/i.test(name)) {
        out.push(abs);
      }
    }
  };
  walk(dir);
  return out;
}

/** Strip a leading YAML frontmatter block (`---\n…\n---`). Returns body + raw frontmatter text. */
export function stripFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith('---')) return { frontmatter: '', body: raw };
  // match the first line that is exactly `---`, then the next such line
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: '', body: raw };
  return { frontmatter: m[1] ?? '', body: raw.slice(m[0].length) };
}

/** Title = first markdown H1, else frontmatter `title:`, else the filename. */
function extractTitle(raw: string, abs: string): string {
  const { frontmatter, body } = stripFrontmatter(raw);
  const h1 = body.match(/^#\s+(.+?)\s*$/m);
  if (h1?.[1]) return h1[1].trim().slice(0, 120);
  const fmTitle = frontmatter.match(/^title:\s*(.+?)\s*$/m);
  if (fmTitle?.[1]) return fmTitle[1].replace(/^["']|["']$/g, '').trim().slice(0, 120);
  return basename(abs, extname(abs));
}
