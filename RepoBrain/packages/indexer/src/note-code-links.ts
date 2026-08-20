/**
 * Note↔code edges (H2a). The staleness pass already extracted the code paths each note cites into
 * `related_files`; the generator records which file each card describes. Here we turn those into real
 * graph edges `memory --documents--> file`. The capsule then surfaces "the note(s) that document the
 * code I'm already including" directly — independent of lexical overlap. This closes the measured
 * misses (e.g. a Russian-titled note whose English code identifier is what ties it to the file).
 */

import type { GraphStore, NewEdge } from '@repobrain/graph-store';

/**
 * Resolve a note's PATH reference to a file id by suffix match. Path-only (from `related_files`):
 * measured that also linking bare filenames doubled the edge count and diluted the signal
 * (kora 11/12 → 10/12), so we keep the precise path anchors only.
 */
function resolveFileId(ref: string, exact: Map<string, number>, files: { path: string; id: number }[]): number | null {
  const hit = exact.get(ref);
  if (hit !== undefined) return hit;
  if (!ref.includes('/')) return null;
  for (const f of files) if (f.path.endsWith('/' + ref)) return f.id;
  return null;
}

export interface NoteCodeLinkResult {
  edges: number; // note→file edges written
  linkedNotes: number; // notes with ≥1 resolved code file
}

/**
 * Rebuild `memory --documents--> file` edges from every note's `related_files`. Idempotent: clears
 * prior memory-sourced edges first. Run after ingest + staleness + generation (so related_files are set).
 */
export function buildNoteCodeEdges(store: GraphStore, onProgress?: (msg: string) => void): NoteCodeLinkResult {
  const files = store.allFiles().map((f) => ({ path: f.path, id: f.id }));
  const exact = new Map<string, number>();
  for (const f of files) exact.set(f.path, f.id);

  store.deleteEdgesBySourceType('memory');

  const edges: NewEdge[] = [];
  let linkedNotes = 0;
  for (const m of store.allMemories()) {
    if (m.related_files.length === 0) continue;
    let linked = false;
    const seen = new Set<number>();
    for (const ref of m.related_files) {
      const fid = resolveFileId(ref, exact, files);
      if (fid === null || seen.has(fid)) continue;
      seen.add(fid);
      linked = true;
      edges.push({
        source_type: 'memory',
        source_id: m.id,
        target_type: 'file',
        target_id: fid,
        edge_type: 'documents',
        confidence: exact.has(ref) ? 1.0 : 0.8,
        resolution: exact.has(ref) ? 'exact' : 'heuristic',
        file_id: fid,
        line: null,
      });
    }
    if (linked) linkedNotes++;
  }
  store.insertEdges(edges);
  onProgress?.(`note↔code: ${edges.length} edges from ${linkedNotes} notes`);
  return { edges: edges.length, linkedNotes };
}
