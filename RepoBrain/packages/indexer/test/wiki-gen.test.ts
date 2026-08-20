import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { generateWiki, writeWiki, renderWikiHtml, WikiDirNotOursError } from '../src/index.js';

const dbPath = join(tmpdir(), `rb-wiki-${process.pid}.sqlite`);

function addFile(store: GraphStore, path: string, symbols = 1): number {
  const id = store.upsertFile({
    path, language: 'typescript', hash: path, size_bytes: 1, lines_count: 1, last_modified: 1,
    parse_status: 'ok', is_test: false, is_generated: false, has_secrets: false, package_id: null,
    git_last_commit: null, git_last_date: null, git_churn: 0,
  });
  const syms = Array.from({ length: symbols }, (_, i) => ({
    file_id: id, name: `sym${i}`, qualified_name: `sym${i}`, kind: 'function' as const,
    signature: `function sym${i}(input: string): void`,
    docstring: i === 0 ? 'Signs a token. Extra rambling detail that should be cut.' : null,
    start_line: 1, end_line: 2, visibility: 'public' as const, exported: true, hash: `${path}-${i}`,
  }));
  store.replaceFileSymbols(id, syms);
  return id;
}

describe('wiki generator (human-facing docs)', () => {
  let store: GraphStore;
  let wiki: { path: string; content: string }[];

  beforeAll(() => {
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    store = GraphStore.open(dbPath);
    const svc = addFile(store, 'backend/src/modules/auth/jwt.service.ts', 5);
    const ctrl = addFile(store, 'backend/src/modules/auth/auth.controller.ts', 2);
    addFile(store, 'backend/src/common/util.ts', 1);
    store.insertEdges([
      { source_type: 'file', source_id: ctrl, target_type: 'file', target_id: svc, edge_type: 'imports', confidence: 1, resolution: 'exact', file_id: ctrl, line: 1 },
    ]);
    // a note documenting the service, linked via a note↔code edge
    const noteId = store.insertMemory({
      type: 'second_brain', title: 'Auth design', body: 'JWT tokens are signed with RS256 because X.',
      related_files: [], related_symbols: [], tags: ['second-brain/01_projects/auth.md', '01_projects'], stale_status: 'fresh',
    });
    store.insertEdges([
      { source_type: 'memory', source_id: noteId, target_type: 'file', target_id: svc, edge_type: 'documents', confidence: 1, resolution: 'exact', file_id: svc, line: null },
    ]);
    wiki = generateWiki(store, '/repo/myproject');
  });

  afterAll(() => {
    store?.close();
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  });

  it('emits a home page + module pages', () => {
    expect(wiki[0]!.path).toBe('index.md');
    expect(wiki[0]!.content).toContain('# myproject — вики проекта');
    expect(wiki.some((f) => f.path.startsWith('modules/'))).toBe(true);
  });

  it('groups deeper than 2 segments past a container dir (auth module, not just backend/src)', () => {
    const auth = wiki.find((f) => f.content.includes('# Раздел backend/src/modules/auth'));
    expect(auth).toBeTruthy();
    expect(auth!.content).toContain('backend/src/modules/auth/jwt.service.ts');
    expect(auth!.content).toContain('сервис'); // grounded role
  });

  it('weaves the second-brain WHY, quoted with a citation', () => {
    const auth = wiki.find((f) => f.content.includes('# Раздел backend/src/modules/auth'))!;
    expect(auth.content).toContain('## Почему так — из второго мозга');
    expect(auth.content).toContain('signed with RS256'); // verbatim quote
    expect(auth.content).toContain('second-brain/01_projects/auth.md'); // citation
  });

  it('lists key functions with signature and only the first docstring sentence', () => {
    const auth = wiki.find((f) => f.content.includes('# Раздел backend/src/modules/auth'))!;
    expect(auth.content).toContain('## Ключевые функции');
    expect(auth.content).toContain('function sym0(input: string): void');
    expect(auth.content).toContain('Signs a token.'); // first sentence kept
    expect(auth.content).not.toContain('Extra rambling detail'); // run-on cut
  });

  it('writes every heading in Russian, including pages whose path is pure Latin', () => {
    const headings = wiki.flatMap((f) => f.content.split('\n').filter((l) => /^#{1,6}\s+\S/.test(l)));
    expect(headings.length).toBeGreaterThan(3);
    for (const h of headings) expect(h).toMatch(/[А-Яа-яЁё]/);
  });

  it('renders a self-contained HTML with no external assets', () => {
    const html = renderWikiHtml(wiki, 'myproject');
    expect(html).toContain('<title>myproject — вики</title>');
    expect(html).toContain('<nav>');
    expect(/src="https?:|href="https?:\/\/cdn/.test(html)).toBe(false);
  });
});

describe('module descriptions in the overview table', () => {
  const dbPath2 = join(tmpdir(), `rb-wiki-desc-${process.pid}.sqlite`);
  const GENERATED_DESCRIPTION = /^(code module|API area \(\d+ routes?\)|[a-z]+ package|library)$/i;
  const CYRILLIC = /[А-Яа-яЁё]/;
  let store: GraphStore;
  let rows: { module: string; description: string }[];

  beforeAll(() => {
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath2 + s, { force: true });
    store = GraphStore.open(dbPath2);
    const page = addFile(store, 'apps/web/src/pages/dashboard.tsx', 4);
    addFile(store, 'apps/web/src/pages/profile.tsx', 3);
    const util = addFile(store, 'libs/util/src/format.ts', 6);
    addFile(store, 'libs/util/src/parse.ts', 2);
    addFile(store, 'assets/icons/logo.ts', 0);
    store.insertEdges([
      { source_type: 'file', source_id: page, target_type: 'file', target_id: util, edge_type: 'imports', confidence: 1, resolution: 'exact', file_id: page, line: 1 },
    ]);
    const noteId = store.insertMemory({
      type: 'second_brain', title: 'Кабинет ученика',
      body: '# Кабинет\n\nЭкран dashboard собирает прогресс ученика по урокам в одну страницу. Дальше идут детали.',
      related_files: [], related_symbols: [], tags: ['second-brain/01_projects/cabinet.md', '01_projects'], stale_status: 'fresh',
    });
    const historyId = store.insertMemory({
      type: 'second_brain', title: 'Рефлексия волны 3',
      body: 'Коммиты по разделу format и parse: 536e634, f9b94e9. Что вышло и чему научились по ходу работы.',
      related_files: [], related_symbols: [], tags: ['second-brain/05_history/2026-07-28.md', '05_history'], stale_status: 'fresh',
    });
    store.insertEdges([
      { source_type: 'memory', source_id: noteId, target_type: 'file', target_id: page, edge_type: 'documents', confidence: 1, resolution: 'exact', file_id: page, line: null },
      { source_type: 'memory', source_id: historyId, target_type: 'file', target_id: util, edge_type: 'documents', confidence: 1, resolution: 'exact', file_id: util, line: null },
    ]);
    const index = generateWiki(store, '/repo/demo')[0]!.content;
    rows = [];
    for (const line of index.split('\n')) {
      const m = line.match(/^\|\s*\[([^\]]+)\]\([^)]+\)\s*\|\s*\d+\s*\|\s*([^|]*?)\s*\|\s*$/);
      if (m) rows.push({ module: m[1]!, description: m[2]! });
    }
  });

  afterAll(() => {
    store?.close();
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath2 + s, { force: true });
  });

  it('never falls back to a template string, and every row speaks Russian', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.description).not.toMatch(GENERATED_DESCRIPTION);
      expect(r.description).toMatch(CYRILLIC);
    }
  });

  it('takes the headline from a note that names this code, skipping the markdown heading', () => {
    const web = rows.find((r) => r.module.startsWith('apps/web'))!;
    expect(web.description).toBe('Экран dashboard собирает прогресс ученика по урокам в одну страницу.');
  });

  it('ignores a note that documents the area but only logs history (negative case)', () => {
    const util = rows.find((r) => r.module.startsWith('libs/util'))!;
    expect(util.description).not.toMatch(/536e634/);
    expect(util.description).toMatch(/файл/);
    expect(util.description).toMatch(/\d/);
  });

  it('describes even an area with no notes and no symbols', () => {
    const assets = rows.find((r) => r.module.startsWith('assets'))!;
    expect(assets.description).toMatch(/^код без заметок: /);
    expect(assets.description).toMatch(CYRILLIC);
  });
});

describe('project intro and the “what you can change here” section', () => {
  const repo = join(tmpdir(), `rb-wiki-intro-${process.pid}`);
  const dbPath4 = join(repo, 'g.sqlite');
  let store: GraphStore;

  beforeAll(() => {
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(join(repo, 'second-brain'), { recursive: true });
    store = GraphStore.open(dbPath4);
    const svc = addFile(store, 'src/orders/order.service.ts', 3);
    addFile(store, 'src/orders/helper.ts', 1);
    store.insertEdges([
      { source_type: 'file', source_id: svc, target_type: 'file', target_id: svc, edge_type: 'imports', confidence: 1, resolution: 'exact', file_id: svc, line: 1 },
    ]);
  });

  afterAll(() => {
    store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('prefers the second brain index over README', () => {
    writeFileSync(join(repo, 'README.md'), '# repo\n\nЧитается из README, если больше неоткуда.\n', 'utf8');
    writeFileSync(join(repo, 'second-brain', 'index.md'), '# SECOND BRAIN\n\n> Магазин запчастей: заказы, оплата, доставка.\n', 'utf8');
    const index = generateWiki(store, repo)[0]!.content;
    expect(index).toContain('Магазин запчастей: заказы, оплата, доставка.');
    expect(index).not.toContain('Читается из README');
  });

  it('falls back to README when the second brain has no index', () => {
    rmSync(join(repo, 'second-brain', 'index.md'), { force: true });
    const index = generateWiki(store, repo)[0]!.content;
    expect(index).toContain('Читается из README, если больше неоткуда.');
  });

  it('says out loud that the intro is still a template (negative case)', () => {
    writeFileSync(join(repo, 'second-brain', 'index.md'), '# SECOND BRAIN — {{PROJECT_NAME}}\n\n> `{{PROJECT_NAME}}` — одна строка про проект.\n', 'utf8');
    const index = generateWiki(store, repo)[0]!.content;
    expect(index).toContain('## Что это');
    expect(index).toContain('Вводный документ проекта не заполнен');
  });

  it('gives every module page a “what you can change here” section', () => {
    const pages = generateWiki(store, repo).filter((f) => f.path.startsWith('modules/'));
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      expect(p.content).toContain('## Что тут можно менять');
      expect(p.content).toMatch(/- Точки входа|- Точек входа нет/);
      expect(p.content).toMatch(/- Края|- Краёв нет/);
    }
  });
});

describe('second-brain quotes are cut by meaning, not by a counter', () => {
  const dbPath3 = join(tmpdir(), `rb-wiki-quote-${process.pid}.sqlite`);
  let store: GraphStore;
  let page: string;

  const longBody = `${'Первое предложение про сервис оплаты живёт здесь и объясняет замысел. '.repeat(6)}Хвост, который в цитату уже не влезет.`;

  beforeAll(() => {
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath3 + s, { force: true });
    store = GraphStore.open(dbPath3);
    const long = addFile(store, 'billing/src/checkout/pay.service.ts', 3);
    const short = addFile(store, 'billing/src/refund/refund.service.ts', 2);
    const longNote = store.insertMemory({
      type: 'second_brain', title: 'Оплата', body: longBody,
      related_files: [], related_symbols: [], tags: ['second-brain/02_architecture/pay.md', '02_architecture'], stale_status: 'fresh',
    });
    const shortNote = store.insertMemory({
      type: 'second_brain', title: 'Возвраты', body: 'Возврат идёт тем же способом, что и оплата.',
      related_files: [], related_symbols: [], tags: ['second-brain/02_architecture/refund.md', '02_architecture'], stale_status: 'fresh',
    });
    store.insertEdges([
      { source_type: 'memory', source_id: longNote, target_type: 'file', target_id: long, edge_type: 'documents', confidence: 1, resolution: 'exact', file_id: long, line: null },
      { source_type: 'memory', source_id: shortNote, target_type: 'file', target_id: short, edge_type: 'documents', confidence: 1, resolution: 'exact', file_id: short, line: null },
    ]);
    page = generateWiki(store, '/repo/shop')
      .filter((f) => f.path.startsWith('modules/'))
      .map((f) => f.content)
      .join('\n');
  });

  afterAll(() => {
    store?.close();
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath3 + s, { force: true });
  });

  function quotesOf(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('- **')) continue;
      const tail = line.lastIndexOf('… `(');
      if (tail < 0) continue;
      const dash = line.indexOf('** — ');
      const start = dash >= 0 ? dash + 5 : line.indexOf(' — ') + 3;
      if (start <= 2 || start >= tail) continue;
      out.push(line.slice(start, tail));
    }
    return out;
  }

  it('ends a long quote on a sentence boundary, shorter than the probe limit', () => {
    const quotes = quotesOf(page);
    expect(quotes.length).toBeGreaterThan(0);
    for (const q of quotes) {
      expect(q.length).toBeLessThan(280);
      expect(q.trim()).toMatch(/[.!?…]$/);
    }
    expect(page).not.toContain('Хвост, который в цитату уже не влезет.');
  });

  it('quotes a short note whole and without a continuation mark (negative case)', () => {
    const line = page.split('\n').find((l) => l.startsWith('- **Возвраты**'))!;
    expect(line).toContain('Возврат идёт тем же способом, что и оплата.');
    expect(line).not.toContain('…');
  });
});

describe('wiki write safety', () => {
  const dir = join(tmpdir(), `rb-wiki-safe-${process.pid}`);
  let store: GraphStore;

  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    store = GraphStore.open(join(dir, 'g.sqlite'));
    addFile(store, 'src/app/main.ts', 2);
  });
  afterAll(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to overwrite a wiki/ folder RepoBrain did not create', () => {
    const out = join(dir, 'wiki');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'mine.md'), 'hand-written docs', 'utf8');
    expect(() => writeWiki(store, dir, out)).toThrow(WikiDirNotOursError);
    expect(readFileSync(join(out, 'mine.md'), 'utf8')).toBe('hand-written docs'); // untouched
  });

  it('takes it over with force, and then owns it for future regenerations', () => {
    const out = join(dir, 'wiki');
    writeWiki(store, dir, out, { force: true });
    expect(existsSync(join(out, 'index.md'))).toBe(true);
    expect(existsSync(join(out, '.repobrain-wiki'))).toBe(true); // marker
    expect(() => writeWiki(store, dir, out)).not.toThrow(); // ours now — no force needed
  });
});
