import { devices, expect, test } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// The calendar (M12) against the web app's demo API, whose Demo Metals instances fall due in FY 2023-24. It only
// reads, so it runs beside the register journeys.
const CALENDAR = `/c/${DEMO_METALS}/calendar`;
const JUNE = `${CALENDAR}?fy=2023-24&m=2023-06`;

test.describe('calendar', () => {
  test('a consultant reads a month, opens a day, moves months and switches to the list', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', JUNE);
    await expect(page).toHaveTitle('Calendar · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 2, name: 'June 2023' })).toBeVisible();
    const grid = page.getByRole('table', { name: 'Due dates in June 2023' });
    await expect(grid).toBeVisible();
    await checkPage(page);

    // A day with due dates opens its instances below the grid, each linked to its drawer.
    const day = grid.getByRole('button').first();
    const name = (await day.getAttribute('aria-label'))!;
    await day.focus();
    await page.keyboard.press('Enter');
    await expect(day).toHaveAttribute('aria-pressed', 'true');
    const panel = page.getByRole('region', { name: /^Due \d+ Jun 2023$/ });
    await expect(panel.getByRole('link').first()).toBeVisible();
    expect(name).toMatch(/ June 2023, \d+ due/);
    await checkPage(page);

    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(page).toHaveURL(/fy=2023-24&m=2023-07/);
    await expect(page.getByRole('heading', { level: 2, name: 'July 2023' })).toBeVisible();

    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(page).toHaveURL(/m=2023-07&view=list/);
    await expect(page.getByRole('table')).toHaveCount(0);
    const first = page.getByRole('region').first();
    await expect(first.getByRole('link').first()).toBeVisible();
    await checkPage(page);

    // Back returns to the month grid.
    await page.goBack();
    await expect(page.getByRole('table', { name: 'Due dates in July 2023' })).toBeVisible();

    const link = page.getByRole('region').first().getByRole('link').first();
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/register\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('a month with nothing due says so', async ({ page }) => {
    await signIn(page, 'owner@demo.test', `${CALENDAR}?fy=2030-31&m=2030-05`);
    await expect(page.getByText('Nothing due in May 2030')).toBeVisible();
    await checkPage(page);
  });
});

test.describe('calendar at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('fits the screen in both views', async ({ page }) => {
    await signIn(page, 'approver@demo.test', JUNE);
    await expect(page.getByRole('table', { name: 'Due dates in June 2023' })).toBeVisible();
    await checkPage(page);
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(page.getByRole('table')).toHaveCount(0);
    await checkPage(page);
  });
});
