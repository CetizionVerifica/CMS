import { networkInterfaces } from 'node:os';

import { expect, request, test } from '@playwright/test';

import { seeded } from './helpers.js';
import { API_PORT, API_URL, addressOf, storageStateOf } from './stack.js';

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

// The other side of F7: the per-address budget is still there. A flood from one address is refused with
// RATE_LIMITED once it passes 300 requests in a minute, and another address is served meanwhile.
test('a flood of requests from one address is refused, and other addresses are not', async () => {
  const flood = await request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.7' },
  });
  const statuses: number[] = [];
  for (let sent = 0; sent < 320; sent += 20) {
    const batch = await Promise.all(
      Array.from({ length: 20 }, () => flood.get('/api/v1/me').then((res) => res.status())),
    );
    statuses.push(...batch);
  }
  // No session, so each request that gets through is a 401; the ones past the budget are 429.
  expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(300);
  expect(statuses.filter((s) => s !== 401 && s !== 429)).toEqual([]);
  const refused = await flood.get('/api/v1/me');
  expect(refused.status()).toBe(429);
  expect(await refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  await flood.dispose();

  const other = await request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.8' },
  });
  expect((await other.get('/api/v1/me')).status()).toBe(401);
  await other.dispose();
});

// X-Forwarded-For is believed only from TRUST_PROXY (loopback here). A caller reaching the API from any other address
// cannot dodge the budget by naming a new address in each request: every request counts against where it came from.
test('a caller outside the trusted proxies cannot pick its address with X-Forwarded-For', async () => {
  const outside = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal);
  if (!outside)
    throw new Error('this machine has no non-loopback IPv4 address to call the API from');
  const api = await request.newContext({ baseURL: `http://${outside.address}:${API_PORT}` });
  const statuses: number[] = [];
  for (let sent = 0; sent < 320; sent += 20) {
    const batch = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        api
          .get('/api/v1/me', { headers: { 'x-forwarded-for': `192.0.2.${(sent + i) % 250}` } })
          .then((res) => res.status()),
      ),
    );
    statuses.push(...batch);
  }
  expect(statuses.filter((s) => s !== 401 && s !== 429)).toEqual([]);
  expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  await api.dispose();
});
