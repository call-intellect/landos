import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { DEFAULT_WEIGHTS } from '@repobrain/shared';
import { rankForTask } from '../src/rank.js';

const dbPath = join(tmpdir(), `rb-note-bridge-${process.pid}.sqlite`);

const RUSSIAN_TASK = 'оплата практикума и выдача доступа ученику';
const DOCUMENTED = 'src/lib/payments/webhook-handler.ts';
const UNDOCUMENTED = 'src/lib/rendering/svg-sprite.ts';

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

function addSymbol(store: GraphStore, fileId: number, name: string): void {
  store.replaceFileSymbols(fileId, [
    {
      file_id: fileId,
      name,
      qualified_name: name,
      kind: 'function',
      signature: `export function ${name}(): void`,
      docstring: null,
      start_line: 1,
      end_line: 5,
      visibility: 'public',
      exported: true,
      hash: name,
    },
  ]);
}

describe('мост «заметка второго мозга → код»', () => {
  let store: GraphStore;
  let documentedFileId: number;

  beforeAll(() => {
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    store = GraphStore.open(dbPath);

    documentedFileId = addFile(store, DOCUMENTED);
    addSymbol(store, documentedFileId, 'handlePaymentWebhook');

    const otherId = addFile(store, UNDOCUMENTED);
    addSymbol(store, otherId, 'renderSvgSprite');

    const noteId = store.insertMemory({
      type: 'second_brain',
      title: 'Покупка продукта — от лендинга до доступа и welcome-письма',
      body: 'Оплата практикума, выдача доступа ученику и письмо после покупки.',
      related_files: [DOCUMENTED],
      related_symbols: [],
      tags: [],
      stale_status: 'fresh',
    });

    store.insertEdges([
      {
        source_type: 'memory',
        source_id: noteId,
        target_type: 'file',
        target_id: documentedFileId,
        edge_type: 'documents',
        confidence: 1.0,
        resolution: 'exact',
        file_id: documentedFileId,
        line: null,
      },
    ]);
  });

  afterAll(() => {
    store?.close();
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  });

  it('русский запрос выводит описанный заметкой файл в топ', async () => {
    const ranked = await rankForTask(store, null, RUSSIAN_TASK);
    expect(ranked[0]?.file.path).toBe(DOCUMENTED);
  });

  it('объясняет, почему файл попал в выжимку', async () => {
    const ranked = await rankForTask(store, null, RUSSIAN_TASK);
    expect(ranked[0]?.reasons).toContain('описан заметкой второго мозга');
  });

  it('вклад виден отдельной строкой разбора', async () => {
    const ranked = await rankForTask(store, null, RUSSIAN_TASK);
    expect(ranked[0]?.breakdown.note).toBeGreaterThan(0);
  });

  it('при w_note = 0 файл не поднимается — тянет именно мост, а не совпадение', async () => {
    const ranked = await rankForTask(store, null, RUSSIAN_TASK, {
      weights: { ...DEFAULT_WEIGHTS, w_note: 0 },
    });
    const documented = ranked.find((r) => r.file.path === DOCUMENTED);
    expect(documented?.breakdown.note).toBe(0);
  });

  it('файл без заметки сигнала не получает', async () => {
    const ranked = await rankForTask(store, null, RUSSIAN_TASK);
    const other = ranked.find((r) => r.file.path === UNDOCUMENTED);
    expect(other?.breakdown.note ?? 0).toBe(0);
  });

  it('noteLimit = 0 отключает мост целиком', async () => {
    const ranked = await rankForTask(store, null, RUSSIAN_TASK, { noteLimit: 0 });
    const documented = ranked.find((r) => r.file.path === DOCUMENTED);
    expect(documented?.breakdown.note ?? 0).toBe(0);
  });
});
