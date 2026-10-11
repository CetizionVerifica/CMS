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
    },
  ],
});
