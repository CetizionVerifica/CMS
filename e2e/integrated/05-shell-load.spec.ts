import { expect, test } from '@playwright/test';

import { seeded } from './helpers.js';
import { addressOf, storageStateOf } from './stack.js';

// F7 (docs/security/review.md, fixed in #147): the shell used to call GET /me and /portfolio on every server render
// and prefetch, so one person browsing at an ordinary pace spent the API's per-visitor budget (300 requests a minute).
// This journey browses as a consultant would, from one fixed address, and must never be refused.
test('a consultant browses the main pages for a minute from one address without being refused', async ({
  browser,
}) => {
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
});
