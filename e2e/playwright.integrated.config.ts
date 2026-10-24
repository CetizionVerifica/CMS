import { defineConfig, devices } from '@playwright/test';

import {
  API_PORT,
  API_URL,
  APP_LOGIN,
  APP_PASSWORD,
  JOBS_LOGIN,
  JOBS_PASSWORD,
  AUTH_SECRET_KEY,
  E2E_DATABASE,
  WEB_PORT,
  WEB_URL,
  databaseUrl,
} from './integrated/stack.js';

// The integrated journeys (M14): the built web app against the real API, on Postgres 16 and S3-compatible storage,
// instead of the demo run's in-process mock. Needs DATABASE_URL (a server the run may create `canopy_e2e` on) and
// the S3_* settings of .env.example (SeaweedFS from docker/compose.yaml locally). Run `pnpm build` first, then
// `pnpm --filter @canopy/e2e test:integrated`. The API's webServer command recreates and seeds the database first.
const ci = !!process.env.CI;
const base = process.env.DATABASE_URL;
if (!base) throw new Error('DATABASE_URL is not set: the integrated journeys need Postgres 16.');

export default defineConfig({
  testDir: './integrated',
  forbidOnly: ci,
  retries: 0,
  // One worker: the journeys share one database and run in order (setup, import, then the rest).
  workers: 1,
  reporter: ci
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-integrated' }]]
    : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    contextOptions: { reducedMotion: 'reduce' },
    // A machine whose Chromium isn't the one this Playwright downloads can point at its own.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH && {
      launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH },
    }),
  },
  timeout: 60_000,
  projects: [
    { name: 'setup', testMatch: /setup\.ts$/ },
    {
      name: 'journeys',
      testMatch: /\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm exec tsx integrated/prepare.ts && pnpm --filter @canopy/api start',
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        API_PORT: String(API_PORT),
        // prepare.ts connects to the server as the owner; the API as the app login.
        E2E_SERVER_DATABASE_URL: base,
        DATABASE_URL: databaseUrl(base, E2E_DATABASE, [APP_LOGIN, APP_PASSWORD]),
        JOBS_DATABASE_URL: databaseUrl(base, E2E_DATABASE, [JOBS_LOGIN, JOBS_PASSWORD]),
        AUTH_SECRET_KEY,
        // The web server calls from loopback and passes on each browser's X-Forwarded-For (stack.ts addressOf).
        TRUST_PROXY: '127.0.0.1,::1',
        // Production refuses a privileged database login; this run checks it serves through a plain app login.
        NODE_ENV: 'production',
      },
    },
    {
      command: `pnpm --filter @canopy/web exec next start --port ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: false,
      env: { CANOPY_API_URL: API_URL },
    },
  ],
});
