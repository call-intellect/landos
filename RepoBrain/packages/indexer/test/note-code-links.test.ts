import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { buildNoteCodeEdges } from '../src/index.js';

const dbPath = join(tmpdir(), `rb-note-links-${process.pid}.sqlite`);

function addFile(store: GraphStore, path: string): number {
  return store.upsertFile({
    path, language: 'typescript', hash: path, size_bytes: 1, lines_count: 1, last_modified: 1,
    parse_status: 'ok', is_test: false, is_generated: false, has_secrets: false, package_id: null,
    git_last_commit: null, git_last_date: null, git_churn: 0,
  });
}

describe('note↔code edges (H2a)', () => {
  let store: GraphStore;
  let fileId: number;
  let noteId: number;

  beforeAll(() => {
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    store = GraphStore.open(dbPath);
    fileId = addFile(store, 'src/modules/auth/jwt.service.ts');
    addFile(store, 'src/other/unrelated.ts');
    noteId = store.insertMemory({
      type: 'second_brain', title: 'Auth', body: 'JWT signing lives in the auth service.',
      related_files: ['auth/jwt.service.ts', 'nonexistent/gone.ts'], related_symbols: [],
      tags: ['second-brain/01_projects/auth.md', '01_projects'], stale_status: 'fresh',
    });
  });

  afterAll(() => {
    store?.close();
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  });

  it('links a note to the file it references (partial path suffix match), skipping dead refs', () => {
    const res = buildNoteCodeEdges(store);
    expect(res.edges).toBe(1); // only the live ref resolves
    expect(res.linkedNotes).toBe(1);
    const edges = store.edgesTo('file', fileId).filter((e) => e.edge_type === 'documents');
    expect(edges.length).toBe(1);
    expect(edges[0]!.source_type).toBe('memory');
    expect(edges[0]!.source_id).toBe(noteId);
  });

  it('is idempotent — rebuilds without duplicating', () => {
    buildNoteCodeEdges(store);
    buildNoteCodeEdges(store);
    expect(store.edgesTo('file', fileId).filter((e) => e.edge_type === 'documents').length).toBe(1);
  });
});
