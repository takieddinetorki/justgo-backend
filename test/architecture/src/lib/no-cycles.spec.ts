/**
 * Fitness function (§18): the module dependency graph has NO cycles.
 * "Depend inward only" (§4.7) — a cycle means two modules own each other.
 */
import { workspacePackages } from './workspace';

describe('architecture: dependency graph', () => {
  const packages = workspacePackages();

  it('finds the workspace packages', () => {
    const names = packages.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(['@justgo/kernel', '@justgo/contracts', '@justgo/events']),
    );
  });

  it('has no dependency cycles', () => {
    const graph = new Map(packages.map((p) => [p.name, p.internalDeps]));
    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[] = [];

    const dfs = (name: string, path: string[]) => {
      if (done.has(name)) return;
      if (visiting.has(name)) {
        cycles.push([...path.slice(path.indexOf(name)), name].join(' → '));
        return;
      }
      visiting.add(name);
      for (const dep of graph.get(name) ?? []) dfs(dep, [...path, dep]);
      visiting.delete(name);
      done.add(name);
    };

    for (const p of packages) dfs(p.name, [p.name]);
    expect(cycles).toEqual([]);
  });
});
