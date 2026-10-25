import { expect, test, type Page } from '@playwright/test';

import { apiAs, itemsOf } from './api.js';
import { checkPage, pageAs, seeded } from './helpers.js';

// M13's setup, reports, audit and library pages on the integrated build: what they save reaches the real API and its
// audit trail, reports build on the real export job and storage, and each page is axe-clean and fits at 1280px and
// 375px. Firm A's client, as imported by 01-import (fy 2022-23).
const FY = 'fy=2022-23';

async function bothWidths(page: Page): Promise<void> {
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await checkPage(page);
  }
}

test('a department added in setup is on the audit trail, with who added it', async ({
  browser,
}) => {
  const { clients } = seeded();
  const name = `Secretarial ${Date.now().toString(36)}`;
  const page = await pageAs(browser, 'consultant');
  await page.goto(`/c/${clients.kestrel}/setup/departments`);
  await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();
  await bothWidths(page);
  await page.getByLabel('Department name').fill(name);
  await page.getByRole('button', { name: 'Add department' }).click();
  await expect(page.getByRole('status').filter({ hasText: `${name} was added.` })).toBeVisible();

  // Saved by the API, not only shown.
  const consultant = await apiAs('consultant');
  const departments = await consultant.get(`/clients/${clients.kestrel}/departments?limit=200`);
  expect(itemsOf(departments.body).map((d) => (d as { name?: string }).name)).toContain(name);
  await consultant.dispose();

  await page.goto(`/c/${clients.kestrel}/audit`);
  await expect(page).toHaveTitle('Audit trail · Kestrel Metals Group · PlanetPulse Compliance');
  const row = page
    .getByRole('table', { name: 'Audit trail' })
    .getByRole('row')
    .filter({ hasText: name })
    .first();
  await expect(row).toContainText('Added a department');
  await bothWidths(page);
  await page.context().close();
});

test('reminder settings are saved by the API and read back', async ({ browser }) => {
  const { clients } = seeded();
  const page = await pageAs(browser, 'consultant');
  await page.goto(`/c/${clients.kestrel}/setup/reminders`);
  await expect(page.getByRole('heading', { level: 1, name: 'Reminders' })).toBeVisible();
  await bothWidths(page);
  const days = page.getByLabel('Remind owners this many days before the due date');
  await days.fill('14, 7, 0');
  await page.getByRole('button', { name: 'Save reminders' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Reminder settings saved.' }),
  ).toBeVisible();
  await page.reload();
  await expect(days).toHaveValue('14, 7, 0');
  await page.context().close();
});

test('the entities and people pages list the imported client', async ({ browser }) => {
  const { clients } = seeded();
  const page = await pageAs(browser, 'clientAdmin');
  for (const [path, heading] of [
    ['entities', 'Entities'],
    ['people', 'People'],
  ] as const) {
    await page.goto(`/c/${clients.kestrel}/setup/${path}`);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await bothWidths(page);
  }
  await page.context().close();
});

test('a report builds on the real export job and downloads through a 5-minute link', async ({
  browser,
}) => {
  const { clients } = seeded();
  const page = await pageAs(browser, 'clientAdmin');
  await page.goto(`/c/${clients.kestrel}/reports?${FY}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  const byAct = page.getByRole('table', { name: 'Scores by Act' });
  await expect(byAct.getByRole('row')).not.toHaveCount(1);
  await expect(page.getByRole('table', { name: 'Scores by department' })).toBeVisible();
  await bothWidths(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download the Act-wise report (Excel)' }).click();
  expect((await download).url()).toMatch(/X-Amz-Expires=300/);
  await expect(
    page.getByRole('status').filter({ hasText: 'The act-wise report is downloading.' }),
  ).toBeVisible();
  await page.context().close();
});

test('the library pages read the firm’s Acts and obligations', async ({ browser }) => {
  const page = await pageAs(browser, 'consultant');
  for (const path of ['/library', '/library/acts', '/library/obligations']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await bothWidths(page);
  }
  await page.context().close();
});

test('an owner reaches none of setup, reports or the audit trail', async ({ browser }) => {
  const { clients } = seeded();
  const page = await pageAs(browser, 'owner');
  for (const path of ['setup/departments', 'reports', 'audit']) {
    await page.goto(`/c/${clients.kestrel}/${path}`);
    await expect(page.getByRole('heading', { name: /You don’t have access/ })).toBeVisible();
    await checkPage(page);
  }
  await page.context().close();
});
