import { canopyVitestConfig } from '@canopy/vitest-config';
import { defineConfig, mergeConfig } from 'vitest/config';

// The fixture tests read and analyse the whole sample register with the real engine. That takes about 0.5 s
// alone but passed the default 5 s on a CI runner shared with the other packages' tests, so allow 20 s.
export default mergeConfig(canopyVitestConfig(), defineConfig({ test: { testTimeout: 20_000 } }));
