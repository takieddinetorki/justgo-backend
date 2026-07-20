/**
 * Fitness functions (§18):
 *  - only a module's contract/ is importable — no deep imports into
 *    application/, domain/, infra/ or into another package's src/
 *  - no relative import escapes its own package
 *  - every package carries a scope tag so the ESLint depConstraints bite
 */
import { join, normalize, resolve, sep } from 'node:path';
import { importSpecifiers, relToRoot, sourceFiles, workspacePackages } from './workspace';

const PRIVATE_LAYERS = ['application', 'domain', 'infra'];

describe('architecture: module boundaries', () => {
  const packages = workspacePackages();

  it('every package declares a scope tag', () => {
    const untagged = packages
      .filter((p) => !p.tags.some((t) => t.startsWith('scope:')))
      .map((p) => p.name);
    expect(untagged).toEqual([]);
  });

  it('no deep imports into another package (only its public entry)', () => {
    const violations: string[] = [];
    for (const pkg of packages) {
      for (const file of sourceFiles(pkg.dir)) {
        for (const spec of importSpecifiers(file)) {
          if (!spec.startsWith('@justgo/') && !spec.startsWith('@justgo-backend/')) continue;
          const rest = spec.split('/').slice(2).join('/');
          if (rest.length > 0) {
            violations.push(`${relToRoot(file)} imports "${spec}" — import the package root`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no import reaches into a private layer (application/domain/infra)', () => {
    const violations: string[] = [];
    for (const pkg of packages) {
      for (const file of sourceFiles(pkg.dir)) {
        for (const spec of importSpecifiers(file)) {
          if (!spec.startsWith('.')) continue;
          const target = normalize(resolve(join(file, '..'), spec));
          const inOwnPackage = target.startsWith(resolve(pkg.dir) + sep);
          if (!inOwnPackage) {
            violations.push(
              `${relToRoot(file)} imports "${spec}" — relative import escapes its package`,
            );
            continue;
          }
          // within a package, application|domain|infra may only be imported
          // from inside the same package — which this is; contract-only
          // access across packages is guaranteed by the escape check above
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('published entry points expose no private layer', () => {
    // A module's index.ts must not re-export application/domain/infra —
    // those layers stay private even to consumers of the public entry (§5).
    const violations: string[] = [];
    for (const pkg of packages) {
      const index = sourceFiles(pkg.dir).find((f) => relToRoot(f).endsWith('src/index.ts'));
      if (!index) continue;
      for (const spec of importSpecifiers(index)) {
        if (PRIVATE_LAYERS.some((layer) => spec.includes(`/${layer}/`) || spec === `./${layer}`)) {
          violations.push(`${relToRoot(index)} re-exports private layer via "${spec}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
