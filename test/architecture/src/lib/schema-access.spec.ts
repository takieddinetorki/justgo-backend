/**
 * Fitness function (§18): a module's SQL may reference only its OWN schema.
 * No cross-module database access, ever (§17.4). Modules live under
 * libs/platform/<name>, libs/verticals/<name>, libs/crosscutting/<name> and
 * own the Postgres schema of the same name.
 */
import { readFileSync } from 'node:fs';
import { relToRoot, sourceFiles, workspacePackages } from './workspace';

/** schemas that every module may reference in its own copy (same shape) */
const SHARED_TABLE_NAMES = ['outbox'];

/** SQL keywords that precede a `<schema>.<table>` reference. `on`/`where`
 * clauses are excluded — they reference table ALIASES, not schemas. */
const SQL_REF_RE =
  /\b(?:from|join|into|update|truncate(?:\s+table)?|table(?:\s+if\s+not\s+exists)?)\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi;

const MODULE_ROOTS = ['libs/platform/', 'libs/verticals/', 'libs/crosscutting/'];

/**
 * All real SQL in this codebase lives in backtick template literals passed to
 * `.query(...)`. Scanning only those spans keeps the matcher from tripping on
 * event-type strings ('suppliers.SupplierRegistered'), comments, or test
 * descriptions ("builds the index from suppliers.SupplierRegistered") that
 * merely read like SQL. Extract each backtick span's contents.
 */
function sqlSpans(source: string): string[] {
  return [...source.matchAll(/`([^`]*)`/gs)].map((m) => m[1]);
}

/** All cross-schema-shaped references found in a file's SQL spans. */
export function schemaTableRefs(source: string): { schema: string; table: string }[] {
  const refs: { schema: string; table: string }[] = [];
  for (const span of sqlSpans(source)) {
    for (const match of span.matchAll(SQL_REF_RE)) {
      refs.push({ schema: match[1], table: match[2] });
    }
  }
  return refs;
}

describe('architecture: schema ownership', () => {
  const modules = workspacePackages().filter((p) =>
    MODULE_ROOTS.some((root) => relToRoot(p.dir).startsWith(root)),
  );
  // Only names that ARE module schemas can be violations — anything else
  // matched by the regex is a table alias or CTE name.
  const knownSchemas = new Set([
    ...modules.map((m) => relToRoot(m.dir).split('/').pop()?.replace(/-/g, '_') as string),
    'demo',
  ]);

  it('module SQL references only the module-owned schema', () => {
    const violations: string[] = [];
    for (const mod of modules) {
      const ownSchema = relToRoot(mod.dir).split('/').pop()?.replace(/-/g, '_');
      for (const file of sourceFiles(mod.dir)) {
        const source = readFileSync(file, 'utf8');
        for (const { schema, table } of schemaTableRefs(source)) {
          if (schema === ownSchema || !knownSchemas.has(schema)) continue;
          if (SHARED_TABLE_NAMES.includes(table) && schema === ownSchema) continue;
          violations.push(
            `${relToRoot(file)} references "${schema}.${table}" but owns schema "${ownSchema}"`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('is armed: catches real cross-schema SQL', () => {
    const src = 'const q = `select * from requests.quotes q join orders.orders o on q.id = o.quote_id`;';
    expect(schemaTableRefs(src).map((r) => `${r.schema}.${r.table}`)).toEqual([
      'requests.quotes',
      'orders.orders',
    ]);
  });

  it('ignores SQL-looking text outside backtick queries', () => {
    // event-type strings and prose must not count as SQL references
    const src = [
      "const type = 'suppliers.SupplierRegistered';",
      "// builds the index from suppliers.SupplierRegistered",
      "it('reads from orders.orders', () => {});",
    ].join('\n');
    expect(schemaTableRefs(src)).toEqual([]);
  });
});
