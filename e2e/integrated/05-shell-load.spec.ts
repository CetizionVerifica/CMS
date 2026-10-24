import { expect, test } from '@playwright/test';

import { seeded } from './helpers.js';
import { addressOf, storageStateOf } from './stack.js';

// F7 (docs/security/review.md): every server render of the shell calls GET /me and, for firm users, GET /portfolio,
// and link prefetching renders the shell many times per page, so one person browsing at an ordinary pace spends the
// API's per-visitor budget (300 requests a minute). The other journeys give each run its own address to stay clear
// of it (stack.ts `addressOf`); this one browses as a consultant would, from one fixed address. It is expected to fail
// until M11 fixes F7: when it starts passing, Playwright reports it, and `test.fail` comes off.
test.fail(
  'a consultant browses the main pages for a minute from one address without being refused',
  async ({ browser }) => {
    const { kestrel } = seeded().clients;
    const context = await browser.newContext({
      storageState: storageStateOf('consultant'),
      extraHTTPHeaders: { 'x-forwarded-for': addressOf('consultant') },
    });
    const page = await context.newPage();
    const pages = [
      '/portfolio',
      `/c/${kestrel}/overview`,
      `/c/${kestrel}/register`,
      `/c/${kestrel}/approvals`,
      `/c/${kestrel}/calendar`,
      `/c/${kestrel}/evidence`,
      `/c/${kestrel}/import`,
      '/library/obligations',
    ];
    // Two rounds of eight pages, about a page every three seconds: an ordinary working pace.
    for (const path of [...pages, ...pages]) {
      const started = Date.now();
      const res = await page.goto(path);
      expect(res?.status(), `${path} answered ${res?.status()}`).toBe(200);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(page.getByText(/too many requests|try again in a minute/i)).toHaveCount(0);
      await page.waitForTimeout(Math.max(0, 3_000 - (Date.now() - started)));
    }
    await context.close();
  },
);
