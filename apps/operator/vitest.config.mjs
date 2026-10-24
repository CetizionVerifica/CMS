import { canopyVitestConfig } from '@canopy/vitest-config';
import react from '@vitejs/plugin-react';
import { mergeConfig } from 'vitest/config';

// Pages and layouts are thin: each renders one component from lib/, which the unit tests cover.
export default mergeConfig(
  canopyVitestConfig({
    include: ['lib/**/*.{ts,tsx}'],
    exclude: ['lib/test/**'],
  }),
  {
    plugins: [react()],
    test: {
      environment: 'jsdom',
      include: ['lib/**/*.test.{ts,tsx}'],
      setupFiles: ['./lib/test/setup.ts'],
      testTimeout: 20_000,
    },
  },
);
