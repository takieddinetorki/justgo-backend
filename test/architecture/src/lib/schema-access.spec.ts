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
        for (const match of source.matchAll(SQL_REF_RE)) {
          const [, schema, table] = match;
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

  it('is armed (sanity check on the SQL matcher)', () => {
    const hits = [
      ...'select * from requests.quotes q join orders.orders o on q.id = o.quote_id'.matchAll(
        SQL_REF_RE,
      ),
    ];
    expect(hits.map((h) => `${h[1]}.${h[2]}`)).toEqual(['requests.quotes', 'orders.orders']);
  });
});
