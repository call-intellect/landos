import { describe, it, expect } from 'vitest';
import { createEmbedder, embeddingText, EmbedderUnavailableError } from '../src/index.js';

// ── Unit tests (fast, no network, run by default) ────────────────

describe('createEmbedder', () => {
  it('rejects with EmbedderUnavailableError when offline and the model is not cached', async () => {
    await expect(
      createEmbedder({ offline: true, cacheDir: '/tmp/rb-nonexistent-xyz' }),
    ).rejects.toBeInstanceOf(EmbedderUnavailableError);
  });
});

describe('embeddingText', () => {
  it('joins [path, qualified_name||name, signature, docstring] with " \\n "', () => {
    const text = embeddingText({
      name: 'createLead',
      qualified_name: 'crm.leads.createLead',
      signature: '(input: LeadInput): Promise<Lead>',
      docstring: 'Creates a new CRM lead.',
      path: 'src/crm/leads.ts',
    });
    expect(text).toBe(
      'src/crm/leads.ts \n crm.leads.createLead \n (input: LeadInput): Promise<Lead> \n Creates a new CRM lead.',
    );
  });

  it('falls back to name when qualified_name is absent', () => {
    expect(embeddingText({ name: 'calcTax' })).toBe('calcTax');
  });

  it('skips empty / null / undefined / whitespace-only fields', () => {
    const text = embeddingText({
      name: 'calcTax',
      qualified_name: '',
      signature: null,
      docstring: '   ',
      path: 'src/tax.ts',
    });
    expect(text).toBe('src/tax.ts \n calcTax');
  });
});

// ── Integration test (real model; guarded, skipped by default) ────
// Run with: RB_EMBED_IT=1 npx vitest run packages/embeddings

/** Local cosine so the test has no dependency on the ranker package. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe.runIf(process.env.RB_EMBED_IT === '1')('embedder bridges RU query to EN code (integration)', () => {
  it('ranks a CRM-lead passage above an unrelated tax passage for a Russian query', async () => {
    // Model is cached under <cwd>/.models; offline guarantees no network.
    const embedder = await createEmbedder({ offline: true });
    expect(embedder.dim).toBe(384);

    const query = await embedder.embedQuery('заявка в CRM');
    expect(query).toHaveLength(384);

    const [createLead, calcTax] = await embedder.embedPassages([
      embeddingText({
        name: 'createLead',
        qualified_name: 'crm.leads.createLead',
        signature: '(input: LeadInput): Promise<Lead>',
        docstring: 'Create a new lead in the CRM from an incoming request.',
        path: 'src/crm/leads.ts',
      }),
      embeddingText({
        name: 'calcTax',
        qualified_name: 'billing.tax.calcTax',
        signature: '(amount: number, rate: number): number',
        docstring: 'Compute the tax owed for a given amount.',
        path: 'src/billing/tax.ts',
      }),
    ]);

    const simLead = cosine(query, createLead!);
    const simTax = cosine(query, calcTax!);
    expect(simLead).toBeGreaterThan(simTax);
  }, 60_000);
});
