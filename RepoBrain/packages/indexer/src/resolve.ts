import posix from 'node:path/posix';
import type { TagsDialect } from './languages.js';

const TS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const TS_INDEX = TS_EXTS.map((e) => '/index' + e);

/**
 * Resolve an import specifier to an indexed repo file path (POSIX, repo-relative).
 * Bare/external specifiers (npm packages, stdlib) return null.
 */
export function resolveImport(
  fromRel: string,
  spec: string,
  fileSet: Set<string>,
  dialect: TagsDialect,
): string | null {
  if (dialect === 'python') return resolvePython(fromRel, spec, fileSet);
  return resolveTsJs(fromRel, spec, fileSet);
}

function firstExisting(candidates: string[], fileSet: Set<string>): string | null {
  for (const c of candidates) {
    const norm = c.replace(/^\.\//, '');
    if (fileSet.has(norm)) return norm;
  }
  return null;
}

function resolveTsJs(fromRel: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null; // bare import → external
  const base = posix.dirname(fromRel);
  const resolved = posix.normalize(posix.join(base, spec));
  // TS ESM writes `./x.js` for a `./x.ts` source — strip a JS/TS ext and re-try all exts.
  const withoutExt = resolved.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, '');
  const candidates = [
    resolved,
    ...TS_EXTS.map((e) => withoutExt + e),
    ...TS_EXTS.map((e) => resolved + e),
    ...TS_INDEX.map((s) => withoutExt + s),
    ...TS_INDEX.map((s) => resolved + s),
  ];
  return firstExisting(candidates, fileSet);
}

function resolvePython(fromRel: string, spec: string, fileSet: Set<string>): string | null {
  const base = posix.dirname(fromRel);
  if (spec.startsWith('.')) {
    // relative import: leading dots = levels up (1 dot = current package)
    let dots = 0;
    while (dots < spec.length && spec[dots] === '.') dots++;
    const remainder = spec.slice(dots).replace(/\./g, '/');
    let dir = base;
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
    const resolved = remainder ? posix.normalize(posix.join(dir, remainder)) : dir;
    return firstExisting([resolved + '.py', resolved + '/__init__.py'], fileSet);
  }
  // absolute dotted: try a few common roots
  const asPath = spec.replace(/\./g, '/');
  const prefixes = ['', 'src/', 'src/app/', 'app/'];
  const candidates: string[] = [];
  for (const p of prefixes) {
    candidates.push(p + asPath + '.py', p + asPath + '/__init__.py');
  }
  return firstExisting(candidates, fileSet);
}

export function isTestPath(rel: string): boolean {
  return (
    /\.(test|spec)\.[tj]sx?$/.test(rel) ||
    /(^|\/)tests?\//.test(rel) ||
    /(^|\/)test_[^/]+\.py$/.test(rel) ||
    /_test\.py$/.test(rel)
  );
}
