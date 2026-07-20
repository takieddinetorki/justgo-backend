import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Workspace root, resolved from this file's location. */
export const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

export interface WorkspacePackage {
  name: string;
  dir: string;
  tags: string[];
  /** Names of workspace-internal dependencies. */
  internalDeps: string[];
}

const PACKAGE_GLOB_ROOTS = ['apps', 'libs', 'test'];

/** All workspace packages (any depth under apps/, libs/, test/). */
export function workspacePackages(): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  const names = new Set<string>();

  const visit = (dir: string) => {
    const pkgFile = join(dir, 'package.json');
    let hasPkg = false;
    try {
      statSync(pkgFile);
      hasPkg = true;
    } catch {
      // not a package dir — recurse
    }
    if (hasPkg) {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      packages.push({
        name: pkg.name,
        dir,
        tags: pkg.nx?.tags ?? [],
        internalDeps: [],
      });
      names.add(pkg.name);
      return; // packages do not nest
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules') visit(join(dir, entry.name));
    }
  };

  for (const root of PACKAGE_GLOB_ROOTS) {
    try {
      visit(join(WORKSPACE_ROOT, root));
    } catch {
      // root may not exist yet
    }
  }

  // second pass: resolve internal deps now that all names are known
  for (const p of packages) {
    const pkg = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    p.internalDeps = Object.keys(all ?? {}).filter((d) => names.has(d));
  }
  return packages;
}

/** All .ts source files of a package (excluding dist/out-tsc). */
export function sourceFiles(pkgDir: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'out-tsc', 'test-output'].includes(entry.name)) visit(full);
      } else if (entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }
  };
  try {
    visit(join(pkgDir, 'src'));
  } catch {
    // no src dir
  }
  return files;
}

export function relToRoot(path: string): string {
  return relative(WORKSPACE_ROOT, path).split(sep).join('/');
}

/** Every import/require specifier in a TS file. */
export function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) specifiers.push(match[1]);
  }
  return specifiers;
}
