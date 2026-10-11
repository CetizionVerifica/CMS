import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/', '**/dist/', '**/.next/', '**/coverage/', '**/next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Root CLAUDE.md non-negotiable 7: no `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Root CLAUDE.md: engine is pure TypeScript and must not import db, api or any I/O.
    files: ['packages/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@canopy/db', '@canopy/api', '@canopy/importer'],
              message: 'engine has no I/O dependencies.',
            },
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'net'],
              message: 'engine has no I/O dependencies.',
            },
          ],
        },
      ],
    },
  },
  {
    // Root CLAUDE.md: ui depends on nothing in the repo.
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@canopy/*'], message: 'ui depends on nothing in the repo.' }] },
      ],
    },
  },
);
