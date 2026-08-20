import type { Node } from 'web-tree-sitter';
import type { SymbolKind, Visibility } from '@repobrain/shared';
import type { TagsDialect } from './languages.js';
import { parseSource, compileQuery } from './parser.js';
import { tagsQuery, importQuery, routeQuery } from './queries.js';

export interface ExtractedSymbol {
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  signature: string;
  docstring: string | null;
  start_line: number; // 1-based
  end_line: number;
  visibility: Visibility;
  exported: boolean;
}

export interface ExtractedRef {
  name: string;
  line: number; // 1-based
}

export interface ExtractedImport {
  source: string; // raw module specifier (quotes/whitespace stripped)
  line: number;
}

export interface ExtractedRoute {
  method: string; // GET/POST/... or 'ANY'
  path: string;
  framework: string;
  line: number;
}

export interface FileExtraction {
  symbols: ExtractedSymbol[];
  refs: ExtractedRef[];
  imports: ExtractedImport[];
  routes: ExtractedRoute[];
  exportedNames: string[];
  parseError: boolean;
}

const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'head', 'options']);

const CAPTURE_TO_KIND: Record<string, SymbolKind> = {
  'definition.function': 'function',
  'definition.method': 'method',
  'definition.class': 'class',
  'definition.interface': 'interface',
  'definition.type': 'type',
  'definition.enum': 'type',
  'definition.field': 'variable',
  'definition.variable': 'variable',
};

// kinds that should always be kept even when nested; plain vars are kept only at top level
const KEEP_WHEN_NESTED = new Set<SymbolKind>([
  'function', 'method', 'class', 'interface', 'type', 'constant',
]);

const KIND_PRIORITY: Record<SymbolKind, number> = {
  module: 0, class: 6, interface: 6, type: 5, function: 7, method: 7,
  route_handler: 7, test_case: 4, constant: 3, variable: 1,
};

function firstLineSignature(node: Node, source: string): string {
  const text = source.slice(node.startIndex, node.endIndex);
  let sig = (text.split('\n')[0] ?? '').trim();
  if (sig.endsWith('{')) sig = sig.slice(0, -1).trim();
  return sig.slice(0, 200);
}

/** Walk ancestors to the enclosing class name, if any. */
function enclosingClassName(node: Node): string | null {
  let p = node.parent;
  while (p) {
    if (p.type === 'class_declaration' || p.type === 'class_definition' || p.type === 'abstract_class_declaration') {
      const nameNode = p.childForFieldName('name');
      if (nameNode) return nameNode.text;
    }
    p = p.parent;
  }
  return null;
}

function isExportedTs(node: Node): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === 'export_statement') return true;
    // stop climbing past the top-level statement
    if (p.type === 'program') break;
    p = p.parent;
  }
  return false;
}

/** True if the def is nested inside a function/method body (a local declaration). */
function isNestedInFunctionBody(node: Node): boolean {
  let p = node.parent;
  while (p) {
    if (
      p.type === 'function_declaration' ||
      p.type === 'function_definition' ||
      p.type === 'method_definition' ||
      p.type === 'arrow_function' ||
      p.type === 'function_expression'
    ) {
      return true;
    }
    p = p.parent;
  }
  return false;
}

/** Leading line/JSDoc comment above a node (TS/JS/py-friendly heuristic). */
function leadingComment(node: Node, lines: string[]): string | null {
  const startRow = node.startPosition.row;
  const collected: string[] = [];
  for (let r = startRow - 1; r >= 0; r--) {
    const line = (lines[r] ?? '').trim();
    if (line === '') {
      if (collected.length === 0) continue; // allow one blank between comment and decl
      break;
    }
    if (/^(\/\/|\/\*\*?|\*\/?|#)/.test(line)) {
      collected.push(line.replace(/^(\/\/+|\/\*\*?|\*\/|\*|#)\s?/, '').trim());
    } else {
      break;
    }
  }
  if (collected.length === 0) return null;
  return collected.reverse().join(' ').replace(/\*\/\s*$/, '').trim().slice(0, 300) || null;
}

/**
 * Collect comment text from WITHIN a definition's body (inline/body comments),
 * which the leading-comment heuristic misses. Critical for bilingual repos where
 * the natural-language explanation (often Russian) lives inside method bodies —
 * folding it into the embedded/FTS'd text is what lets a Russian task reach the
 * English symbol (proven: +100% cosine margin over an unrelated file). Bounded
 * in count + length so a large body cannot dominate the passage.
 */
function collectBodyComments(defNode: Node): string {
  const out: string[] = [];
  const stack: Node[] = [defNode];
  let budget = 6; // at most a handful of comments per symbol
  while (stack.length && budget > 0) {
    const node = stack.pop()!;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (!c) continue;
      if (c.type === 'comment') {
        const text = c.text.replace(/^(\/\/+|\/\*\*?|\*\/|\*|#)\s?/gm, '').replace(/\*\/\s*$/, '').replace(/\s+/g, ' ').trim();
        if (text) {
          out.push(text);
          if (--budget <= 0) break;
        }
      } else {
        stack.push(c);
      }
    }
  }
  return out.join(' ').slice(0, 240);
}

/** Merge leading + body comments into one doc string (deduped, bounded). */
function mergeDoc(leading: string | null, body: string): string | null {
  const parts: string[] = [];
  if (leading) parts.push(leading);
  if (body && (!leading || !leading.includes(body.slice(0, 24)))) parts.push(body);
  const merged = parts.join(' ').trim().slice(0, 400);
  return merged || null;
}

/** Python docstring: first string statement inside the body. */
function pythonDocstring(defNode: Node): string | null {
  const body = defNode.childForFieldName('body');
  if (!body) return null;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    if (child.type === 'expression_statement') {
      const s = child.namedChild(0);
      if (s && (s.type === 'string')) {
        return s.text.replace(/^[rbuf]*['"]{1,3}/i, '').replace(/['"]{1,3}$/, '').trim().slice(0, 300) || null;
      }
    }
    break; // only the first statement can be a docstring
  }
  return null;
}

function visibilityOf(node: Node, dialect: TagsDialect, name: string, exported: boolean): Visibility {
  if (dialect === 'python') return name.startsWith('_') ? 'private' : 'public';
  // TS: accessibility_modifier child on class members
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === 'accessibility_modifier') {
      const t = c.text;
      if (t === 'private' || t === 'protected' || t === 'public') return t;
    }
  }
  return exported ? 'public' : 'unknown';
}

const DECLARATION_NAME_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
]);

function collectBindingNames(node: Node, out: string[]): void {
  if (node.type === 'identifier') {
    out.push(node.text);
    return;
  }
  if (node.type === 'shorthand_property_identifier_pattern') {
    out.push(node.text);
    return;
  }
  if (node.type === 'pair_pattern') {
    const value = node.childForFieldName('value');
    if (value) collectBindingNames(value, out);
    return;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) collectBindingNames(c, out);
  }
}

function collectExportedNames(root: Node): string[] {
  const out: string[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type !== 'export_statement') {
        stack.push(child);
        continue;
      }
      const inner: Node[] = [child];
      while (inner.length) {
        const n = inner.pop()!;
        if (n.type === 'export_specifier') {
          const named = n.childForFieldName('alias') ?? n.childForFieldName('name');
          if (named) out.push(named.text);
          continue;
        }
        if (DECLARATION_NAME_TYPES.has(n.type)) {
          const named = n.childForFieldName('name');
          if (named) out.push(named.text);
          continue;
        }
        if (n.type === 'variable_declarator') {
          const named = n.childForFieldName('name');
          if (named) collectBindingNames(named, out);
          continue;
        }
        for (let k = 0; k < n.namedChildCount; k++) {
          const c = n.namedChild(k);
          if (c) inner.push(c);
        }
      }
    }
  }
  return [...new Set(out)];
}

export async function extractFile(
  source: string,
  dialect: TagsDialect,
  wasmFile: string,
): Promise<FileExtraction> {
  const tree = await parseSource(source, wasmFile);
  const root = tree.rootNode;
  const parseError = root.hasError;
  const lines = source.split('\n');

  const symbolsByStart = new Map<number, ExtractedSymbol>();
  const refs: ExtractedRef[] = [];

  const tagsQ = await compileQuery(wasmFile, 'tags:' + dialect, tagsQuery(dialect));
  for (const match of tagsQ.matches(root)) {
    let nameNode: Node | null = null;
    let kindCapture: string | null = null;
    let defNode: Node | null = null;
    for (const cap of match.captures) {
      if (cap.name === 'name') nameNode = cap.node;
      else {
        kindCapture = cap.name;
        defNode = cap.node;
      }
    }
    if (!nameNode || !kindCapture || !defNode) continue;
    const name = nameNode.text;

    if (kindCapture.startsWith('reference')) {
      refs.push({ name, line: nameNode.startPosition.row + 1 });
      continue;
    }
    const kind = CAPTURE_TO_KIND[kindCapture];
    if (!kind) continue;

    // filter local variables (keep functions/classes/etc even if nested)
    if (!KEEP_WHEN_NESTED.has(kind) && isNestedInFunctionBody(defNode)) continue;

    const start = defNode.startIndex;
    const exported = dialect === 'python' ? !name.startsWith('_') : isExportedTs(defNode);
    const cls = enclosingClassName(defNode);
    const sym: ExtractedSymbol = {
      name,
      qualified_name: cls ? `${cls}.${name}` : name,
      kind,
      signature: firstLineSignature(defNode, source),
      docstring: mergeDoc(
        dialect === 'python' ? pythonDocstring(defNode) : leadingComment(defNode, lines),
        collectBodyComments(defNode),
      ),
      start_line: defNode.startPosition.row + 1,
      end_line: defNode.endPosition.row + 1,
      visibility: visibilityOf(defNode, dialect, name, exported),
      exported,
    };
    // dedupe (arrow-fn declarator matches both function & variable patterns): keep higher priority
    const existing = symbolsByStart.get(start);
    if (!existing || KIND_PRIORITY[kind] > KIND_PRIORITY[existing.kind]) {
      symbolsByStart.set(start, sym);
    }
  }

  // imports
  const imports: ExtractedImport[] = [];
  const impQ = await compileQuery(wasmFile, 'imports:' + dialect, importQuery(dialect));
  for (const match of impQ.matches(root)) {
    for (const cap of match.captures) {
      if (cap.name !== 'source') continue;
      const raw = cap.node.text.replace(/^['"]|['"]$/g, '').trim();
      if (raw) imports.push({ source: raw, line: cap.node.startPosition.row + 1 });
    }
  }

  // routes
  const routes: ExtractedRoute[] = [];
  const routeQ = await compileQuery(wasmFile, 'routes:' + dialect, routeQuery(dialect));
  for (const match of routeQ.matches(root)) {
    let method: string | null = null;
    let pathNode: Node | null = null;
    for (const cap of match.captures) {
      if (cap.name === 'method') method = cap.node.text;
      else if (cap.name === 'path') pathNode = cap.node;
    }
    if (!method || !pathNode) continue;
    const rawPath = pathNode.text.replace(/^['"]|['"]$/g, '');
    if (dialect === 'python') {
      if (method !== 'route' && !HTTP_VERBS.has(method.toLowerCase())) continue;
      routes.push({ method: method === 'route' ? 'ANY' : method.toUpperCase(), path: rawPath, framework: 'flask', line: pathNode.startPosition.row + 1 });
    } else {
      if (!HTTP_VERBS.has(method.toLowerCase())) continue;
      if (!rawPath.startsWith('/')) continue;
      routes.push({ method: method.toUpperCase(), path: rawPath, framework: 'express', line: pathNode.startPosition.row + 1 });
    }
  }

  const exportedNames = dialect === 'python' ? [] : collectExportedNames(root);

  return { symbols: [...symbolsByStart.values()], refs, imports, routes, exportedNames, parseError };
}
