import { createHash } from 'node:crypto';

/** Stable content hash for incremental indexing (spec §0.1.5). */
export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Short hash for logs/ids. */
export function shortHash(content: string | Buffer): string {
  return hashContent(content).slice(0, 12);
}
