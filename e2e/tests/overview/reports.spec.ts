import { expect, test } from '@playwright/test';

import { DEMO_METALS, signIn } from '../shell/helpers.js';
import { checkSettled } from './settled.js';

// Reports (M13) against the web app's demo API. M0's data sits in FY 2024-25, so the journeys select that period.
// The demo API finishes an export at once and hands out a link on files.mock.invalid, which the test answers itself.
const REPORTS = `/c/${DEMO_METALS}/reports?fy=2024-25`;
const FILES = 'https://files.mock.invalid/**';

test.describe('reports', () => {
  test('a consultant reads the reports and opens the rows behind a number', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', REPORTS);
    await expect(page).toHaveTitle('Reports · Demo Metals · PlanetPulse Compliance');
    const byAct = page.getByRole('table', { name: 'Scores by Act' });
    await expect(byAct.getByRole('row')).not.toHaveCount(1);
    await expect(page.getByRole('table', { name: 'Scores by department' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Overdue instances' })).toBeVisible();
    await checkSettled(page);

    const count = byAct
      .getByRole('link', { name: /^\d+ (overdue|complied|still open) under / })
      .first();
    const href = await count.getAttribute('href');
    expect(href).toMatch(/\/register\?actId=[0-9a-f-]{36}&status=[A-Z_,%2C]+&fy=2024-25$/);
    await count.click();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(href);
  });

  test('a report downloads once its export is ready', async ({ page }) => {
    let downloaded = '';
    await page.route(FILES, async (route) => {
      downloaded = route.request().url();
      await route.fulfill({
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="report.xlsx"' },
        body: 'report',
      });
    });
    await signIn(page, 'consultant@demo.test', REPORTS);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download the Act-wise report (Excel)' }).click();
    await download;
    expect(downloaded).toMatch(/^https:\/\/files\.mock\.invalid\/exports\//);
    await expect(
      page.getByRole('status').filter({ hasText: 'The act-wise report is downloading.' }),
    ).toBeVisible();
    await checkSettled(page);
  });

  test('keyboard only: a download starts from the keyboard', async ({ page }) => {
    await page.route(FILES, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="certificate.pdf"' },
        body: 'pdf',
      }),
    );
    await signIn(page, 'admin@demo.test', REPORTS);
    const button = page.getByRole('button', { name: 'Download the Compliance certificate (PDF)' });
    await button.focus();
    const download = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    await download;
  });

  test('an approver reads the reports; an owner cannot', async ({ page }) => {
    await signIn(page, 'approver@demo.test', REPORTS);
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Scores by Act' })).toBeVisible();
    await checkSettled(page);

    await page.context().clearCookies();
    await signIn(page, 'owner@demo.test', REPORTS);
    await expect(page.getByRole('heading', { name: /You don’t have access/ })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Scores by Act' })).toHaveCount(0);
    await checkSettled(page);
  });

  test('a viewer reads the reports', async ({ page }) => {
    await signIn(page, 'viewer@demo.test', REPORTS);
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Scores by Act' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Scores by department' })).toBeVisible();
    await checkSettled(page);
  });

  test('the reports read at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, 'consultant@demo.test', REPORTS);
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
    await checkSettled(page);
  });
});
