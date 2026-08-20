import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { sectionWeight, titleBoost, searchKnowledgeRanked } from '../src/index.js';

const dbPath = join(tmpdir(), `rb-knowledge-rank-${process.pid}.sqlite`);

function addNote(store: GraphStore, title: string, body: string, path: string, section: string): void {
  store.insertMemory({
    type: 'second_brain',
    title,
    body,
    related_files: [],
    related_symbols: [],
    tags: [path, section],
    stale_status: 'fresh',
  });
}

describe('knowledge ranking (H3: section + title weighting)', () => {
  let store: GraphStore;

  beforeAll(() => {
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    store = GraphStore.open(dbPath);
    // Two notes that both match "llm router"; the history log should lose to the canonical project note.
    addNote(store, 'Session log 2026-05-25', 'fixed the llm router provider bug today', 'second-brain/05_история/log.md', '05_история');
    addNote(store, 'LlmRouter', 'central llm router dispatches provider completion calls', 'second-brain/01_projects/llm-router.md', '01_projects');
  });

  afterAll(() => {
    store?.close();
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  });

  it('sectionWeight ranks architecture/projects above history/marketing, language-agnostic', () => {
    expect(sectionWeight(['x', '02_architecture'])).toBeGreaterThan(sectionWeight(['x', '05_история']));
    expect(sectionWeight(['x', '01_projects'])).toBeGreaterThan(sectionWeight(['x', '06_marketing']));
    expect(sectionWeight(['x', '00_system'])).toBeLessThan(1); // meta protocols demoted
  });

  it('titleBoost rewards query/title overlap and subtokenizes glued names', () => {
    // "LlmRouter" subtokenizes to "llm router" → overlaps the query
    expect(titleBoost('LlmRouter', 'llm router provider')).toBeGreaterThan(1);
    expect(titleBoost('Unrelated heading', 'llm router provider')).toBe(1);
  });

  it('promotes the canonical project note above a history log that shares words', () => {
    const ranked = searchKnowledgeRanked(store, 'llm router provider completion', 5);
    expect(ranked[0]!.title).toBe('LlmRouter');
    expect(ranked[0]!.tags[0]).toContain('01_projects/llm-router.md');
  });
});
