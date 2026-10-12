import { canopyVitestConfig } from '@canopy/vitest-config';
import { defineConfig, mergeConfig } from 'vitest/config';

// `pnpm test:db`: tests against a real Postgres 16 (DATABASE_URL), run by the CI `db` job. The unit tests run here
// too, so coverage is measured over all of src, including the service.ts and routes.ts files the unit run leaves out.
export default mergeConfig(
  canopyVitestConfig({ exclude: ['src/main.ts', 'src/modules/*/testing/**'] }),
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
);
