import { Parser, Language, Query } from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;

/** Initialize the WASM runtime once (locates the core tree-sitter.wasm). */
export function initParser(): Promise<void> {
  if (!initPromise) {
    const wtsDir = dirname(require.resolve('web-tree-sitter'));
    initPromise = Parser.init({ locateFile: (f: string) => join(wtsDir, f) });
  }
  return initPromise;
}

const langCache = new Map<string, Language>();

/** Load a grammar by its wasm filename under tree-sitter-wasms/out/. Cached. */
export async function loadGrammar(wasmFile: string): Promise<Language> {
  let lang = langCache.get(wasmFile);
  if (!lang) {
    await initParser();
    const wasmPath = require.resolve('tree-sitter-wasms/out/' + wasmFile);
    lang = await Language.load(wasmPath);
    langCache.set(wasmFile, lang);
  }
  return lang;
}

const parserCache = new Map<string, Parser>();

async function parserFor(wasmFile: string): Promise<Parser> {
  let p = parserCache.get(wasmFile);
  if (!p) {
    const lang = await loadGrammar(wasmFile);
    p = new Parser();
    p.setLanguage(lang);
    parserCache.set(wasmFile, p);
  }
  return p;
}

/** Parse source with the given grammar. Throws on failure. */
export async function parseSource(source: string, wasmFile: string): Promise<Tree> {
  const p = await parserFor(wasmFile);
  const tree = p.parse(source);
  if (!tree) throw new Error(`tree-sitter parse returned null (${wasmFile})`);
  return tree;
}

const queryCache = new Map<string, Query>();

/** Compile (and cache) a query against a grammar. Throws if the query is invalid. */
export async function compileQuery(wasmFile: string, key: string, scm: string): Promise<Query> {
  const cacheKey = `${wasmFile}::${key}`;
  let q = queryCache.get(cacheKey);
  if (!q) {
    const lang = await loadGrammar(wasmFile);
    q = new Query(lang, scm);
    queryCache.set(cacheKey, q);
  }
  return q;
}
