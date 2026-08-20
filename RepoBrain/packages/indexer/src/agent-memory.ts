import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import type { GraphStore } from '@repobrain/graph-store';
import { stripFrontmatter } from './second-brain.js';
import { checkableRef, extractCodeRefs } from './staleness.js';

export interface IngestAgentMemoryOptions {
  dir?: string;
  onProgress?: (msg: string) => void;
}

export interface IngestAgentMemoryResult {
  dir: string;
  notes: number;
  skipped: number;
}

const SKELETON = /^(MEMORY|README)\.md$|_example\.md$/i;

export function resolveAgentMemoryDir(root: string, dir?: string): string | null {
  const abs = dir ? (dir.startsWith(sep) ? dir : join(root, dir)) : join(root, 'memory');
  if (!existsSync(abs)) return null;
  try {
    return statSync(abs).isDirectory() ? abs : null;
  } catch {
    return null;
  }
}

export function isAgentMemoryFile(name: string): boolean {
  return /\.md$/i.test(name) && !SKELETON.test(name);
}

export function ingestAgentMemory(
  store: GraphStore,
  root: string,
  opts: IngestAgentMemoryOptions = {},
): IngestAgentMemoryResult | null {
  const log = opts.onProgress ?? ((): void => {});
  const dir = resolveAgentMemoryDir(root, opts.dir);
  if (!dir) return null;

  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return null;
  }
  const files = entries.filter(isAgentMemoryFile).map((name) => join(dir, name));

  const removed = store.deleteMemoriesByType('agent_memory');
  if (removed) log(`agent-memory: cleared ${removed} stale records`);

  let notes = 0;
  let skipped = 0;
  store.transaction(() => {
    for (const abs of files) {
      let raw: string;
      try {
        raw = readFileSync(abs, 'utf8');
      } catch {
        skipped++;
        continue;
      }
      const { frontmatter, body } = stripFrontmatter(raw);
      if (!body.trim()) {
        skipped++;
        continue;
      }
      const rel = relative(root, abs);
      store.insertMemory({
        type: 'agent_memory',
        title: memoryTitle(frontmatter, body, abs),
        body,
        related_files: extractCodeRefs(body).filter(checkableRef),
        related_symbols: [],
        tags: [rel, memoryType(frontmatter, abs)].filter(Boolean),
        stale_status: 'fresh',
      });
      notes++;
    }
  });

  log(`agent-memory: ingested ${notes} records from ${relative(root, dir) || dir}`);
  return { dir, notes, skipped };
}

function memoryTitle(frontmatter: string, body: string, abs: string): string {
  const name = frontmatter.match(/^name:\s*(.+?)\s*$/m);
  if (name?.[1]) return name[1].replace(/^["']|["']$/g, '').trim().slice(0, 120);
  const h1 = body.match(/^#\s+(.+?)\s*$/m);
  if (h1?.[1]) return h1[1].trim().slice(0, 120);
  return basename(abs, extname(abs));
}

function memoryType(frontmatter: string, abs: string): string {
  const declared = frontmatter.match(/^\s*type:\s*(user|feedback|project|reference)\s*$/m);
  if (declared?.[1]) return declared[1];
  const prefix = basename(abs, extname(abs)).split(/[_-]/)[0] ?? '';
  return /^(user|feedback|project|reference)$/.test(prefix) ? prefix : '';
}
