import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { ingestSecondBrain, resolveSecondBrainDir, stripFrontmatter } from '../src/index.js';

const root = join(tmpdir(), `rb-sb-test-${process.pid}`);
const brain = join(root, 'second-brain');
const dbPath = join(root, 'graph.sqlite');

describe('second-brain ingestion (double-search WHY channel)', () => {
  let store: GraphStore;

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(brain, '02_architecture'), { recursive: true });
    mkdirSync(join(brain, '00_system'), { recursive: true });
    // a note with frontmatter + H1
    writeFileSync(
      join(brain, '02_architecture', 'tokens.md'),
      `---\ntype: architecture\n---\n\n# Guest token lifetime\n\nGuest tokens live exactly one hour because the media server rejects longer TTLs. Never raise this without rotating the signing key first.\n`,
    );
    // a note without frontmatter, title from filename
    writeFileSync(
      join(brain, '00_system', 'source-of-truth.md'),
      `Code is the source of truth. When a note contradicts the code, fix the note.\n`,
    );
    store = GraphStore.open(dbPath);
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('auto-detects the second-brain folder under the repo root', () => {
    expect(resolveSecondBrainDir(root)).toBe(brain);
    expect(resolveSecondBrainDir(join(tmpdir(), 'nope-xyz'))).toBeNull();
  });

  it('strips YAML frontmatter, keeps body', () => {
    const { frontmatter, body } = stripFrontmatter('---\ntype: x\n---\nhello\n');
    expect(frontmatter).toContain('type: x');
    expect(body.trim()).toBe('hello');
    expect(stripFrontmatter('no frontmatter').body).toBe('no frontmatter');
  });

  it('ingests every markdown note as a second_brain memory', () => {
    const res = ingestSecondBrain(store, root);
    expect(res).not.toBeNull();
    expect(res!.notes).toBe(2);
    expect(store.countMemoriesByType('second_brain')).toBe(2);
  });

  it('extracts H1 as title and cites the source path in tags[0]', () => {
    const hits = store.searchMemoriesFts('guest token lifetime', 5);
    expect(hits.length).toBeGreaterThan(0);
    const note = hits[0]!.item;
    expect(note.type).toBe('second_brain');
    expect(note.title).toBe('Guest token lifetime');
    expect(note.tags[0]).toBe('second-brain/02_architecture/tokens.md');
    expect(note.body).toContain('rotating the signing key');
  });

  it('is findable by natural words in the body (the WHY the code does not state)', () => {
    // "one hour" / "TTL" appears only in the note, never in code — this is the double-search win
    const hits = store.searchMemoriesFts('why one hour ttl', 5);
    expect(hits.some((h) => h.item.title === 'Guest token lifetime')).toBe(true);
  });

  it('re-ingest is idempotent (refresh, not duplicate)', () => {
    ingestSecondBrain(store, root);
    ingestSecondBrain(store, root);
    expect(store.countMemoriesByType('second_brain')).toBe(2);
  });

  it('returns null when no folder exists (no-op for repos without a knowledge base)', () => {
    const empty = join(tmpdir(), `rb-sb-empty-${process.pid}`);
    mkdirSync(empty, { recursive: true });
    const s2 = GraphStore.open(join(empty, 'g.sqlite'));
    expect(ingestSecondBrain(s2, empty)).toBeNull();
    s2.close();
    rmSync(empty, { recursive: true, force: true });
  });
});
