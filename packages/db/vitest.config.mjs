import { canopyVitestConfig } from '@canopy/vitest-config';
import { defineConfig, mergeConfig } from 'vitest/config';

// `pnpm test`: unit tests, no database. database.ts, auth-lookups.ts and repositories/ only run against Postgres, so their coverage is
// counted by `pnpm test:db` (vitest.db.config.mjs) at the same thresholds. cli/ holds thin entry points.
export default mergeConfig(
  canopyVitestConfig({
    exclude: ['src/cli/**', 'src/database.ts', 'src/auth-lookups.ts', 'src/repositories/**'],
  }),
  defineConfig({ test: { include: ['test/**/*.test.ts'], exclude: ['test/**/*.db.test.ts'] } }),
);
