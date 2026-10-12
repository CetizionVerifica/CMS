import { canopyVitestConfig } from '@canopy/vitest-config';
import react from '@vitejs/plugin-react';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(
  canopyVitestConfig({
    // index.ts only re-exports; the demo gallery and e2e specs are checked by Playwright (`pnpm test:e2e`).
    exclude: ['src/index.ts'],
  }),
  {
    plugins: [react()],
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./test/setup.ts'],
      // Interaction tests drive many key presses and run axe in jsdom; on shared CI runners some (the 10,000-row
      // DataTable) take over the 5s default while the whole package runs in parallel.
      testTimeout: 20_000,
    },
  },
);
