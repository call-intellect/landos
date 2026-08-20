import { extname } from 'node:path';
import type { Language } from '@repobrain/shared';

/** tags.scm dialect — TS and TSX share one; JS/JSX share one; Python its own. */
export type TagsDialect = 'typescript' | 'javascript' | 'python';

export interface GrammarInfo {
  language: Language;
  /** filename under node_modules/tree-sitter-wasms/out/ */
  wasm: string;
  dialect: TagsDialect;
}

const EXT_TO_LANGUAGE: Record<string, Language> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyi': 'python',
};

const LANGUAGE_TO_GRAMMAR: Record<Exclude<Language, 'unknown'>, GrammarInfo> = {
  typescript: { language: 'typescript', wasm: 'tree-sitter-typescript.wasm', dialect: 'typescript' },
  tsx: { language: 'tsx', wasm: 'tree-sitter-tsx.wasm', dialect: 'typescript' },
  javascript: { language: 'javascript', wasm: 'tree-sitter-javascript.wasm', dialect: 'javascript' },
  // the JS grammar handles JSX
  jsx: { language: 'jsx', wasm: 'tree-sitter-javascript.wasm', dialect: 'javascript' },
  python: { language: 'python', wasm: 'tree-sitter-python.wasm', dialect: 'python' },
};

export function detectLanguage(filePath: string): Language {
  return EXT_TO_LANGUAGE[extname(filePath).toLowerCase()] ?? 'unknown';
}

export function grammarFor(language: Language): GrammarInfo | null {
  if (language === 'unknown') return null;
  return LANGUAGE_TO_GRAMMAR[language];
}

/** All grammars we may need to preload. */
export function allGrammars(): GrammarInfo[] {
  return [
    LANGUAGE_TO_GRAMMAR.typescript,
    LANGUAGE_TO_GRAMMAR.tsx,
    LANGUAGE_TO_GRAMMAR.javascript,
    LANGUAGE_TO_GRAMMAR.python,
  ];
}

export function isSupported(language: Language): boolean {
  return language !== 'unknown';
}
