import { canopyVitestConfig } from '@canopy/vitest-config';
import { defineConfig, mergeConfig } from 'vitest/config';

// `pnpm test`: unit tests, no database. main.ts only boots the server. A module's service.ts and routes.ts, any
// `db-*.ts` file and a module's testing/ helpers only run against Postgres, so their coverage is counted by `pnpm test:db` (vitest.db.config.mjs)
// at the same thresholds.
export default mergeConfig(
  canopyVitestConfig({
    exclude: [
      'src/main.ts',
      'src/modules/*/service.ts',
      'src/modules/*/routes.ts',
      'src/modules/*/testing/**',
      'src/**/db-*.ts',
    ],
  }),
  defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.db.test.ts'] } }),
);
