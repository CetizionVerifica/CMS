import { expect, test } from '@playwright/test';

import { checkPage, DEMO_METALS, NORTHWIND, signIn } from './helpers.js';

const CLIENT_ROUTES: [string, string][] = [
  ['overview', 'Overview'],
  ['register', 'Register'],
  ['calendar', 'Calendar'],
  ['evidence', 'Evidence'],
  ['reports', 'Reports'],
  ['audit', 'Audit trail'],
  ['setup/entities', 'Entities'],
  ['setup/people', 'People'],
  ['setup/departments', 'Departments'],
  ['setup/reminders', 'Reminders'],
  ['import', 'Import'],
];
const FIRM_ROUTES: [string, string][] = [
  ['portfolio', 'Portfolio'],
  ['library/acts', 'Acts'],
  ['library/obligations', 'Obligations'],
];

test.describe('shell navigation at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('every route stub opens inside the shell', async ({ page }) => {
    await signIn(page, 'consultant@demo.test');
    for (const [path, title] of CLIENT_ROUTES) {
      await page.goto(`/c/${DEMO_METALS}/${path}`);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page).toHaveTitle(`${title} · Demo Metals · PlanetPulse Compliance`);
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await checkPage(page);
    }
    for (const [path, title] of FIRM_ROUTES) {
      await page.goto(`/${path}`);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await checkPage(page);
    }
    // A record path keeps its list's page (behind the record's drawer once M12 ships it, so attached, not visible).
    await page.goto(`/c/${DEMO_METALS}/register/00000000-0000-5000-8000-00000000abcd`);
    await expect(page.locator('h1', { hasText: /^Register$/ })).toBeAttached();
  });

  test('sidebar links navigate and mark the current page', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `/c/${DEMO_METALS}/overview`);
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const label of [
      'Register',
      'Calendar',
      'Evidence',
      'Reports',
      'Audit trail',
      'Entities',
      'People',
      'Import',
      'Library',
      'Portfolio',
    ]) {
      await nav.getByRole('link', { name: label, exact: true }).click();
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  });

  test('the client switcher keeps the page and period', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `/c/${DEMO_METALS}/register?fy=2022-23&q=Q2`);
    await page.getByRole('button', { name: /Demo Metals/ }).click();
    await page.getByRole('option', { name: /Northwind Textiles/ }).click();
    await expect(page).toHaveURL(`/c/${NORTHWIND}/register?fy=2022-23&q=Q2`);
    await expect(page).toHaveTitle('Register · Northwind Textiles · PlanetPulse Compliance');
  });

  test('the period picker writes the period into the URL', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `/c/${DEMO_METALS}/register?status=OVERDUE`);
    // The demo opens on the period holding M0's firm B "today" (2024-11-15).
    await page.getByRole('button', { name: /Period: FY 2024–25, quarter 3/ }).click();
    await page.getByRole('radio', { name: 'Year' }).click();
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/register?status=OVERDUE&fy=2024-25`);
    await page.goBack();
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/register?status=OVERDUE`);
  });

  test('search opens the register filtered by the text', async ({ page }) => {
    await signIn(page, 'owner@demo.test', `/c/${DEMO_METALS}/overview`);
    // "/" works once the page is interactive.
    await page.waitForLoadState('networkidle');
    await page.keyboard.press('/');
    await expect(
      page.getByRole('searchbox', { name: 'Search this client’s register' }),
    ).toBeFocused();
    await page.keyboard.type('factories');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/register?q=factories`);
  });

  test('roles see only their pages; other clients do not exist', async ({ page }) => {
    await signIn(page, 'owner@demo.test');
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/overview`);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Import' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Approvals' })).toHaveCount(0);

    await page.goto(`/c/${DEMO_METALS}/import`);
    await expect(
      page.getByRole('heading', { name: 'You don’t have access to import' }),
    ).toBeVisible();
    await checkPage(page);

    await page.goto(`/c/${NORTHWIND}/overview`);
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
    await page.goto('/no-such-page');
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  });

  test('a viewer reads one client, with no import or approvals', async ({ page }) => {
    await signIn(page, 'viewer@demo.test');
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/overview`);
    await checkPage(page);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Register' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Import' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Approvals' })).toHaveCount(0);
    await page.goto(`/c/${NORTHWIND}/overview`);
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  });

  test('keyboard only: skip link, sidebar, top bar, then main', async ({ page }) => {
    await signIn(page, 'approver@demo.test', `/c/${DEMO_METALS}/overview`);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main')).toBeFocused();

    await page.reload();
    await page.keyboard.press('Tab'); // skip link
    await page.keyboard.press('Tab'); // brand
    await page.keyboard.press('Tab'); // Overview
    await page.keyboard.press('Tab'); // Register
    await page.keyboard.press('Tab'); // Calendar: the Tab after its h1 reaches its first control
    await expect(page.getByRole('link', { name: 'Calendar', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/calendar`);
    // The route change moves focus to the new page's h1 once it renders, however long that takes under CI load.
    await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeFocused({
      timeout: 15_000,
    });
    await page.keyboard.press('Tab');
    // The placeholder's "Go to home" until M12's calendar ships, then the calendar's "Previous month".
    await expect(
      page
        .getByRole('link', { name: 'Go to home' })
        .or(page.getByRole('button', { name: 'Previous month' })),
    ).toBeFocused();
  });
});
