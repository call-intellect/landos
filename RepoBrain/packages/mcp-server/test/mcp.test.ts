/**
 * Golden-transcript tests for the MCP tool handlers.
 *
 * We index the `examples/typescript-app` fixture into a throwaway SQLite db
 * WITHOUT embeddings (`embed:false`) — fast, deterministic, no model download —
 * open a real RepoBrain over it, and assert each handler's envelope both PARSES
 * against the shared Zod schema and satisfies a key expectation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexRepo } from '@repobrain/indexer';
import { RepoBrain } from '@repobrain/core';
import { EnvelopeSchema } from '../src/envelope.js';
import {
  searchCode,
  findSymbol,
  getFileOverview,
  getCallees,
  getImpact,
  makeContextCapsule,
} from '../src/handlers.js';

const exampleRoot = join(process.cwd(), 'examples', 'typescript-app');

let brain: RepoBrain;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'repobrain-mcp-'));
  const dbPath = join(tmpDir, 'graph.sqlite');
  await indexRepo({ root: exampleRoot, dbPath, full: true, embed: false });
  brain = await RepoBrain.open(exampleRoot, { dbPath, embed: false });
}, 120_000);

afterAll(() => {
  brain?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('mcp-server golden transcripts', () => {
  it('search_code → valid envelope with freshness', async () => {
    const env = await searchCode(brain, { query: 'create lead' });
    expect(() => EnvelopeSchema.parse(env)).not.toThrow();
    expect(env.freshness).toBeDefined();
    expect(typeof env.summary).toBe('string');
  });

  it('find_symbol("createLead") → item whose symbol includes createLead', () => {
    const env = findSymbol(brain, { name: 'createLead' });
    expect(() => EnvelopeSchema.parse(env)).not.toThrow();
    expect(env.items.some((i) => (i.symbol ?? '').includes('createLead'))).toBe(true);
  });

  it('get_file_overview(createLead.ts) → non-empty symbols', () => {
    const env = getFileOverview(brain, { path: 'src/modules/leads/createLead.ts' });
    expect(() => EnvelopeSchema.parse(env)).not.toThrow();
    expect(env.items.length).toBeGreaterThan(0);
    expect(env.freshness).toBeDefined();
  });

  it('get_callees("createLead") → includes sendLeadToCrm', () => {
    const env = getCallees(brain, { target: 'createLead' });
    expect(() => EnvelopeSchema.parse(env)).not.toThrow();
    expect(env.items.some((i) => (i.symbol ?? '').includes('sendLeadToCrm'))).toBe(true);
  });

  it('get_impact("createLead") → valid envelope', () => {
    const env = getImpact(brain, { target: 'createLead' });
    expect(() => EnvelopeSchema.parse(env)).not.toThrow();
    expect(env.freshness).toBeDefined();
  });

  it('make_context_capsule({task}) → non-empty items', async () => {
    const env = await makeContextCapsule(brain, { task: 'add phone to lead' });
    expect(() => EnvelopeSchema.parse(env)).not.toThrow();
    expect(env.items.length).toBeGreaterThan(0);
    expect(env.freshness).toBeDefined();
    expect(env.token_estimate).toBeGreaterThan(0);
  });
});
