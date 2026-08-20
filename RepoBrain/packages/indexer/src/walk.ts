import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { Ignorer } from './ignore.js';

export interface WalkedFile {
  absPath: string;
  relPath: string; // POSIX, repo-relative
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  maxSizeBytes?: number; // default 512 KiB
}

const DEFAULT_MAX = 512 * 1024;

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Recursively walk `root`, yielding non-ignored, size-bounded files. */
export async function* walk(
  root: string,
  ignorer: Ignorer,
  opts: WalkOptions = {},
): AsyncGenerator<WalkedFile> {
  const maxSize = opts.maxSizeBytes ?? DEFAULT_MAX;
  yield* walkDir(root, root, ignorer, maxSize);
}

async function* walkDir(
  root: string,
  dir: string,
  ignorer: Ignorer,
  maxSize: number,
): AsyncGenerator<WalkedFile> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // deterministic order
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignorer.shouldIgnoreDir(toPosix(relative(root, abs)))) continue;
      yield* walkDir(root, abs, ignorer, maxSize);
    } else if (entry.isFile()) {
      const rel = toPosix(relative(root, abs));
      if (ignorer.shouldIgnoreFile(rel)) continue;
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.size > maxSize) continue;
      yield { absPath: abs, relPath: rel, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
}

/** Cheap binary sniff: a NUL byte in the first 8 KiB → treat as binary. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
