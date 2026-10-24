import { defineConfig, devices } from '@playwright/test';

const ci = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  forbidOnly: ci,
  retries: 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    // Under reduced motion the UI's fades and slides last 1ms (packages/ui styles.css), so axe and the journeys never
    // judge a page mid-animation, when a fading element's contrast is still part-way.
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Starts the built web app and the API. Run `pnpm build` first (turbo does this for `pnpm test:e2e`).
  webServer: [
    {
      command: 'pnpm --filter @canopy/api start',
      url: 'http://localhost:4000/health',
      reuseExistingServer: !ci,
    },
    {
      command: 'pnpm --filter @canopy/web start',
      url: 'http://localhost:3000',
      reuseExistingServer: !ci,
      // The journeys run against the M0 mock API, which a production build serves only with this flag. Set here, so
      // turbo's env filtering for test:e2e can't strip it.
      env: { CANOPY_DEMO_API: '1' },
    },
  ],
});
