import { canopyVitestConfig } from '@canopy/vitest-config';
import react from '@vitejs/plugin-react';
import { mergeConfig } from 'vitest/config';

// Pages, layouts and their loading/error files are covered by Playwright (e2e/tests); unit coverage applies to shared
// code in lib/ and to the non-page files that modules keep next to their routes under app/. The app glob names no
// route group: picomatch reads `(shell)` as a regex group, so `app/(shell)/**` would match nothing
// (lib/coverage-config.test.ts checks this).
export default mergeConfig(
  canopyVitestConfig({
    include: ['lib/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
    exclude: [
      'lib/test/**',
      'app/global-error.tsx',
      'app/**/page.tsx',
      'app/**/layout.tsx',
      'app/**/loading.tsx',
      'app/**/error.tsx',
      'app/**/not-found.tsx',
    ],
  }),
  {
    plugins: [react()],
    test: {
      environment: 'jsdom',
      include: ['lib/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}'],
      setupFiles: ['./lib/test/setup.ts'],
      testTimeout: 20_000,
    },
  },
);
