import { defineConfig, devices } from '@playwright/test';

const ci = !!process.env.CI;

// Real-browser checks for the component gallery (demo/): axe including colour contrast, keyboard paths and layout
// at the two widths from the definition of done. `pnpm test:e2e` builds the gallery first.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: ci,
  retries: 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4310',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: 'pnpm exec vite preview',
    url: 'http://localhost:4310',
    reuseExistingServer: !ci,
  },
});
