import { canopyVitestConfig } from '@canopy/vitest-config';
import { defineConfig, mergeConfig } from 'vitest/config';

// `pnpm test:db`: tests against a real Postgres 16 (DATABASE_URL), run by the CI `db` job. Each file creates
// and drops its own database. Coverage here counts the files the unit run leaves out (they need Postgres).
export default mergeConfig(
  canopyVitestConfig({ exclude: ['src/cli/**'] }),
  defineConfig({
    test: {
      // The unit tests run here too, so coverage is measured over all of src.
      include: ['test/**/*.test.ts'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
);
