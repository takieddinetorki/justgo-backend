/**
 * Fitness function (§15): the OpenAPI spec is the contract of record, so it
 * may not drift from the routes that actually exist.
 *
 * WHY THIS TEST EXISTS. Request bodies are validated with zod, not class
 * DTOs, so there is nothing for Nest to reflect into an operation: paths
 * appear automatically, but every schema, example and summary is attached by
 * hand in `enrich()`. Nothing connected the two. Endpoints shipped for a
 * month as a bare verb-and-path — no body, no response shape — and the only
 * assertion anywhere was that the document parsed as OpenAPI 3, which it
 * would while being entirely empty.
 *
 * Worse, `enrich()` applies each block with `if (op) Object.assign(...)`: a
 * key that matches no route does nothing, silently. Rename a route and its
 * documentation evaporates with no error and no failure. That half is now
 * caught here.
 *
 * Routes are read from the controllers rather than from a booted app so this
 * stays a static check with no database.
 */
import { readFileSync } from 'node:fs';
import { WORKSPACE_ROOT, relToRoot, sourceFiles, workspacePackages } from './workspace';
import { join } from 'node:path';

const OPENAPI_FILE = join(WORKSPACE_ROOT, 'apps/api/src/openapi.ts');
const GLOBAL_PREFIX = 'v1';

/**
 * Operations deliberately left out of the hand-written documentation.
 *
 * Keep this EMPTY. It exists so that a considered exception is visible in a
 * diff and has to be argued for, not so that new endpoints have somewhere to
 * hide. Anything added here needs a reason on the line.
 */
const UNDOCUMENTED: readonly string[] = [];

interface Route {
  method: string;
  path: string;
  file: string;
}

const METHOD_DECORATOR = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
const CONTROLLER_DECORATOR = /@Controller\(\s*(?:'([^']*)')?\s*\)/;

/** `:id` -> `{id}`, `*path` -> `{path}`: Nest's syntax to OpenAPI's. */
function toOpenApiPath(segments: string[]): string {
  const joined = segments
    .filter((s) => s.length > 0)
    .join('/')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/\*([A-Za-z0-9_]+)/g, '{$1}');
  return `/${joined}`;
}

export function routesIn(source: string, file: string): Route[] {
  // A controller hidden from the spec has no documentation to be missing.
  if (source.includes('@ApiExcludeController')) return [];

  const base = CONTROLLER_DECORATOR.exec(source)?.[1] ?? '';
  const routes: Route[] = [];
  for (const match of source.matchAll(METHOD_DECORATOR)) {
    routes.push({
      method: match[1].toLowerCase(),
      path: toOpenApiPath([GLOBAL_PREFIX, base, match[2] ?? '']),
      file,
    });
  }
  return routes;
}

function allRoutes(): Route[] {
  const routes: Route[] = [];
  for (const pkg of workspacePackages()) {
    for (const file of sourceFiles(pkg.dir)) {
      if (!file.endsWith('.controller.ts')) continue;
      routes.push(...routesIn(readFileSync(file, 'utf8'), relToRoot(file)));
    }
  }
  return routes;
}

/** The `set('<path>', '<method>', …)` keys inside `enrich()`. */
function documentedOperations(): Set<string> {
  const source = readFileSync(OPENAPI_FILE, 'utf8');
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bset\(\s*'([^']+)'\s*,\s*'([a-z]+)'/g)) {
    keys.add(`${match[2]} ${match[1]}`);
  }
  return keys;
}

describe('architecture: OpenAPI coverage', () => {
  const routes = allRoutes();
  const documented = documentedOperations();

  it('found the controllers and the spec at all', () => {
    // A broken scanner would otherwise report perfect compliance.
    expect(routes.length).toBeGreaterThan(50);
    expect(documented.size).toBeGreaterThan(20);
  });

  it('documents every route the API exposes', () => {
    const bare = routes
      .map((r) => ({ key: `${r.method} ${r.path}`, file: r.file }))
      .filter(({ key }) => !documented.has(key) && !UNDOCUMENTED.includes(key))
      .map(({ key, file }) => `${key}   (${file})`)
      .sort();

    expect(bare).toEqual([]);
  });

  it('has no enrich() key that matches no route', () => {
    const real = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const orphans = [...documented].filter((key) => !real.has(key)).sort();

    expect(orphans).toEqual([]);
  });

  it('lists no stale exception', () => {
    const real = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(UNDOCUMENTED.filter((key) => !real.has(key))).toEqual([]);
  });
});
