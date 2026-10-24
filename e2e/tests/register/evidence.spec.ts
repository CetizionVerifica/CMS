import { devices, expect, test } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// The evidence vault (M12) against the web app's demo API. It only reads, so it runs beside the register journeys.
const VAULT = `/c/${DEMO_METALS}/evidence`;

test.describe('evidence vault', () => {
  test('a consultant filters the vault, opens a clean file and goes to its instance', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', VAULT);
    await expect(page).toHaveTitle('Evidence · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Evidence' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Evidence' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await checkPage(page);

    const filters = page.getByRole('group', { name: 'Filters' });
    await filters.getByRole('button', { name: 'Virus check' }).click();
    await page.getByRole('checkbox', { name: 'Ready', exact: true }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page).toHaveURL(/\?scanStatus=CLEAN$/);
    await expect(table.getByText('Checking for viruses')).toHaveCount(0);
    await checkPage(page);

    // A clean file opens in a new tab, through a signed URL fetched on the click.
    const open = table.getByRole('button', { name: /^Open / }).first();
    const [popup] = await Promise.all([page.waitForEvent('popup'), open.click()]);
    expect(popup).toBeTruthy();
    await popup.close();

    await page.getByRole('searchbox', { name: /Search file names/ }).fill('zzzz-nothing');
    await expect(page).toHaveURL(/q=zzzz-nothing/);
    await expect(page.getByText('No files match these filters')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(VAULT);

    // A file's name goes to its instance, open over the register.
    const name = table.getByRole('link').first();
    const fileName = await name.innerText();
    await name.click();
    await expect(page).toHaveURL(/\/register\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole('dialog').getByRole('list', { name: 'Evidence files' }),
    ).toContainText(fileName);
  });

  test('an owner sees the vault for their own units', async ({ page }) => {
    await signIn(page, 'owner@demo.test', VAULT);
    await expect(page.getByRole('heading', { level: 1, name: 'Evidence' })).toBeVisible();
    await checkPage(page);
  });
});

test.describe('evidence vault at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('fits the screen', async ({ page }) => {
    await signIn(page, 'approver@demo.test', VAULT);
    await expect(page.getByRole('heading', { level: 1, name: 'Evidence' })).toBeVisible();
    await checkPage(page);
  });
});
