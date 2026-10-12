import { canopyVitestConfig } from '@canopy/vitest-config';
import { defineConfig, mergeConfig } from 'vitest/config';

// The fixture tests read and analyse the whole sample register with the real engine. That takes about 0.5 s
// alone but passed the default 5 s test and 10 s hook limits on a CI runner shared with the other packages'
// tests (reading the workbook in a beforeAll included), so allow 20 s for both.
export default mergeConfig(
  canopyVitestConfig(),
  defineConfig({ test: { testTimeout: 20_000, hookTimeout: 20_000 } }),
);
