/**
 * Human-facing wiki generator (concept 3 — distinct from the second brain, which is for the agent).
 *
 * This is PROSE FOR A PERSON: a newcomer opens it to learn what the project is, what each area does,
 * how things connect, and — where a second-brain note exists — *why*. Like everything else it is
 * code-grounded: structure comes from the graph (no invented facts), and the WHY is quoted verbatim
 * from second-brain notes (with a citation), never paraphrased into a hallucination. Output is a set
 * of readable markdown files, NOT rows in the memories table.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import type { GraphStore } from '@repobrain/graph-store';

export interface WikiFile {
  path: string; // relative to the wiki output dir
  content: string;
}

export interface GenerateWikiOptions {
  projectName?: string;
  maxModules?: number; // module pages to emit (by size), default 24
  html?: boolean; // also emit a single self-contained index.html
}

interface ModuleAgg {
  dir: string;
  fileIds: number[];
  files: number;
  symbols: number;
  importsTo: Map<string, number>; // other module → import count
}

/**
 * Group a file into a human-sized module. Coarse top-2-segment grouping dumps a whole backend into
 * one page, so we go one level deeper past a known container dir (`modules`/`packages`/`lib`/`src`) —
 * e.g. `backend/src/modules/livekit/x.ts` → `backend/src/modules/livekit`.
 */
const CONTAINERS = new Set(['modules', 'packages', 'lib', 'src', 'app', 'features', 'services']);
function moduleOf(path: string): string {
  const seg = path.split('/');
  if (seg.length === 1) return '(root)'; // files sitting at the repo root are one group, not one page each
  if (seg.length === 2) return seg[0]!;
  // find the LAST container segment that still leaves a name after it
  let cut = 2;
  for (let i = 0; i < seg.length - 1; i++) {
    if (CONTAINERS.has(seg[i]!.toLowerCase())) cut = Math.min(seg.length - 1, i + 2);
  }
  return seg.slice(0, cut).join('/');
}
const slug = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase();

const INTRO_MISSING = 'Вводный документ проекта не заполнен — допишите second-brain/index.md.';

function firstParagraph(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  for (const para of text.split(/\n\s*\n/)) {
    const t = para.trim();
    if (!t || t.startsWith('#') || t.startsWith('![') || t.startsWith('<')) continue;
    const flat = t.split('\n').map((l) => l.trim().replace(/^>+\s*/, '')).join(' ').replace(/\s+/g, ' ').trim();
    return cutToWord(flat, 600);
  }
  return '';
}

/** What the product IS, in the owner's own words: the second brain's index first, README as fallback. */
function projectIntro(root: string): string {
  const candidates = [join(root, 'second-brain', 'index.md'), ...['README.md', 'readme.md', 'README'].map((n) => join(root, n))];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const para = firstParagraph(p);
    if (!para) continue;
    return /\{\{[^}]*\}\}|<[а-яa-z][^>]*>/i.test(para) ? INTRO_MISSING : para;
  }
  return INTRO_MISSING;
}

/**
 * One readable sentence from a docstring. The extractor folds leading + in-body comments together, which
 * reads as run-on noise in human docs — a reader wants the first sentence, not the whole blob.
 */
function firstSentence(doc: string | null): string {
  if (!doc) return '';
  const flat = doc.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  return (m?.[1] ?? flat).slice(0, 130);
}

const CYRILLIC = /[А-Яа-яЁё]/;

const ROLE_RU: Record<string, string> = {
  service: 'сервисы',
  'HTTP controller': 'HTTP-контроллеры',
  worker: 'фоновые обработчики',
  'cron job': 'задания по расписанию',
  DTO: 'структуры данных (DTO)',
  module: 'модули',
  guard: 'сторожа доступа',
  'UI component': 'UI-компоненты',
  'entry point': 'точки входа',
  file: 'файлы',
};

const ROLE_RU_ONE: Record<string, string> = {
  service: 'сервис',
  'HTTP controller': 'HTTP-контроллер',
  worker: 'фоновый обработчик',
  'cron job': 'задание по расписанию',
  DTO: 'структура данных (DTO)',
  module: 'модуль',
  guard: 'сторож доступа',
  'UI component': 'UI-компонент',
  'entry point': 'точка входа',
  file: 'файл',
};

function plural(n: number, one: string, few: string, many: string): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return `${n} ${one}`;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** A grounded one-line role from a filename (same convention as the second-brain generator). */
function roleOf(path: string): string {
  const b = path.toLowerCase();
  if (b.includes('.service.')) return 'service';
  if (b.includes('.controller.')) return 'HTTP controller';
  if (b.includes('.worker.')) return 'worker';
  if (b.includes('.cron.')) return 'cron job';
  if (b.includes('.dto.')) return 'DTO';
  if (b.includes('.module.')) return 'module';
  if (b.includes('.guard.')) return 'guard';
  if (/\.(tsx|jsx)$/.test(b)) return 'UI component';
  if (/(^|\/)(index|main|app|server|cli)\.[a-z]+$/.test(b)) return 'entry point';
  return 'file';
}

interface KeyFile {
  id: number;
  path: string;
  score: number;
}

function keyFilesOf(
  m: ModuleAgg,
  symCount: Map<number, number>,
  importerCount: Map<number, number>,
  fileById: Map<number, { id: number; path: string }>,
): KeyFile[] {
  return m.fileIds
    .map((id) => ({ id, path: fileById.get(id)!.path, score: (symCount.get(id) ?? 0) + (importerCount.get(id) ?? 0) * 2 }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
    .slice(0, 12);
}

function notesDocumenting(store: GraphStore, fileIds: number[]): number[] {
  const noteIds = new Set<number>();
  for (const id of fileIds) {
    for (const e of store.edgesTo('file', id)) {
      if (e.edge_type === 'documents' && e.source_type === 'memory') noteIds.add(e.source_id);
    }
  }
  return [...noteIds];
}

const QUOTE_WHOLE_LIMIT = 279;
const QUOTE_LIMIT = 278;

function quoteFrom(body: string): { text: string; cut: 'sentence' | 'word' | null } {
  const flat = proseOf(body);
  if (flat.length <= QUOTE_WHOLE_LIMIT) return { text: flat, cut: null };
  const head = flat.slice(0, QUOTE_LIMIT);
  const sentence = head.match(/^.*[.!?…](?=\s|$)/)?.[0]?.trim();
  if (sentence && sentence.length >= QUOTE_LIMIT / 3) return { text: sentence, cut: 'sentence' };
  return { text: cutToWord(head, QUOTE_LIMIT), cut: 'word' };
}

function cutToWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const space = head.lastIndexOf(' ');
  return (space > limit / 2 ? head.slice(0, space) : head).trimEnd();
}

const MIN_HEADLINE = 40;

function proseOf(body: string): string {
  const prose: string[] = [];
  for (const raw of body.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('![')) continue;
    if (/^(```|---|===|<!--)/.test(line)) continue;
    line = line.replace(/^>+\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '');
    line = line.replace(/\*\*/g, '').replace(/^_+/, '').replace(/_+$/, '');
    if (line) prose.push(line);
  }
  return prose.join(' ').replace(/\s+/g, ' ').trim();
}

function firstProseSentence(body: string): string {
  const flat = proseOf(body).replace(/`/g, '');
  for (const s of flat.split(/(?<=[.!?…])\s+/)) {
    if (s.length >= MIN_HEADLINE && /^[A-ZА-ЯЁ«]/.test(s)) return s;
  }
  return '';
}

const DESCRIBING_AREAS = /^0[12]_/;

function bestNoteFor(store: GraphStore, m: ModuleAgg): { title: string; body: string } | null {
  const inModule = new Set(m.fileIds);
  let best: { note: { title: string; body: string }; coverage: number; hits: number } | null = null;
  for (const id of notesDocumenting(store, m.fileIds)) {
    const n = store.getMemory(id);
    if (!n || n.type !== 'second_brain' || n.stale_status === 'stale') continue;
    if (!DESCRIBING_AREAS.test(n.tags[1] ?? '')) continue;
    const documented = store.edgesFrom('memory', id).filter((e) => e.edge_type === 'documents' && e.target_type === 'file');
    if (!documented.length) continue;
    const hits = documented.filter((e) => inModule.has(e.target_id)).length;
    const coverage = hits / documented.length;
    if (coverage < 0.5) continue;
    if (!best || coverage > best.coverage || (coverage === best.coverage && hits > best.hits)) {
      best = { note: n, coverage, hits };
    }
  }
  return best?.note ?? null;
}

const GENERIC_NAMES = new Set(['index', 'types', 'utils', 'util', 'main', 'config', 'const', 'consts', 'helpers', 'route', 'page', 'client', 'server']);

function moduleVocabulary(store: GraphStore, m: ModuleAgg, keys: KeyFile[], fileById: Map<number, { id: number; path: string }>): string[] {
  const words = new Set<string>();
  const add = (w: string): void => {
    const clean = w.toLowerCase();
    if (clean.length >= 5 && !GENERIC_NAMES.has(clean)) words.add(clean);
  };
  for (const seg of m.dir.split('/')) add(seg);
  for (const id of m.fileIds) {
    const path = fileById.get(id)?.path;
    if (!path) continue;
    for (const seg of path.slice(m.dir.length + 1).split('/')) add(seg.replace(/\.[a-z]+$/i, ''));
  }
  for (const f of keys) for (const s of store.symbolsByFile(f.id)) if (s.exported) add(s.name);
  return [...words];
}

function noteHeadline(store: GraphStore, m: ModuleAgg, vocabulary: string[]): string {
  const note = bestNoteFor(store, m);
  if (!note) return '';
  const sentence = firstProseSentence(note.body);
  if (sentence.length < MIN_HEADLINE || !CYRILLIC.test(sentence)) return '';
  const lower = sentence.toLowerCase();
  if (!vocabulary.some((w) => lower.includes(w))) return '';
  return cutToWord(sentence, 120).replace(/\|/g, '·');
}

function topCalledSymbol(store: GraphStore, keys: KeyFile[]): string {
  let best = '';
  let bestCallers = -1;
  for (const f of keys) {
    for (const s of store.symbolsByFile(f.id)) {
      if (!s.exported) continue;
      if (s.kind !== 'function' && s.kind !== 'method' && s.kind !== 'class') continue;
      const callers = store.edgesTo('symbol', s.id).filter((e) => e.edge_type === 'calls').length;
      if (callers > bestCallers || (callers === bestCallers && best && s.name < best)) {
        best = s.name;
        bestCallers = callers;
      }
    }
  }
  return bestCallers > 0 ? best : '';
}

/**
 * What this area IS, in one cell of the overview table — derived, never invented: a second-brain
 * headline when the area is documented, otherwise its composition in the graph.
 */
function moduleDescription(
  store: GraphStore,
  m: ModuleAgg,
  keys: KeyFile[],
  fileById: Map<number, { id: number; path: string }>,
): string {
  const fromNote = noteHeadline(store, m, moduleVocabulary(store, m, keys, fileById));
  if (fromNote) return fromNote;

  const roles = new Map<string, number>();
  for (const id of m.fileIds) {
    const path = fileById.get(id)?.path;
    if (!path) continue;
    const r = roleOf(path);
    roles.set(r, (roles.get(r) ?? 0) + 1);
  }
  const topRole = [...roles.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? 'file';
  const routes = store.allRoutes().filter((r) => m.fileIds.includes(r.file_id)).length;

  const called = topCalledSymbol(store, keys);
  const named = topRole !== 'file' ? ROLE_RU[topRole] : undefined;
  if (!named && !routes && !called) {
    return `код без заметок: ${plural(m.files, 'файл', 'файла', 'файлов')}, ${plural(m.symbols, 'символ', 'символа', 'символов')}`;
  }

  const parts: string[] = [];
  if (named) parts.push(named);
  parts.push(plural(m.files, 'файл', 'файла', 'файлов'));
  if (routes > 0) parts.push(plural(routes, 'маршрут HTTP', 'маршрута HTTP', 'маршрутов HTTP'));
  parts.push(plural(m.symbols, 'символ', 'символа', 'символов'));
  return called ? `${parts.join(', ')}; чаще всего вызывают ${called}` : parts.join(', ');
}

export function generateWiki(store: GraphStore, root: string, opts: GenerateWikiOptions = {}): WikiFile[] {
  const projectName = opts.projectName ?? resolve(root).split('/').filter(Boolean).pop() ?? 'project';
  const maxModules = opts.maxModules ?? 24;

  const files = store.allFiles().filter((f) => !f.is_generated);
  const fileById = new Map(files.map((f) => [f.id, f]));
  const symCount = new Map<number, number>();
  for (const s of store.allSymbols()) symCount.set(s.file_id, (symCount.get(s.file_id) ?? 0) + 1);
  const importerCount = new Map<number, number>();
  const importPairs: { from: number; to: number }[] = [];
  for (const e of store.edgesForRanking()) {
    if (e.edge_type === 'imports' && e.source_type === 'file' && e.target_type === 'file') {
      importerCount.set(e.target_id, (importerCount.get(e.target_id) ?? 0) + 1);
      importPairs.push({ from: e.source_id, to: e.target_id });
    }
  }

  // group into modules (top-2 path segments)
  const mods = new Map<string, ModuleAgg>();
  for (const f of files) {
    const dir = moduleOf(f.path);
    let m = mods.get(dir);
    if (!m) {
      m = { dir, fileIds: [], files: 0, symbols: 0, importsTo: new Map() };
      mods.set(dir, m);
    }
    m.fileIds.push(f.id);
    m.files++;
    m.symbols += symCount.get(f.id) ?? 0;
  }
  for (const { from, to } of importPairs) {
    const a = fileById.get(from);
    const b = fileById.get(to);
    if (!a || !b) continue;
    const ma = mods.get(moduleOf(a.path));
    const mbDir = moduleOf(b.path);
    if (ma && mbDir !== ma.dir) ma.importsTo.set(mbDir, (ma.importsTo.get(mbDir) ?? 0) + 1);
  }
  const ranked = [...mods.values()].sort((a, b) => b.symbols - a.symbols || b.files - a.files).slice(0, maxModules);

  const out: WikiFile[] = [];
  out.push({ path: 'index.md', content: homePage(store, root, projectName, files, ranked, symCount, importerCount, fileById) });
  for (const m of ranked) {
    out.push({ path: `modules/${slug(m.dir)}.md`, content: modulePage(store, m, symCount, importerCount, fileById) });
  }
  return out;
}

function homePage(
  store: GraphStore,
  root: string,
  name: string,
  files: { language: string; path: string }[],
  ranked: ModuleAgg[],
  symCount: Map<number, number>,
  importerCount: Map<number, number>,
  fileById: Map<number, { id: number; path: string }>,
): string {
  const langs = new Map<string, number>();
  for (const f of files) langs.set(f.language, (langs.get(f.language) ?? 0) + 1);
  const langLine = [...langs.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n})`).join(', ');
  const routes = store.allRoutes();
  const intro = projectIntro(root);

  const lines: string[] = [];
  lines.push(`# ${name} — вики проекта`, '');
  lines.push('_Собрано по графу кода. Структура выведена из кода; «почему» процитировано из второго мозга._', '');
  lines.push('## Что это', '', intro, '');
  lines.push('## Коротко', '');
  lines.push(`- **Файлов:** ${files.length}`);
  lines.push(`- **Языки:** ${langLine}`);
  if (routes.length) lines.push(`- **Маршрутов HTTP:** ${routes.length}`);
  lines.push('');
  lines.push('## Разделы кода', '');
  lines.push('| Раздел | Файлов | Что это |');
  lines.push('|---|---|---|');
  for (const m of ranked) {
    const what = moduleDescription(store, m, keyFilesOf(m, symCount, importerCount, fileById), fileById);
    lines.push(`| [${m.dir}](modules/${slug(m.dir)}.md) | ${m.files} | ${what} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function modulePage(
  store: GraphStore,
  m: ModuleAgg,
  symCount: Map<number, number>,
  importerCount: Map<number, number>,
  fileById: Map<number, { id: number; path: string }>,
): string {
  const lines: string[] = [];
  lines.push(`# Раздел ${m.dir}`, '');
  lines.push(`_${plural(m.files, 'файл', 'файла', 'файлов')}, ${plural(m.symbols, 'символ', 'символа', 'символов')}. Собрано по графу кода._`, '');

  // key files by significance
  const key = keyFilesOf(m, symCount, importerCount, fileById);
  lines.push('## Ключевые файлы', '');
  for (const f of key) lines.push(`- \`${f.path}\` — ${ROLE_RU_ONE[roleOf(f.path)] ?? 'файл'}`);
  lines.push('');

  // key functions — what a newcomer actually asks ("what's here, what does it do")
  const byySig = new Map<string, { sig: string; doc: string; callers: number }>();
  for (const f of key) {
    for (const s of store.symbolsByFile(f.id)) {
      if (s.kind !== 'function' && s.kind !== 'method' && s.kind !== 'class') continue;
      if (!s.exported && s.kind === 'function') continue; // internals aren't wiki material
      const sig = (s.signature || s.name).replace(/\s+/g, ' ').trim().slice(0, 130);
      const callers = store.edgesTo('symbol', s.id).filter((e) => e.edge_type === 'calls').length;
      const doc = firstSentence(s.docstring);
      // Dedupe by signature: the same method implemented across sibling classes (e.g. `auth_flow` in
      // every Auth subclass) is one line for a reader, not five. Keep the best-documented / most-used.
      const prev = byySig.get(sig);
      if (!prev || callers > prev.callers || (!prev.doc && doc)) {
        byySig.set(sig, { sig, doc: doc || prev?.doc || '', callers: Math.max(callers, prev?.callers ?? 0) });
      }
    }
  }
  const funcs = [...byySig.values()].sort((a, b) => b.callers - a.callers);
  if (funcs.length) {
    lines.push('## Ключевые функции', '');
    for (const fn of funcs.slice(0, 12)) {
      const doc = fn.doc ? ` — ${fn.doc}` : '';
      const used = fn.callers > 0 ? ` _(вызывают из ${plural(fn.callers, 'места', 'мест', 'мест')})_` : '';
      lines.push(`- \`${fn.sig}\`${doc}${used}`);
    }
    lines.push('');
  }

  // routes exposed here
  const routes = store.allRoutes().filter((r) => m.fileIds.includes(r.file_id));
  if (routes.length) {
    lines.push('## Маршруты HTTP', '');
    for (const r of routes.slice(0, 25)) lines.push(`- \`${r.method} ${r.path}\``);
    lines.push('');
  }

  // connections
  const conns = [...m.importsTo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (conns.length) {
    lines.push('## Зависит от', '');
    for (const [dir, n] of conns) lines.push(`- [${dir}](${slug(dir)}.md) (${plural(n, 'импорт', 'импорта', 'импортов')})`);
    lines.push('');
  }

  lines.push('## Что тут можно менять', '');
  const exported: { name: string; callers: number }[] = [];
  for (const f of key) {
    for (const s of store.symbolsByFile(f.id)) {
      if (!s.exported || (s.kind !== 'function' && s.kind !== 'method' && s.kind !== 'class')) continue;
      exported.push({ name: s.name, callers: store.edgesTo('symbol', s.id).filter((e) => e.edge_type === 'calls').length });
    }
  }
  const entryPoints = exported.sort((a, b) => b.callers - a.callers || (a.name < b.name ? -1 : 1)).slice(0, 3);
  lines.push(
    entryPoints.length
      ? `- Точки входа: ${entryPoints.map((e) => `\`${e.name}\``).join(', ')} — их зовут снаружи, правка видна другим разделам.`
      : '- Точек входа нет: раздел ничего не экспортирует наружу.',
  );
  const rims = m.fileIds
    .filter((id) => (importerCount.get(id) ?? 0) === 0)
    .map((id) => fileById.get(id)!.path)
    .sort()
    .slice(0, 3);
  lines.push(
    rims.length
      ? `- Края: ${rims.map((p) => `\`${p}\``).join(', ')} — их никто не импортирует, правка не заденет соседей.`
      : '- Краёв нет: каждый файл раздела кто-то импортирует.',
  );
  lines.push('');

  // WHY — second-brain notes documenting files in this module (via note↔code edges), quoted verbatim
  const whyNotes = notesDocumenting(store, m.fileIds)
    .map((id) => store.getMemory(id))
    .filter((x): x is NonNullable<typeof x> => !!x && x.type === 'second_brain')
    .slice(0, 6);
  if (whyNotes.length) {
    lines.push('## Почему так — из второго мозга', '', '_Дословные цитаты из заметок команды:_', '');
    for (const n of whyNotes) {
      const { text, cut } = quoteFrom(n.body);
      const src = n.tags[0] ?? n.title;
      const flag = n.stale_status === 'stale' ? ' ⚠ возможно, устарела' : '';
      const tail = cut === 'sentence' ? ' …' : cut === 'word' ? '…' : '';
      lines.push(`- **${n.title}** — ${text}${tail} \`(${src})\`${flag}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────
// Single-file HTML export — for readers who won't browse markdown.
// A focused renderer for the markdown WE emit (headings, lists, tables, code, links, emphasis).
// ─────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const anchorFor = (p: string): string => '#' + slug(p.replace(/\.md$/, ''));

function inlineMd(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string, href: string) =>
      /^https?:/.test(href) ? `<a href="${href}">${t}</a>` : `<a href="${anchorFor(href)}">${t}</a>`,
    );
}

function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let i = 0;
  let list = false;
  const closeList = (): void => {
    if (list) {
      out.push('</ul>');
      list = false;
    }
  };
  while (i < lines.length) {
    const ln = lines[i]!;
    if (/^\|/.test(ln)) {
      closeList();
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i]!)) {
        const cells = lines[i]!.split('|').slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push('<table><thead><tr>' + (head ?? []).map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of body) out.push('<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>');
      out.push('</tbody></table>');
      continue;
    }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1]!.length}>${inlineMd(h[2]!)}</h${h[1]!.length}>`);
    } else if (/^-\s+/.test(ln)) {
      if (!list) {
        out.push('<ul>');
        list = true;
      }
      out.push(`<li>${inlineMd(ln.replace(/^-\s+/, ''))}</li>`);
    } else if (ln.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inlineMd(ln)}</p>`);
    }
    i++;
  }
  closeList();
  return out.join('\n');
}

/** Render every wiki page into ONE self-contained HTML file (no external assets, opens by double-click). */
export function renderWikiHtml(files: WikiFile[], projectName: string): string {
  const nav = files
    .map((f) => `<a href="${anchorFor(f.path)}">${esc(f.path === 'index.md' ? 'Обзор' : f.path.replace(/^modules\/|\.md$/g, ''))}</a>`)
    .join('');
  const body = files
    .map((f) => `<section id="${slug(f.path.replace(/\.md$/, ''))}">${mdToHtml(f.content)}</section>`)
    .join('\n<hr/>\n');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(projectName)} — вики</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e5e5e5;--accent:#0b62d6;--code:#f5f5f5}
@media(prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e8e8e8;--muted:#9aa0a6;--line:#2c2f34;--accent:#7fb0ff;--code:#1e2126}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{display:flex;gap:2rem;max-width:1100px;margin:0 auto;padding:1.5rem}
nav{position:sticky;top:1.5rem;align-self:flex-start;min-width:210px;max-height:90vh;overflow:auto;border-right:1px solid var(--line);padding-right:1rem}
nav a{display:block;padding:.25rem 0;color:var(--accent);text-decoration:none;font-size:.9rem;word-break:break-word}
main{flex:1;min-width:0}
h1{font-size:1.6rem;margin:.2em 0 .6em}h2{font-size:1.15rem;margin:1.6em 0 .5em;border-bottom:1px solid var(--line);padding-bottom:.25em}
code{background:var(--code);padding:.1em .35em;border-radius:4px;font-size:.87em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
em{color:var(--muted);font-style:normal;font-size:.9em}
ul{padding-left:1.2rem}li{margin:.25em 0}
table{border-collapse:collapse;width:100%;margin:1em 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:.45em .6em;text-align:left;font-size:.92em}
th{background:var(--code)}
hr{border:0;border-top:1px solid var(--line);margin:2.5rem 0}
a{color:var(--accent)}
section{scroll-margin-top:1rem}
</style></head><body><div class="wrap"><nav>${nav}</nav><main>${body}</main></div></body></html>`;
}

/** Marker that identifies a wiki folder as ours — we only ever wipe a folder we generated. */
export const WIKI_MARKER = '.repobrain-wiki';

export class WikiDirNotOursError extends Error {}

/** True if `dir` doesn't exist yet, or exists and was generated by us. */
export function wikiDirIsOurs(dir: string): boolean {
  return !existsSync(dir) || existsSync(join(dir, WIKI_MARKER));
}

/**
 * Generate the wiki and write it to `outDir`. Regenerating replaces the previous output, so we only
 * clear a directory that carries our marker — never someone's hand-written `wiki/` folder.
 * Pass `force` to take over an existing directory anyway.
 */
export function writeWiki(
  store: GraphStore,
  root: string,
  outDir: string,
  opts: GenerateWikiOptions & { force?: boolean } = {},
): WikiFile[] {
  if (!opts.force && !wikiDirIsOurs(outDir)) {
    throw new WikiDirNotOursError(
      `${outDir} already exists and was not generated by RepoBrain — refusing to overwrite it. ` +
        `Use --out <dir> for a different location, or --force to take it over.`,
    );
  }
  const wiki = generateWiki(store, root, opts);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, WIKI_MARKER), 'Generated by RepoBrain (`repobrain wiki`). Safe to delete.\n', 'utf8');
  for (const f of wiki) {
    const abs = join(outDir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
  }
  if (opts.html) {
    const name = opts.projectName ?? root.split('/').filter(Boolean).pop() ?? 'project';
    writeFileSync(join(outDir, 'index.html'), renderWikiHtml(wiki, name), 'utf8');
  }
  return wiki;
}
