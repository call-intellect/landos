import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { checkStaleness, extractCodeRefs, checkableRef, isOurRepoRef } from '../src/index.js';

const dbPath = join(tmpdir(), `rb-staleness-${process.pid}.sqlite`);

function addFile(store: GraphStore, path: string): void {
  store.upsertFile({
    path, language: 'typescript', hash: path, size_bytes: 1, lines_count: 1, last_modified: 1,
    parse_status: 'ok', is_test: false, is_generated: false, has_secrets: false, package_id: null,
    git_last_commit: null, git_last_date: null, git_churn: 0,
  });
}
function addNote(store: GraphStore, path: string, body: string): number {
  return store.insertMemory({
    type: 'second_brain', title: path, body, related_files: [], related_symbols: [],
    tags: [`second-brain/${path}`, path.split('/')[0] ?? ''], stale_status: 'fresh',
  });
}

describe('staleness (dead code reference detection)', () => {
  let store: GraphStore;
  let ids: Record<string, number>;

  beforeAll(() => {
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    store = GraphStore.open(dbPath);
    addFile(store, 'src/a/foo.service.ts');
    ids = {
      alive: addNote(store, '01_projects/alive.md', 'Uses `src/a/foo.service.ts` for X.'),
      dead: addNote(store, '01_projects/dead.md', 'Handler in `src/a/gone.service.ts`.'),
      bare: addNote(store, '01_projects/bare.md', 'See foo.service.ts somewhere.'),
      protocol: addNote(store, '00_system/PROTO.md', 'Example: `src/module/file.ts:42`.'),
    };
    checkStaleness(store);
  });

  afterAll(() => {
    store?.close();
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  });

  const statusOf = (id: number) => store.allMemories().find((m) => m.id === id)!.stale_status;

  it('extractCodeRefs does not truncate longer extensions (page.tsx, config.json)', () => {
    const refs = extractCodeRefs('built `page.tsx` with config.json and app.py');
    expect(refs).toContain('page.tsx');
    expect(refs).toContain('app.py');
    expect(refs).not.toContain('page.ts'); // not a truncation of .tsx
    expect(refs.some((r) => r.startsWith('config'))).toBe(false); // .json is not an indexed ext
  });

  it('only path refs are checkable (bare filenames are too ambiguous)', () => {
    expect(checkableRef('src/a/foo.service.ts')).toBe(true);
    expect(checkableRef('foo.service.ts')).toBe(false);
  });

  it('flags a note citing a path that no longer exists', () => {
    expect(statusOf(ids.dead)).toBe('stale');
  });

  it('keeps a note fresh when its cited path still exists', () => {
    expect(statusOf(ids.alive)).toBe('fresh');
  });

  it('ignores bare filenames and 00_system protocol example paths', () => {
    expect(statusOf(ids.bare)).toBe('fresh');
    expect(statusOf(ids.protocol)).toBe('fresh');
  });
});

describe('staleness against a repo root (the disk decides what is gone)', () => {
  const root = join(tmpdir(), `rb-staleness-root-${process.pid}`);
  const rootDb = join(root, 'graph.sqlite');
  let store: GraphStore;
  let ids: Record<string, number>;

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    // On disk but never indexed — exactly what gitignored build output looks like to the graph.
    writeFileSync(join(root, 'dist', 'cli.js'), 'console.log(1)\n', 'utf8');
    store = GraphStore.open(rootDb);
    addFile(store, 'src/a/foo.service.ts');
    ids = {
      unindexed: addNote(store, '03_processes/hook.md', 'The hook invokes `dist/cli.js` when built.'),
      gone: addNote(store, '03_processes/gone.md', 'The hook invokes `dist/vanished.js` when built.'),
    };
    checkStaleness(store, undefined, root);
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const statusOf = (id: number) => store.allMemories().find((m) => m.id === id)!.stale_status;

  it('keeps a note fresh when the cited file exists on disk but is not in the graph', () => {
    expect(statusOf(ids.unindexed)).toBe('fresh');
  });

  it('still flags a note whose cited file is absent from both the graph and the disk', () => {
    expect(statusOf(ids.gone)).toBe('stale');
  });
});

describe('staleness stops lying: dot-directories, submodules and foreign paths', () => {
  const root = join(tmpdir(), `rb-staleness-honest-${process.pid}`);
  const rootDb = join(root, 'graph.sqlite');
  let store: GraphStore;
  let ids: Record<string, number>;

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, '.claude', 'updater'), { recursive: true });
    writeFileSync(join(root, '.claude', 'updater', 'update.mjs'), 'export {}\n', 'utf8');
    mkdirSync(join(root, 'eval', 'lib'), { recursive: true });
    writeFileSync(join(root, 'eval', 'lib', 'run.mjs'), 'export {}\n', 'utf8');
    mkdirSync(join(root, 'RepoBrain', 'packages', 'indexer', 'src'), { recursive: true });
    writeFileSync(join(root, 'RepoBrain', 'packages', 'indexer', 'src', 'staleness.ts'), 'export {}\n', 'utf8');
    store = GraphStore.open(rootDb);
    ids = {
      dotDir: addNote(store, '01_projects/updater.md', 'The updater lives in `.claude/updater/update.mjs`.'),
      gone: addNote(store, '01_projects/gone.md', 'Measured by `eval/lib/net-takogo-fayla.mjs` every run.'),
      submodule: addNote(store, '02_architecture/rb.md', 'Detector sits in `packages/indexer/src/staleness.ts`.'),
      foreign: addNote(store, '05_history/client.md', 'Client app routes checkout in `src/app/api/checkout/route.ts`.'),
      prose: addNote(store, '05_history/prose.md', 'The target is built with Next.js and Node.js.'),
    };
    checkStaleness(store, undefined, root);
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const statusOf = (id: number) => store.allMemories().find((m) => m.id === id)!.stale_status;

  it('keeps the leading dot of a dot-directory ref', () => {
    expect(extractCodeRefs('see `.claude/updater/update.mjs` now')).toContain('.claude/updater/update.mjs');
    expect(statusOf(ids.dotDir)).toBe('fresh');
  });

  it('does not turn a prose fragment into a ref just because a dot is allowed', () => {
    expect(extractCodeRefs('the `.controller.ts` suffix').filter(checkableRef)).toEqual([]);
    expect(extractCodeRefs('built with Next.js and Node.js')).toEqual([]);
    expect(statusOf(ids.prose)).toBe('fresh');
  });

  it('resolves a path written from the submodule root', () => {
    expect(statusOf(ids.submodule)).toBe('fresh');
  });

  it('does not judge a path whose top directory is not ours', () => {
    expect(isOurRepoRef('src/app/api/checkout/route.ts', root)).toBe(false);
    expect(isOurRepoRef('eval/lib/whatever.mjs', root)).toBe(true);
    expect(statusOf(ids.foreign)).toBe('fresh');
  });

  it('a generic top directory of the submodule does not make a foreign path ours', () => {
    // `RepoBrain/apps` and `RepoBrain/packages` exist; a benchmark target's `apps/web/**` must not
    // become "ours" and get flagged dead just because the submodule happens to have that name.
    expect(isOurRepoRef('apps/web/app/page.tsx', root)).toBe(false);
    expect(isOurRepoRef('packages/ui/src/button.tsx', root)).toBe(false);
  });

  it('control: a vanished path under a directory that IS ours still goes stale', () => {
    expect(statusOf(ids.gone)).toBe('stale');
  });

  it('counts the skipped foreign refs instead of hiding them', () => {
    const again = checkStaleness(store, undefined, root);
    expect(again.foreignRefs).toBeGreaterThan(0);
  });
});
