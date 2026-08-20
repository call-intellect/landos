import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { GraphStore } from '@repobrain/graph-store';
import { indexRepo } from '../src/index.js';

const root = join(tmpdir(), `rb-routes-${process.pid}`);
const dbPath = join(root, 'graph.sqlite');

const SOURCE = `
const cache = new Map<string, string>();

export function boot(app: any): void {
  app.get('/health', () => 'ok');
  app.post('/leads', () => 'created');
  cache.get('imports');
  cache.set('tested_by', 'x');
}
`;

describe('express route extraction', () => {
  let store: GraphStore;

  beforeAll(async () => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'server.ts'), SOURCE, 'utf8');
    await indexRepo({ root, dbPath, full: true, embed: false });
    store = GraphStore.open(dbPath);
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('extracts real express routes', () => {
    const routes = store.allRoutes();
    expect(routes.find((r) => r.method === 'GET' && r.path === '/health')).toBeTruthy();
    expect(routes.find((r) => r.method === 'POST' && r.path === '/leads')).toBeTruthy();
  });

  it('does not mistake a plain Map.get("key") for an HTTP route', () => {
    const routes = store.allRoutes();
    expect(routes.find((r) => r.path === 'imports')).toBeUndefined();
    expect(routes.every((r) => r.path.startsWith('/'))).toBe(true);
  });
});
