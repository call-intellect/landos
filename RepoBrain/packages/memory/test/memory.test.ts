import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GraphStore } from '@repobrain/graph-store';
import { rememberDecision, searchMemory, preActionWarnings, codeQueryLanguageWarning } from '../src/index.js';

describe('memory', () => {
  let store: GraphStore;
  beforeEach(() => {
    store = GraphStore.open(':memory:');
  });
  afterEach(() => store.close());

  it('remembers a decision and finds it by search', () => {
    rememberDecision(store, {
      note: 'Phone must be normalized before CRM send',
      type: 'project_convention',
      related_files: ['src/crm.ts'],
    });
    const found = searchMemory(store, 'phone CRM normalize');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.body).toContain('normalized');
    expect(found[0]!.related_files).toContain('src/crm.ts');
  });

  it('derives a title from the note', () => {
    const id = rememberDecision(store, { note: 'Line one is the title\nrest is body' });
    const m = store.allMemories().find((x) => x.id === id)!;
    expect(m.title).toBe('Line one is the title');
    expect(m.type).toBe('agent_note');
  });

  it('surfaces pre-action warnings for known issues / failed attempts', () => {
    rememberDecision(store, { note: 'Do not call CRM sync twice, it duplicates leads', type: 'known_issue' });
    rememberDecision(store, { note: 'Tried batching CRM writes, it broke ordering', type: 'failed_attempt' });
    rememberDecision(store, { note: 'Unrelated architecture note', type: 'agent_note' });
    const warns = preActionWarnings(store, 'CRM sync leads duplicate');
    expect(warns.some((w) => w.warning.startsWith('Known issue'))).toBe(true);
  });

  it('redirects a russian-only code query to english', () => {
    const w = codeQueryLanguageWarning('страница-заглушка магазина');
    expect(w).not.toBeNull();
    expect(w!.warning).toContain('make_context_capsule');
  });

  it('stays silent for an english code query', () => {
    expect(codeQueryLanguageWarning('store stub page Home')).toBeNull();
  });

  it('stays silent for a mixed query that already carries a code identifier', () => {
    expect(codeQueryLanguageWarning('почини createLead в LeadService')).toBeNull();
  });
});
