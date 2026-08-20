import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { ingestAgentMemory, isAgentMemoryFile, resolveAgentMemoryDir } from '../src/index.js';

const root = join(tmpdir(), `rb-am-test-${process.pid}`);
const memory = join(root, 'memory');
const dbPath = join(root, 'graph.sqlite');

describe('agent memory ingestion (memory/*.md → agent_memory)', () => {
  let store: GraphStore;

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(memory, { recursive: true });
    writeFileSync(
      join(memory, 'project_prod-server.md'),
      `---\nname: prod-server\ndescription: где прод\nmetadata:\n  type: project\n---\n\nПрод живёт на выделенной машине, соседнюю не трогать.\n\n**How to apply:** сверяйся с src/lib/deploy-target.ts перед выкатом.\n`,
    );
    writeFileSync(
      join(memory, 'feedback_russian-only.md'),
      `---\nname: russian-only\nmetadata:\n  type: feedback\n---\n\n# Пиши только по-русски\n\nВесь текст владельцу — по-русски.\n`,
    );
    writeFileSync(join(memory, 'MEMORY.md'), `- [Прод](project_prod-server.md) — где прод.\n`);
    writeFileSync(join(memory, 'README.md'), `Слой памяти агента.\n`);
    writeFileSync(join(memory, 'user_example.md'), `---\nname: example\n---\nОбразец формата.\n`);
    writeFileSync(join(memory, 'project_example.md'), `---\nname: example\n---\nОбразец формата.\n`);
    store = GraphStore.open(dbPath);
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('auto-detects the memory folder under the repo root', () => {
    expect(resolveAgentMemoryDir(root)).toBe(memory);
    expect(resolveAgentMemoryDir(join(tmpdir(), 'nope-xyz'))).toBeNull();
  });

  it('treats the kit skeleton as not a record', () => {
    expect(isAgentMemoryFile('MEMORY.md')).toBe(false);
    expect(isAgentMemoryFile('README.md')).toBe(false);
    expect(isAgentMemoryFile('user_example.md')).toBe(false);
    expect(isAgentMemoryFile('project_prod-server.md')).toBe(true);
    expect(isAgentMemoryFile('notes.txt')).toBe(false);
  });

  it('ingests exactly the real records, skipping the skeleton', () => {
    const result = ingestAgentMemory(store, root);
    expect(result?.notes).toBe(2);
    const rows = store.db
      .prepare("select title, tags from memories where type = 'agent_memory' order by title")
      .all() as Array<{ title: string; tags: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.title)).toEqual(['prod-server', 'russian-only']);
    expect(JSON.parse(rows[0]!.tags)).toContain('memory/project_prod-server.md');
    expect(JSON.parse(rows[0]!.tags)).toContain('project');
  });

  it('is idempotent: a second pass keeps the same count', () => {
    ingestAgentMemory(store, root);
    const [{ c }] = store.db
      .prepare("select count(*) c from memories where type = 'agent_memory'")
      .all() as Array<{ c: number }>;
    expect(c).toBe(2);
  });

  it('links a record to the code path it names', () => {
    const [row] = store.db
      .prepare("select related_files from memories where type = 'agent_memory' and title = 'prod-server'")
      .all() as Array<{ related_files: string }>;
    expect(JSON.parse(row!.related_files)).toContain('src/lib/deploy-target.ts');
  });

  it('returns null when the folder does not exist', () => {
    expect(ingestAgentMemory(store, join(tmpdir(), 'rb-am-missing-xyz'))).toBeNull();
  });
});
