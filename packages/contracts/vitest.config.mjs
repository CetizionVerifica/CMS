import { canopyVitestConfig } from '@canopy/vitest-config';
import { defineConfig, mergeConfig } from 'vitest/config';

// The mock suites drive many routes per test against one in-memory server. A review figures test takes about 0.2 s
// alone but passed the default 5 s limit in a merge-queue run on a runner shared with the other packages' tests (the
// whole package took 92 s there, 87 s of it importing), so allow 20 s for tests and hooks, as the importer does.
export default mergeConfig(
  canopyVitestConfig(),
  defineConfig({ test: { testTimeout: 20_000, hookTimeout: 20_000 } }),
);
