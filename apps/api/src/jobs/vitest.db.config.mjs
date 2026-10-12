import { canopyVitestConfig } from '@canopy/vitest-config';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';

// `pnpm test:db` for apps/api: the job tests including the pg-boss runner against Postgres 16 (DATABASE_URL), run
// by the CI `db` job. Coverage is measured over src/jobs, so runner.ts counts here at the same thresholds.
export default mergeConfig(
  canopyVitestConfig({ include: ['src/jobs/**/*.ts'] }),
  defineConfig({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    test: { include: ['src/jobs/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 },
  }),
);
