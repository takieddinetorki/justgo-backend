import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/test-output'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          // §18: boundaries are enforced by CI, not discipline. Do NOT
          // weaken a constraint to make a build pass — fix the dependency.
          depConstraints: [
            // shared contracts/kernel depend only on themselves
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
            // platform core: other platform modules (contract/ only) + shared;
            // NEVER a vertical (§4.7)
            {
              sourceTag: 'scope:platform',
              onlyDependOnLibsWithTags: ['scope:shared', 'scope:platform', 'scope:crosscutting'],
            },
            // verticals: shared contracts + own code only — not other
            // verticals, not platform internals (§18)
            { sourceTag: 'scope:vertical', onlyDependOnLibsWithTags: ['scope:shared'] },
            // integrations (tecdoc, geocoding, fcm) are leaf adapters
            { sourceTag: 'scope:integration', onlyDependOnLibsWithTags: ['scope:shared'] },
            {
              sourceTag: 'scope:crosscutting',
              onlyDependOnLibsWithTags: ['scope:shared', 'scope:crosscutting'],
            },
            // apps compose everything
            { sourceTag: 'scope:app', onlyDependOnLibsWithTags: ['*'] },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
