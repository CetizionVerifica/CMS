import { expect, test } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// Portfolio (M13) against the web app's in-process mock: Demo Metals has 5 overdue, Northwind 0, Sunrise Foods 12.
// The consultant sees Demo Metals and Northwind; the account admin sees all three. The demo account has the ISO add-on,
// so the overdue links say `source=LAW`: the count is statutory work only (ISO-12c).
const SUNRISE = '00000000-0000-5000-8000-000000000103';

test.describe('portfolio', () => {
  test('a consultant sees each client, most overdue first, and every link lands', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', '/portfolio');
    await expect(page).toHaveURL('/portfolio');
    await expect(page).toHaveTitle('Portfolio · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Portfolio' })).toBeVisible();
    await expect(page.getByText('5 overdue items across 1 client.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Add a client' })).toHaveCount(0);
    await checkPage(page);

    const table = page.getByRole('table', { name: 'Clients' });
    const rows = table.getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText('Demo Metals');
    await expect(rows.nth(2)).toContainText('Northwind Textiles');
    await expect(rows.nth(1)).toContainText('No items due');
    await expect(rows.nth(1)).toContainText('No activity yet');
    await expect(table).not.toContainText('Sunrise Foods');

    await table.getByRole('link', { name: '5 overdue at Demo Metals, view in register' }).click();
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/register?status=OVERDUE&source=LAW`);
    await expect(page.getByRole('heading', { level: 1, name: 'Register' })).toBeVisible();

    await page.goBack();
    await table.getByRole('link', { name: 'Demo Metals', exact: true }).click();
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/overview`);
  });

  test('an account admin sees every client and the summary names the worst one', async ({
    page,
  }) => {
    await signIn(page, 'admin@demo.test', '/portfolio');
    await expect(
      page.getByText('17 overdue items across 2 clients. Sunrise Foods has the most (12).'),
    ).toBeVisible();
    const rows = page.getByRole('table', { name: 'Clients' }).getByRole('row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(1)).toContainText('Sunrise Foods');
    await expect(rows.nth(2)).toContainText('Demo Metals');
    await expect(rows.nth(3)).toContainText('Northwind Textiles');
    await expect(rows.nth(3).getByRole('link', { name: /overdue at/ })).toHaveCount(0);
    // Account admins add clients below the table; consultants do not (endpoints.md: client.create is FA only).
    await expect(page.getByRole('heading', { level: 2, name: 'Add a client' })).toBeVisible();
    await expect(page.getByLabel(/Client name/)).toBeVisible();
    await checkPage(page);
    await rows
      .nth(1)
      .getByRole('link', { name: '12 overdue at Sunrise Foods, view in register' })
      .click();
    await expect(page).toHaveURL(`/c/${SUNRISE}/register?status=OVERDUE&source=LAW`);
  });

  test('the overdue link works from the keyboard', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', '/portfolio');
    const name = '5 overdue at Demo Metals, view in register';
    const link = page.getByRole('link', { name });
    // A string, because the e2e tsconfig has no DOM types.
    const focusedLabel = () =>
      page.evaluate<string | null>(`document.activeElement?.getAttribute('aria-label') ?? null`);
    for (let i = 0; i < 40 && (await focusedLabel()) !== name; i++) {
      await page.keyboard.press('Tab');
    }
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/register?status=OVERDUE&source=LAW`);
  });

  test('client users get the no-access page, not the data', async ({ page }) => {
    await signIn(page, 'owner@demo.test', `/c/${DEMO_METALS}/register`);
    await page.goto('/portfolio');
    await expect(page.getByText('You don’t have access to the portfolio')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Clients' })).toHaveCount(0);
    await checkPage(page);
  });

  test('a company account with one client is sent from the portfolio to its client', async ({
    page,
  }) => {
    await signIn(page, 'company@demo.test');
    await page.goto('/portfolio');
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/overview`);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await checkPage(page);
  });

  test('fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, 'consultant@demo.test', '/portfolio');
    await expect(page.getByRole('heading', { level: 1, name: 'Portfolio' })).toBeVisible();
    await checkPage(page);
  });
});
