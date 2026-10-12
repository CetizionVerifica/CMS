// The coverage globs decide which files CI holds to the 80% floor. A glob that silently matches nothing lets code
// escape the gate, so check them against real-looking paths with the matcher Vitest itself uses.
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';
import type { ViteUserConfig } from 'vitest/config';

// A plain .mjs file has no types; the specifier is a variable so tsc doesn't look for them.
const configPath = '../vitest.config.mjs';
const { default: config } = (await import(/* @vite-ignore */ configPath)) as {
  default: ViteUserConfig;
};

const picomatch = createRequire(createRequire(import.meta.url).resolve('vitest'))('picomatch') as (
  globs: string[],
) => (path: string) => boolean;

const coverage = config.test?.coverage as { include: string[]; exclude: string[] };
const included = picomatch(coverage.include);
const excluded = picomatch(coverage.exclude);
const counted = (path: string) => included(path) && !excluded(path);

describe('unit coverage globs', () => {
  it('count shared code and the components modules keep next to their routes', () => {
    expect(counted('lib/shell/model.ts')).toBe(true);
    expect(counted('app/(shell)/c/[clientId]/register/_components/RegisterGrid.tsx')).toBe(true);
    expect(counted('app/(shell)/portfolio/portfolio-model.ts')).toBe(true);
  });

  it('leave out tests, test helpers and the files Playwright covers', () => {
    for (const path of [
      'lib/shell/model.test.ts',
      'lib/test/setup.ts',
      'app/(shell)/c/[clientId]/register/RegisterGrid.test.tsx',
      'app/(shell)/c/[clientId]/register/page.tsx',
      'app/(shell)/c/[clientId]/layout.tsx',
      'app/(shell)/c/[clientId]/register/loading.tsx',
      'app/(shell)/c/[clientId]/register/error.tsx',
      'app/(shell)/c/[clientId]/not-found.tsx',
      'app/global-error.tsx',
    ]) {
      expect(counted(path), path).toBe(false);
    }
  });
});
