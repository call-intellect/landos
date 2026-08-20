import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { indexRepo } from '../src/index.js';
import { detectFileRoutes } from '../src/file-routes.js';

const addresses = (relPath: string, exported: string[] = []) =>
  detectFileRoutes(relPath, exported).map((r) => `${r.method} ${r.path}`);

describe('Next.js App Router: address from the file path', () => {
  const cases: [string, string[], string[]][] = [
    ['src/app/page.tsx', [], ['GET /']],
    ['src/app/pay/mock/[purchaseId]/page.tsx', [], ['GET /pay/mock/:purchaseId']],
    ['src/app/(marketing)/about/page.tsx', [], ['GET /about']],
    ['src/app/docs/[[...slug]]/page.tsx', [], ['GET /docs/*slug?']],
    ['src/app/blog/[...slug]/page.tsx', [], ['GET /blog/*slug']],
    ['apps/openpage-api/app/growth/route.ts', ['GET', 'OPTIONS'], ['GET /growth', 'OPTIONS /growth']],
    ['apps/openpage-api/app/route.ts', ['GET'], ['GET /']],
    ['src/app/api/checkout/route.ts', ['POST', 'helper'], ['POST /api/checkout']],
  ];

  for (const [path, exported, expected] of cases) {
    it(`${path} → ${expected.join(', ') || '—'}`, () => {
      expect(addresses(path, exported)).toEqual(expected);
    });
  }

  it('uses the last app segment, so apps/<name>/app/... works', () => {
    expect(addresses('apps/docs/src/app/(home)/page.tsx')).toEqual(['GET /']);
  });
});

describe('Next.js App Router: what is NOT a route', () => {
  const negatives: [string, string[]][] = [
    ['src/app/layout.tsx', []],
    ['src/app/template.tsx', []],
    ['src/app/loading.tsx', []],
    ['src/app/error.tsx', []],
    ['src/app/not-found.tsx', []],
    ['src/app/global-error.tsx', []],
    ['src/app/default.tsx', []],
    ['src/app/middleware.ts', []],
    ['src/app/@modal/page.tsx', []],
    ['src/app/feed/(.)photo/page.tsx', []],
    ['src/app/feed/(..)photo/page.tsx', []],
    ['src/app/feed/(...)photo/page.tsx', []],
    ['src/app/_private/page.tsx', []],
    ['src/app/api/thing/route.ts', []],
    ['src/app/api/thing/route.ts', ['helper', 'config']],
    ['src/lib/payments/webhook-handler.ts', ['GET']],
    ['src/app/api/thing/handler.ts', ['GET']],
  ];

  for (const [path, exported] of negatives) {
    it(`${path} (экспорты: ${exported.join(', ') || 'нет'}) → не маршрут`, () => {
      expect(addresses(path, exported)).toEqual([]);
    });
  }
});

describe('React Router v7 / Remix: address from the file path', () => {
  const cases: [string, string[], string[]][] = [
    ['app/routes/_marketing/index.tsx', [], ['GET /']],
    ['app/routes/users/$username.tsx', [], ['GET /users/:username']],
    ['app/routes/_seo/sitemap[.]xml.ts', [], ['GET /sitemap.xml']],
    ['app/routes/$.tsx', [], ['GET /*']],
    ['app/routes/_auth/auth.$provider/callback.ts', [], ['GET /auth/:provider/callback']],
    ['app/routes/users/$username/notes/$noteId_.edit.tsx', [], ['GET /users/:username/notes/:noteId/edit']],
    ['app/routes/settings/profile/change-email.tsx', ['action'], ['GET /settings/profile/change-email', 'POST /settings/profile/change-email']],
    ['apps/remix/app/routes/_authenticated+/admin+/documents.$id.tsx', [], ['GET /admin/documents/:id']],
    ['apps/remix/app/routes/_authenticated+/o.$orgUrl.settings.billing.tsx', [], ['GET /o/:orgUrl/settings/billing']],
    ['apps/remix/app/routes/_internal+/[__htmltopdf]+/audit-log.tsx', [], ['GET /__htmltopdf/audit-log']],
    ['apps/remix/app/routes/_authenticated+/admin+/_layout.tsx', [], ['GET /admin']],
    ['apps/remix/app/routes/_authenticated+/admin+/_index.tsx', [], ['GET /admin']],
  ];

  for (const [path, exported, expected] of cases) {
    it(`${path} → ${expected.join(', ')}`, () => {
      expect(addresses(path, exported)).toEqual(expected);
    });
  }
});

describe('React Router v7 / Remix: what is NOT a route (игнор-набор R6a)', () => {
  const negatives = [
    'app/routes/_auth/reset-password.server.ts',
    'app/routes/_auth/login.client.ts',
    'app/routes/_auth/callback.test.ts',
    'app/routes/_auth/callback.spec.ts',
    'app/routes/_marketing/__shared.tsx',
    'app/routes/_marketing/+logos/logos.ts',
    'app/routes/_marketing/+logos/docker.svg',
    'app/routes/users/$username/notes/+shared/note-editor.tsx',
    'apps/remix/app/routes/_internal+/[__htmltopdf]+/audit-log.print.css',
  ];

  for (const path of negatives) {
    it(`${path} → не маршрут`, () => {
      expect(addresses(path)).toEqual([]);
    });
  }
});

const root = join(tmpdir(), `rb-file-routes-${process.pid}`);
const dbPath = join(root, 'graph.sqlite');

describe('индексация: файловые маршруты попадают в граф, тестовые — нет', () => {
  let store: GraphStore;

  beforeAll(async () => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'src', 'app', 'pay', 'mock', '[purchaseId]'), { recursive: true });
    mkdirSync(join(root, 'src', 'app', 'api', 'checkout'), { recursive: true });
    mkdirSync(join(root, 'src', 'app', 'api', 'search'), { recursive: true });
    mkdirSync(join(root, 'src', 'app', '@modal'), { recursive: true });
    mkdirSync(join(root, 'src', 'tests', 'app'), { recursive: true });
    mkdirSync(join(root, 'app', 'routes', '_auth'), { recursive: true });

    writeFileSync(join(root, 'src', 'app', 'layout.tsx'), 'export default function Layout() { return null; }\n');
    writeFileSync(
      join(root, 'src', 'app', 'pay', 'mock', '[purchaseId]', 'page.tsx'),
      'export default function Page() { return null; }\n',
    );
    writeFileSync(
      join(root, 'src', 'app', 'api', 'checkout', 'route.ts'),
      'export async function POST(): Promise<void> {}\nexport function helper(): void {}\n',
    );
    writeFileSync(
      join(root, 'src', 'app', 'api', 'search', 'route.ts'),
      'declare function make(): { GET: () => void };\nexport const { GET } = make();\n',
    );
    writeFileSync(join(root, 'src', 'app', '@modal', 'page.tsx'), 'export default function M() { return null; }\n');
    writeFileSync(
      join(root, 'src', 'tests', 'app', 'page.tsx'),
      'export default function T() { return null; }\n',
    );
    writeFileSync(
      join(root, 'app', 'routes', '_auth', 'reset-password.server.ts'),
      'export function reset(): void {}\n',
    );
    writeFileSync(join(root, 'app', 'routes', '_auth', 'login.tsx'), 'export function action(): void {}\n');

    await indexRepo({ root, dbPath, full: true, embed: false });
    store = GraphStore.open(dbPath);
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('пишет адрес страницы Next.js', () => {
    expect(store.allRoutes().find((r) => r.path === '/pay/mock/:purchaseId' && r.method === 'GET')).toBeTruthy();
  });

  it('пишет метод по экспорту route.ts и не выдумывает лишних', () => {
    const checkout = store.allRoutes().filter((r) => r.path === '/api/checkout');
    expect(checkout.map((r) => r.method)).toEqual(['POST']);
  });

  it('видит метод, экспортированный деструктуризацией', () => {
    expect(store.allRoutes().find((r) => r.path === '/api/search' && r.method === 'GET')).toBeTruthy();
  });

  it('пишет адрес и POST для React Router при экспорте action', () => {
    const login = store.allRoutes().filter((r) => r.path === '/login');
    expect(login.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
    expect(login.every((r) => r.framework === 'react-router')).toBe(true);
  });

  it('не пишет маршрутов для layout, слотов и служебных файлов', () => {
    const paths = store.allRoutes().map((r) => r.path);
    expect(paths.some((p) => p.includes('layout'))).toBe(false);
    expect(paths.some((p) => p.includes('@'))).toBe(false);
    expect(paths.some((p) => p.includes('reset-password'))).toBe(false);
  });

  it('не пишет маршрутов для файлов из тестов (R7)', () => {
    const files = new Map(store.allFiles().map((f) => [f.id, f.path]));
    expect(store.allRoutes().some((r) => (files.get(r.file_id) ?? '').includes('src/tests'))).toBe(false);
  });

  it('повторный полный индекс не плодит дублей', async () => {
    const before = store.allRoutes().length;
    store.close();
    await indexRepo({ root, dbPath, full: true, embed: false });
    store = GraphStore.open(dbPath);
    expect(store.allRoutes().length).toBe(before);
  });
});
