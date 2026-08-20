/**
 * Staleness detection — drift is the enemy (see docs/DECISIONS.md).
 *
 * A hand-written note claims things about specific code. When that code is deleted or renamed, the
 * note's claim is provably wrong — a **dead code reference**. This is an unambiguous, date-free drift
 * signal we can act on immediately: parse the code paths a note cites, resolve them against the current
 * graph, and flag the note `stale` if any cited code no longer exists. The capsule then warns the agent
 * instead of feeding it outdated WHY.
 *
 * (Generated cards are rebuilt from code on every index, so they can't drift — they are skipped here.)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphStore } from '@repobrain/graph-store';

// Only extensions RepoBrain actually indexes — a ref to schema.prisma / *.json isn't in the graph and
// must NOT be treated as "dead" just because we don't track it. Longest-first + a lookahead so `.tsx`
// isn't truncated to `.ts` and `.json` isn't truncated to `.js` (both were false-positive sources).
const CODE_EXT = 'tsx|ts|jsx|mjs|cjs|js|py';
// A ref must START with an alnum (so leading `../`, `-` are excluded) and END the extension at a
// token boundary. This drops prose fragments like `.controller.ts` / `-extraction.service.ts`.
// The one exception is a dot-directory (`.claude/hooks/x.mjs`, `.husky/pre-commit.js`): a leading dot
// is allowed only when it is followed by an alnum AND that first segment ends in `/`, so prose
// fragments — which have no slash — stay excluded. Without it the dot was silently eaten and the
// surviving `claude/hooks/x.mjs` never existed on disk: a false "stale" on every note citing `.claude/**`.
const REF_RE = new RegExp(
  `((?:\\.[A-Za-z0-9][A-Za-z0-9_@\\-]*\\/)?[A-Za-z0-9_@][A-Za-z0-9_@.\\-/]*\\.(?:${CODE_EXT}))(?![A-Za-z0-9])`,
  'g',
);
// Nested repositories: a note may cite a path written from the submodule's own root.
const SUBMODULE_ROOTS = ['RepoBrain'];
// Framework filenames that look like code refs but are prose ("built with Next.js").
const DENY = new Set(['next.js', 'node.js', 'nest.js', 'vue.js', 'three.js', 'express.js', 'react.js', 'nuxt.js']);

/** Pull distinct code file references (paths or filenames) out of a note body. */
export function extractCodeRefs(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(REF_RE)) {
    const ref = m[1]!;
    const base = ref.split('/').pop() ?? ref;
    // filename must start with a letter/digit (rejects `.dto.ts`, `-foo.ts` fragments)
    if (!/^[A-Za-z0-9]/.test(base) || ref.length < 5 || DENY.has(ref.toLowerCase())) continue;
    out.add(ref);
  }
  return [...out];
}

/**
 * Staleness only considers PATH references (containing `/`) — a specific path that vanished is
 * unambiguous drift. Bare filenames (`worker.ts`) are too ambiguous (shared basenames, prose
 * patterns like `*.worker.ts`) to flag honestly, so `checkableRef` rejects them.
 */
export function checkableRef(ref: string): boolean {
  return ref.includes('/');
}

/**
 * Is a path reference alive? The graph is checked first (by path suffix, so partial paths resolve),
 * then the disk under `root`. The graph only covers what we index — build output, vendored dirs and
 * anything gitignored are absent from it BY DESIGN, so index membership cannot be the source of truth
 * for "this file is gone". A note citing `apps/cli/dist/cli.js` documents a real path a hook invokes;
 * flagging it dead because `dist/` is gitignored is a false alarm, and an alarm that always lies
 * teaches the reader to ignore alarms. Without `root` the disk check is skipped (graph-only).
 */
export function refIsAlive(ref: string, paths: string[], root?: string): boolean {
  if (paths.some((p) => p === ref || p.endsWith('/' + ref))) return true;
  if (!root) return false;
  if (existsSync(join(root, ref))) return true;
  return SUBMODULE_ROOTS.some((sub) => existsSync(join(root, sub, ref)));
}

/**
 * Is this reference even about our repository? Notes quote paths from OTHER projects as examples
 * (`src/app/api/checkout/route.ts` of a client app, `apps/web/app/page.tsx` of a benchmark target).
 * Checking those against our disk is meaningless: they were never here, so "gone" says nothing. The
 * cheap, honest test is the TOP directory in the MAIN repo only — submodule roots are deliberately
 * NOT consulted here, or generic names they contain (`apps`, `packages`, `docs`) would claim every
 * foreign path under those names as ours. Aliveness is resolved before this call, so a path that
 * really is the submodule's is already accounted for. Without `root` we cannot judge, so the graph
 * decides as before.
 *
 * Known blind spot, accepted: renaming a top-level directory makes every ref under the old name
 * "not ours" instead of dead. That is why the skipped count is reported and not swallowed.
 */
export function isOurRepoRef(ref: string, root?: string): boolean {
  if (!root) return true;
  const top = ref.split('/')[0];
  if (!top) return true;
  return existsSync(join(root, top));
}

export interface StalenessResult {
  checked: number; // notes that cite ≥1 code ref
  stale: number; // notes flagged stale (≥1 dead ref)
  deadRefs: number; // total dead references across all notes
  foreignRefs: number; // refs skipped: their top directory is not ours to judge
}

/**
 * Flag hand-written (`second_brain`) notes whose cited code no longer exists. Stores the extracted
 * refs in `related_files` (also the seed for note↔code edges, H2a) and sets `stale_status`.
 */
export function checkStaleness(store: GraphStore, onProgress?: (msg: string) => void, root?: string): StalenessResult {
  const paths = store.allFiles().map((f) => f.path);
  let checked = 0;
  let stale = 0;
  let deadRefs = 0;
  let foreignRefs = 0;

  store.transaction(() => {
    for (const m of store.allMemories()) {
      if (m.type !== 'second_brain') continue; // generated cards are rebuilt each index; agent notes n/a
      const isProtocol = (m.tags[1] ?? '').startsWith('00_'); // protocols carry EXAMPLE paths, not real refs
      const refs = isProtocol ? [] : extractCodeRefs(m.body).filter(checkableRef);
      if (refs.length === 0) {
        store.updateMemoryMeta(m.id, { stale_status: 'fresh' }); // reset any prior flag
        continue;
      }
      checked++;
      const dead: string[] = [];
      for (const ref of refs) {
        if (refIsAlive(ref, paths, root)) continue;
        if (!isOurRepoRef(ref, root)) {
          foreignRefs++;
          continue;
        }
        dead.push(ref);
      }
      deadRefs += dead.length;
      if (dead.length > 0) stale++;
      store.updateMemoryMeta(m.id, { stale_status: dead.length > 0 ? 'stale' : 'fresh', related_files: refs });
    }
  });

  onProgress?.(
    `staleness: ${stale}/${checked} notes flagged stale (${deadRefs} dead code refs, ${foreignRefs} refs skipped as not ours)`,
  );
  return { checked, stale, deadRefs, foreignRefs };
}
