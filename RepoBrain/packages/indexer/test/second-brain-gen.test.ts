import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { generateBrainCards, ingestGeneratedBrain } from '../src/index.js';

const dbPath = join(tmpdir(), `rb-brain-gen-${process.pid}.sqlite`);

function addFile(store: GraphStore, path: string): number {
  return store.upsertFile({
    path,
    language: 'typescript',
    hash: path,
    size_bytes: 100,
    lines_count: 10,
    last_modified: 1,
    parse_status: 'ok',
    is_test: false,
    is_generated: false,
    has_secrets: false,
    package_id: null,
    git_last_commit: null,
    git_last_date: null,
    git_churn: 0,
  });
}

describe('code-grounded brain generator', () => {
  let store: GraphStore;

  beforeAll(() => {
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    store = GraphStore.open(dbPath);
    const svc = addFile(store, 'src/modules/llm/llm-router.service.ts');
    const ctrl = addFile(store, 'src/modules/llm/llm.controller.ts');
    store.replaceFileSymbols(svc, [
      { file_id: svc, name: 'LlmRouter', qualified_name: 'LlmRouter', kind: 'class', signature: 'class LlmRouter', docstring: null, start_line: 1, end_line: 20, visibility: 'public', exported: true, hash: 'a' },
      { file_id: svc, name: 'routeCompletion', qualified_name: 'LlmRouter.routeCompletion', kind: 'method', signature: 'routeCompletion(task): Provider', docstring: null, start_line: 5, end_line: 10, visibility: 'public', exported: false, hash: 'b' },
    ]);
    store.replaceFileSymbols(ctrl, [
      { file_id: ctrl, name: 'LlmController', qualified_name: 'LlmController', kind: 'class', signature: 'class LlmController', docstring: null, start_line: 1, end_line: 10, visibility: 'public', exported: true, hash: 'c' },
    ]);
    // controller imports the service → service is "used by" controller
    store.insertEdges([
      { source_type: 'file', source_id: ctrl, target_type: 'file', target_id: svc, edge_type: 'imports', confidence: 1, resolution: 'exact', file_id: ctrl, line: 1 },
    ]);
  });

  afterAll(() => {
    store?.close();
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  });

  it('emits a module-map card plus per-file cards, grounded in the graph', () => {
    const cards = generateBrainCards(store, { level: 'L1' });
    expect(cards[0]!.title).toBe('Module map');
    const svcCard = cards.find((c) => c.title === 'llm router service');
    expect(svcCard).toBeTruthy();
    expect(svcCard!.body).toContain('Path: `src/modules/llm/llm-router.service.ts`');
    expect(svcCard!.body).toContain('Purpose: service'); // grounded role from naming
    expect(svcCard!.body).toContain('LlmRouter'); // exported symbol
    expect(svcCard!.body).toContain('Used by:'); // importer edge
  });

  it('L2 adds signatures; L0 omits the purpose line', () => {
    const l2 = generateBrainCards(store, { level: 'L2' }).find((c) => c.title === 'llm router service')!;
    expect(l2.body).toContain('Signatures:');
    const l0 = generateBrainCards(store, { level: 'L0' }).find((c) => c.title === 'llm router service')!;
    expect(l0.body).not.toContain('Purpose:');
  });

  it('cards are findable by natural words via the subtokenized Terms line', () => {
    ingestGeneratedBrain(store, { level: 'L1' });
    expect(store.countMemoriesByType('generated_brain')).toBeGreaterThan(0);
    // "llm router" are subtokens of the glued identifier LlmRouter / the filename
    const hits = store.searchMemoriesFts('llm router completion', 5);
    expect(hits.some((h) => h.item.title === 'llm router service')).toBe(true);
  });

  it('re-generation is idempotent (refresh, not duplicate)', () => {
    ingestGeneratedBrain(store, { level: 'L1' });
    const n = store.countMemoriesByType('generated_brain');
    ingestGeneratedBrain(store, { level: 'L1' });
    expect(store.countMemoriesByType('generated_brain')).toBe(n);
  });
});
