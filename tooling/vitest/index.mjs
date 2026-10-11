import { defineConfig } from 'vitest/config';

// Coverage floor every package must meet. CI runs `pnpm test`, which collects coverage,
// so a package below its floor fails the build.
export const DEFAULT_THRESHOLDS = { lines: 80, functions: 80, branches: 80, statements: 80 };

/**
 * Shared Vitest config with coverage thresholds.
 *
 * @param {object} [options]
 * @param {string[]} [options.include] Source globs counted for coverage (default `src/**`).
 * @param {string[]} [options.exclude] Extra globs left out of coverage (entry points, generated code).
 * @param {Record<string, unknown>} [options.thresholds] Overrides and per-glob thresholds, merged over the default floor.
 */
export function canopyVitestConfig({
  include = ['src/**/*.{ts,tsx}'],
  exclude = [],
  thresholds = {},
} = {}) {
  return defineConfig({
    test: {
      passWithNoTests: true,
      coverage: {
        enabled: true,
        provider: 'v8',
        include,
        exclude: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/*.d.ts', ...exclude],
        reporter: ['text-summary', 'json-summary'],
        thresholds: { ...DEFAULT_THRESHOLDS, ...thresholds },
      },
    },
  });
}
