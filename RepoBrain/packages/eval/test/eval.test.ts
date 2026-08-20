import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { loadTasks, runEval } from '../src/index.js';

const tsExample = join(process.cwd(), 'examples/typescript-app');

describe('eval harness', () => {
  it('loads cross-language golden tasks', () => {
    const tasks = loadTasks(tsExample);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks.filter((t) => t.cross_language).length).toBeGreaterThanOrEqual(2);
    expect(tasks[0]!.gold_files.length).toBeGreaterThan(0);
  });

  // Full recall check requires the embedding model → opt in with RB_EMBED_IT=1.
  describe.runIf(process.env.RB_EMBED_IT === '1')('recall@budget (with embeddings)', () => {
    it('passes recall thresholds on the TS example', async () => {
      const dbPath = join(tmpdir(), 'rb-eval-it.sqlite');
      for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
      const rep = await runEval({ exampleDir: tsExample, dbPath, budget: 8000, model: 'generic', reindex: true });
      expect(rep.embeddingsAvailable).toBe(true);
      expect(rep.recall).toBeGreaterThanOrEqual(0.8);
      expect(rep.crossLangRecall).toBeGreaterThanOrEqual(0.7);
      expect(rep.passed).toBe(true);
    }, 120_000);
  });
});
