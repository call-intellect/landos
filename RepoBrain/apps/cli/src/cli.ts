#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, cpSync, watch, readdirSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepoBrain, NotIndexedError } from '@repobrain/core';
import { indexRepo } from '@repobrain/indexer';
import { runEval } from '@repobrain/eval';
import { packGraph, unpackGraph, SecretsInArtifactError } from '@repobrain/team-sync';
import { startMcpServer } from '@repobrain/mcp-server';
import { GraphStore } from '@repobrain/graph-store';
import { writeWiki, wikiDirIsOurs, WikiDirNotOursError } from '@repobrain/indexer';
import { loadConfig } from './config.js';

const TEMPLATES = fileURLToPath(new URL('../templates', import.meta.url));
const CLI_ENTRY = fileURLToPath(import.meta.url); // absolute path to this built cli.js

/** The MCP server invocation Claude Code / Cursor should launch. Uses the current node + the absolute
 *  cli entry (not the `repobrain` bin) so it works even when the tool isn't on PATH. */
function mcpServerEntry(repoRoot: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [CLI_ENTRY, '--cwd', repoRoot, 'mcp'] };
}

/** Merge our MCP server into an mcp.json (Claude Code / Cursor), preserving any existing servers.
 *  Returns 'created' | 'updated' | 'unchanged' | 'skipped' (skipped = existing file is unparseable). */
function mergeMcpConfig(mcpPath: string, repoRoot: string): 'created' | 'updated' | 'unchanged' | 'skipped' {
  const entry = mcpServerEntry(repoRoot);
  let doc: { mcpServers?: Record<string, unknown> } = {};
  let existed = false;
  if (existsSync(mcpPath)) {
    existed = true;
    try {
      doc = JSON.parse(readFileSync(mcpPath, 'utf8')) as typeof doc;
    } catch {
      return 'skipped'; // don't clobber a config we can't safely parse
    }
  }
  doc.mcpServers ??= {};
  const prev = JSON.stringify(doc.mcpServers['repobrain']);
  doc.mcpServers['repobrain'] = entry;
  if (existed && prev === JSON.stringify(entry)) return 'unchanged';
  mkdirSync(dirname(mcpPath), { recursive: true });
  writeFileSync(mcpPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return existed ? 'updated' : 'created';
}

function writeTemplateIfAbsent(tpl: string, destAbs: string, force: boolean): boolean {
  if (existsSync(destAbs) && !force) return false;
  // A symlink here is someone's deliberate wiring (e.g. AGENTS.md -> CLAUDE.md). Even --force
  // must not replace it: the link, not the bytes, is the thing they set up.
  if (lstatSync(destAbs, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  cpSync(join(TEMPLATES, tpl), destAbs);
  return true;
}

const program = new Command();
program
  .name('repobrain')
  .description('Local self-hosted context engine between a repo and AI coding agents')
  .version('0.1.0')
  .option('--cwd <path>', 'project root', process.cwd());

function root(): string {
  return program.opts().cwd as string;
}
function dbPathFor(r: string): string {
  return join(r, '.repobrain', 'graph.sqlite');
}
async function withBrain<T>(fn: (b: RepoBrain) => Promise<T> | T, opts: { embed?: boolean } = {}): Promise<T> {
  let brain: RepoBrain;
  try {
    brain = await RepoBrain.open(root(), { embed: opts.embed });
  } catch (e) {
    if (e instanceof NotIndexedError) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  try {
    return await fn(brain);
  } finally {
    brain.close();
  }
}

// ── init ──
program
  .command('init')
  .description('Scaffold .repobrain.yaml, AGENTS.md, .mcp.json')
  .option('-f, --force', 'overwrite existing files')
  .action((opts) => {
    const r = root();
    const files: [string, string][] = [
      ['repobrain.yaml', '.repobrain.yaml'],
      ['AGENTS.md', 'AGENTS.md'],
      ['mcp.json', '.mcp.json'],
    ];
    for (const [tpl, dest] of files) {
      const target = join(r, dest);
      if (existsSync(target) && !opts.force) {
        console.log(`· ${dest} exists (use --force to overwrite)`);
        continue;
      }
      cpSync(join(TEMPLATES, tpl), target);
      console.log(`✓ wrote ${dest}`);
    }
    console.log('\nNext: repobrain index');
  });

// ── index ──
program
  .command('index')
  .description('Build/update the code graph (incremental by default)')
  .option('--full', 'force a full re-index')
  .option('--watch', 'watch for changes and re-index')
  .option('--no-embed', 'skip semantic embeddings')
  .option('--gen-brain', 'generate a code-grounded second-brain skeleton from the graph')
  .option('--no-gen-brain', 'never generate the second-brain skeleton')
  .option('--no-wiki', 'do not refresh the human-readable wiki')
  .action(async (opts) => {
    const r = root();
    const cfg = loadConfig(r);
    // Graph-first (D18): embeddings are opt-in via config; `--no-embed` still forces off.
    const embed = opts.embed === false ? false : cfg.embeddingsEnabled;
    // AUTO by default (undefined): generate the skeleton only when no hand-written notes exist.
    const generateBrain = opts.genBrain === true ? true : opts.genBrain === false ? false : undefined;
    const res = await indexRepo({
      root: r,
      full: opts.full,
      embed,
      generateBrain,
      modelId: cfg.embeddingModel,
      onProgress: (m) => console.log('·', m),
    });
    console.log(
      `✓ ${res.mode} index: ${res.filesChanged} changed / ${res.filesUnchanged} unchanged / ${res.filesDeleted} deleted, ` +
        `${res.symbols} symbols, ${res.edges} edges, ${res.embedded} embedded, ${res.secretsFound} secrets, ${res.parseErrors} parse errors in ${res.elapsedMs}ms`,
    );
    if (res.secondBrainNotes > 0) {
      console.log(`· second-brain: ${res.secondBrainNotes} knowledge notes ingested (double search on)`);
    }
    if (res.generatedBrainCards > 0) {
      console.log(`· second-brain: ${res.generatedBrainCards} code-grounded cards generated from the graph`);
    }
    if (res.staleNotes > 0) {
      console.log(`⚠ second-brain: ${res.staleNotes} notes flagged stale (cite code that no longer exists) — review`);
    }
    // keep an existing wiki in sync with the code (only if one is already there — never create unasked)
    if (opts.wiki !== false && existsSync(wikiDirFor(r)) && wikiDirIsOurs(wikiDirFor(r))) {
      const n = buildWiki(r, wikiDirFor(r), false);
      if (n !== null) console.log(`· wiki refreshed: ${n} pages`);
    }
    if (embed && !res.embeddingsAvailable) {
      console.log('⚠ embeddings were enabled but the model is unavailable — check `embedding.model`');
    } else if (!embed) {
      console.log('· graph-first (semantic embeddings off; enable via embedding.enabled in .repobrain.yaml)');
    }
    if (opts.watch) {
      console.log('👁  watching for changes (Ctrl-C to stop)…');
      let timer: NodeJS.Timeout | null = null;
      watch(r, { recursive: true }, (_e, file) => {
        if (!file || file.includes('.repobrain') || file.includes('node_modules') || file.includes('.git/')) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          const upd = await indexRepo({ root: r, embed, modelId: cfg.embeddingModel });
          console.log(`↻ reindexed: ${upd.filesChanged} changed, ${upd.embedded} embedded`);
        }, 400);
      });
      await new Promise(() => {}); // run forever
    }
  });

// ── capsule ──
program
  .command('capsule <task>')
  .description('Build a context capsule for a task')
  .option('-b, --budget <n>', 'token budget', (v) => parseInt(v, 10))
  .option('-m, --model <model>', 'tokenizer model (claude|gpt|generic)')
  .option('--json', 'output the structured capsule as JSON')
  .action(async (task, opts) => {
    const cfg = loadConfig(root());
    await withBrain(async (brain) => {
      const { capsule, markdown } = await brain.capsule(task, {
        budget: opts.budget ?? cfg.budget,
        model: opts.model ?? cfg.model,
        weights: cfg.weights,
        noteLimit: cfg.noteLimit,
      });
      console.log(opts.json ? JSON.stringify(capsule, null, 2) : markdown);
    }, { embed: cfg.embeddingsEnabled });
  });

// ── eval ──
program
  .command('eval')
  .description('Run the eval harness (recall@budget) over example repos')
  .option('-b, --budget <n>', 'token budget', (v) => parseInt(v, 10), 8000)
  .option('-m, --model <model>', 'tokenizer model', 'generic')
  .option('-e, --example <dir>', 'a single example dir to evaluate')
  .option('--strict', 'exit non-zero if below thresholds')
  .action(async (opts) => {
    const r = root();
    const dirs: string[] = opts.example
      ? [opts.example]
      : findExampleDirs(join(r, 'examples')).length
        ? findExampleDirs(join(r, 'examples'))
        : findExampleDirs(r);
    if (dirs.length === 0) {
      console.error('✗ no example dirs with eval/tasks.yaml found');
      process.exit(2);
    }
    let allPass = true;
    for (const dir of dirs) {
      const rep = await runEval({ exampleDir: dir, budget: opts.budget, model: opts.model, reindex: true });
      console.log(`\n=== ${dir} ===`);
      for (const t of rep.tasks) {
        const tag = t.crossLanguage ? 'XLANG' : 'plain';
        console.log(`  [${tag}] recall=${t.recall.toFixed(2)} tokens=${t.capsuleTokens} — ${t.task}`);
        if (t.missedGold.length) console.log(`         missed: ${t.missedGold.join(', ')}`);
      }
      console.log(
        `  recall@${opts.budget}=${rep.recall.toFixed(3)} (≥0.8)  cross-lang=${rep.crossLangRecall.toFixed(3)} (≥0.7)  ` +
          `mean-tokens=${Math.round(rep.meanCapsuleTokens)}  PASS=${rep.passed}`,
      );
      allPass = allPass && rep.passed;
    }
    if (opts.strict && !allPass) process.exit(3);
  });

// ── mcp ──
program
  .command('mcp')
  .description('Start the MCP server (stdio)')
  .action(async () => {
    const cfg = loadConfig(root());
    await startMcpServer({ root: root(), embed: cfg.embeddingsEnabled });
  });

// ── remember / memory ──
program
  .command('remember <note>')
  .description('Write a team-memory note')
  .option('-t, --type <type>', 'memory type', 'agent_note')
  .option('--files <paths>', 'comma-separated related files')
  .action(async (note, opts) => {
    await withBrain((brain) => {
      const id = brain.remember({
        note,
        type: opts.type,
        related_files: opts.files ? String(opts.files).split(',').map((s: string) => s.trim()) : [],
      });
      console.log(`✓ saved memory #${id}`);
    }, { embed: false });
  });

program
  .command('memory <query>')
  .description('Search team memory')
  .action(async (query) => {
    await withBrain((brain) => {
      const hits = brain.teamMemory(query);
      if (hits.length === 0) return console.log('(no matching memory)');
      for (const m of hits) console.log(`- [${m.type}] ${m.title}\n    ${m.body}`);
    }, { embed: false });
  });

// ── architecture ──
program
  .command('architecture')
  .description('Print an architecture summary for the repo')
  .action(async () => {
    await withBrain((brain) => {
      const a = brain.architecture();
      console.log('# Architecture');
      console.log('Languages:', Object.entries(a.languages).map(([k, v]) => `${k}=${v}`).join(', '));
      console.log('Counts:', `${a.counts.files} files, ${a.counts.symbols} symbols, ${a.counts.edges} edges, ${a.counts.routes} routes`);
      console.log('\nModules:');
      for (const m of a.modules.slice(0, 12)) console.log(`  ${m.dir}  (${m.files} files)`);
      console.log('\nEntrypoints:', a.entrypoints.slice(0, 8).join(', ') || '(none)');
      console.log('\nMost central files:');
      for (const g of a.godFiles) console.log(`  ${g.path}  (${g.symbols} symbols, imported by ${g.importedBy})`);
    }, { embed: false });
  });

// ── pack-graph / unpack-graph ──
program
  .command('pack-graph')
  .description('Pack the code graph into a shareable, secret-free artifact')
  .action(() => {
    const r = root();
    try {
      const res = packGraph(dbPathFor(r), join(r, '.repobrain'));
      console.log(`✓ ${res.artifactPath} (${res.bytes} bytes) + ${res.manifestPath}`);
    } catch (e) {
      if (e instanceof SecretsInArtifactError) {
        console.error('✗ pack aborted — secrets found in graph:');
        for (const f of e.findings) console.error(`   ${f.where} (${f.type})`);
        process.exit(4);
      }
      throw e;
    }
  });

program
  .command('unpack-graph [artifact]')
  .description('Restore a shared graph artifact')
  .action((artifact) => {
    const r = root();
    unpackGraph(artifact ?? join(r, '.repobrain', 'graph.sqlite.zst'), dbPathFor(r));
    console.log('✓ graph restored to', dbPathFor(r));
  });

// ── stats ──
program
  .command('stats')
  .description('Show estimated tokens saved')
  .action(async () => {
    await withBrain((brain) => {
      const s = brain.tokenStats();
      console.log(`Capsules built : ${s.count}`);
      console.log(`Capsule tokens : ${s.capsule_tokens}`);
      console.log(`Naive estimate : ${s.naive_estimate}`);
      console.log(`≈ Tokens saved : ${s.saved}`);
    }, { embed: false });
  });

// ── doctor ──
program
  .command('doctor')
  .description('Health check')
  .action(async () => {
    const r = root();
    line('project root', r);
    const hasIndex = existsSync(dbPathFor(r));
    line('index', hasIndex ? 'present' : 'MISSING — run `repobrain index`');
    if (!hasIndex) return;
    const cfg = loadConfig(r);
    const brain = await RepoBrain.open(r, { embed: cfg.embeddingsEnabled });
    const fr = brain.freshness();
    line('freshness', `commit ${fr.index_commit ?? 'none'}, dirty=${fr.dirty}, changed=${fr.changed_since_index}`);
    line(
      'embeddings',
      !cfg.embeddingsEnabled
        ? 'off (graph-first default — enable via embedding.enabled in .repobrain.yaml)'
        : brain.embeddingsAvailable
          ? 'available (semantic ranking ON)'
          : 'ENABLED but model unavailable — check embedding.model',
    );
    const search = await brain.searchCode('lead', 3);
    line('search/FTS', `${search.length} results for "lead"`);
    brain.close();
  });

function line(label: string, value: string): void {
  console.log(`${label.padEnd(14)}: ${value}`);
}

function findExampleDirs(base: string): string[] {
  const out: string[] = [];
  if (!existsSync(base)) return out;
  try {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(base, entry.name, 'eval', 'tasks.yaml'))) {
        out.push(join(base, entry.name));
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

// ── setup (one-command onboarding) ──
program
  .command('setup')
  .description('One command: wire up your AI agent (Claude Code / Cursor), index, build the wiki, verify')
  .option('--no-index', 'skip the initial index')
  .option('--no-wiki', 'skip generating the human-readable wiki')
  .option('-f, --force', 'overwrite existing config/rule files')
  .action(async (opts) => {
    const r = root();
    console.log(`\n🧠 RepoBrain setup — ${r}\n`);

    // 1) config + agent rule (idempotent)
    if (writeTemplateIfAbsent('repobrain.yaml', join(r, '.repobrain.yaml'), opts.force)) console.log('✓ wrote .repobrain.yaml');
    else console.log('· .repobrain.yaml exists (kept)');
    if (writeTemplateIfAbsent('AGENTS.md', join(r, 'AGENTS.md'), opts.force)) console.log('✓ wrote AGENTS.md (agent rules: query the graph, not grep)');
    else console.log('· AGENTS.md exists (kept)');

    // 2) detect + wire agents
    const wired: string[] = [];
    const claude = mergeMcpConfig(join(r, '.mcp.json'), r);
    console.log(`✓ Claude Code MCP (.mcp.json): ${claude}`);
    if (claude !== 'skipped') wired.push('Claude Code');
    else console.log('  ⚠ .mcp.json exists but is not valid JSON — left untouched; add the "repobrain" server manually');
    const looksClaude = existsSync(join(r, '.claude')) || existsSync(join(r, 'CLAUDE.md'));
    if (looksClaude) console.log('  (detected .claude/ or CLAUDE.md — Claude Code reads AGENTS.md for the rules)');

    if (existsSync(join(r, '.cursor')) || existsSync(join(r, '.cursorrules'))) {
      const cur = mergeMcpConfig(join(r, '.cursor', 'mcp.json'), r);
      console.log(`✓ Cursor MCP (.cursor/mcp.json): ${cur}`);
      const rule = join(r, '.cursor', 'rules', 'repobrain.mdc');
      if (writeTemplateIfAbsent('AGENTS.md', rule, opts.force)) console.log('✓ wrote .cursor/rules/repobrain.mdc');
      if (cur !== 'skipped') wired.push('Cursor');
    }

    // 3) initial index (code + auto second-brain skeleton + note↔code edges)
    if (opts.index !== false) {
      console.log('\n· indexing (first run may take a moment)…');
      const cfg = loadConfig(r);
      const res = await indexRepo({ root: r, full: true, embed: cfg.embeddingsEnabled, modelId: cfg.embeddingModel, onProgress: (m) => console.log('  ·', m) });
      console.log(`✓ indexed: ${res.filesTotal} files, ${res.symbols} symbols, ${res.edges} edges` +
        (res.generatedBrainCards ? `, ${res.generatedBrainCards} knowledge cards` : '') +
        (res.secondBrainNotes ? `, ${res.secondBrainNotes} second-brain notes` : ''));

      // human-readable wiki — generated up front so it actually exists for people to read
      if (opts.wiki !== false) {
        const outDir = wikiDirFor(r);
        const n = buildWiki(r, outDir, false);
        if (n !== null) console.log(`✓ wiki: ${n} pages → ${outDir}/index.md (readable docs for people)`);
      }
    } else {
      console.log('\n· skipped indexing (run `repobrain index` when ready)');
    }

    // 4) summary + next steps
    console.log('\n────────────────────────────────────────');
    console.log(`✅ RepoBrain is set up${wired.length ? ` for ${wired.join(' + ')}` : ''}.`);
    console.log('Next:');
    console.log('  1. Restart your agent (or reload MCP) so it picks up the "repobrain" server.');
    console.log('  2. Ask it to work normally — AGENTS.md tells it to call make_context_capsule / search_code');
    console.log('     instead of grepping. It will spend far fewer tokens and find the right code.');
    console.log('  • Re-index after big changes: `repobrain index`  ·  Health check: `repobrain doctor`\n');
  });

// ── wiki (human-facing docs) ──
/** Default wiki location: a VISIBLE folder people actually open — not a hidden tech dir. */
const wikiDirFor = (r: string): string => join(r, 'wiki');

/** Generate the wiki; returns page count, or null if skipped. Never clobbers a non-RepoBrain wiki/. */
function buildWiki(r: string, outDir: string, force: boolean, html = false): number | null {
  const store = GraphStore.open(dbPathFor(r));
  try {
    return writeWiki(store, r, outDir, { force, html }).length;
  } catch (e) {
    if (e instanceof WikiDirNotOursError) {
      console.log(`· wiki skipped — ${outDir} already exists and isn't ours (use \`repobrain wiki --force\` or --out)`);
      return null;
    }
    throw e;
  } finally {
    store.close();
  }
}

program
  .command('wiki')
  .description('Generate a human-readable wiki (home + module pages) from the code graph + second brain')
  .option('--out <dir>', 'output directory (default: <repo>/wiki)', undefined)
  .option('--html', 'also write a single self-contained index.html (open by double-click)')
  .option('-f, --force', 'take over the output directory even if RepoBrain did not create it')
  .action((opts) => {
    const r = root();
    if (!existsSync(dbPathFor(r))) {
      console.error('✗ no index found — run `repobrain index` first');
      process.exit(1);
    }
    const outDir = opts.out ?? wikiDirFor(r);
    const n = buildWiki(r, outDir, opts.force === true, opts.html === true);
    if (n !== null) {
      console.log(`✓ wiki generated: ${n} pages → ${outDir}`);
      console.log(`  open ${join(outDir, opts.html === true ? 'index.html' : 'index.md')}`);
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error('✗', e?.message ?? e);
  process.exit(1);
});
