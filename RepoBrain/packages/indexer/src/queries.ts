import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TagsDialect } from './languages.js';

/**
 * Load the vendored tags.scm files at runtime. They live at <package>/queries/ and are
 * resolved relative to this module (works from both src/ via tsx and dist/ after build,
 * since both are one level under the package root).
 */
const cache = new Map<string, string>();

function loadFile(name: string): string {
  let s = cache.get(name);
  if (s === undefined) {
    const url = new URL('../queries/' + name, import.meta.url);
    s = readFileSync(fileURLToPath(url), 'utf8');
    cache.set(name, s);
  }
  return s;
}

export function tagsQuery(dialect: TagsDialect): string {
  return loadFile(`${dialect}-tags.scm`);
}

/** Import/re-export module specifiers → file-to-file `imports` edges. */
export function importQuery(dialect: TagsDialect): string {
  if (dialect === 'python') {
    return [
      '(import_from_statement module_name: (dotted_name) @source)',
      '(import_from_statement module_name: (relative_import) @source)',
      '(import_statement name: (dotted_name) @source)',
    ].join('\n');
  }
  // typescript + javascript
  return [
    '(import_statement source: (string) @source)',
    '(export_statement source: (string) @source)',
  ].join('\n');
}

/** HTTP route declarations → routes table + get_routes. */
export function routeQuery(dialect: TagsDialect): string {
  if (dialect === 'python') {
    // Flask/FastAPI-style: @app.route("/x") / @router.get("/x")
    return '(decorator (call function: (attribute attribute: (identifier) @method) arguments: (argument_list . (string) @path)))';
  }
  // Express-style: app.get("/x", ...) / router.post("/x", ...)
  return '(call_expression function: (member_expression property: (property_identifier) @method) arguments: (arguments . (string) @path))';
}
