import { devices, expect, test, type Page } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// The register (M12) against the web app's demo API, which hands instance routes to M0's mock server. Its Demo
// Metals rows fall in FY 2023-24, so the journeys open that year.
const REGISTER = `/c/${DEMO_METALS}/register`;
const FY = 'fy=2023-24';

const matchCount = (page: Page) => page.getByText(/^\d+ instances? match$/);

async function count(page: Page): Promise<number> {
  return Number((await matchCount(page).innerText()).split(' ')[0]);
}

test.describe('register', () => {
  test('a consultant filters the register, and the URL keeps the filters and the period', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', `${REGISTER}?${FY}`);
    await expect(page).toHaveTitle('Register · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Register' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Register' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await checkPage(page);
    const all = await count(page);
    expect(all).toBeGreaterThan(0);

    const filters = page.getByRole('group', { name: 'Filters' });
    await filters.getByRole('button', { name: 'Status' }).click();
    await page.getByRole('checkbox', { name: 'Complied', exact: true }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page).toHaveURL(new RegExp(`${FY}&status=COMPLIED`));
    await expect(filters.getByRole('button', { name: /Status filter: Complied/ })).toBeVisible();
    await expect.poll(() => count(page)).toBeLessThan(all);
    await checkPage(page);

    // A reload shows the same rows: the state is all in the URL.
    const filtered = await count(page);
    await page.reload();
    await expect.poll(() => count(page)).toBe(filtered);

    await page.getByRole('searchbox', { name: /Search ID, title or Act/ }).fill('zzzz-nothing');
    await expect(page).toHaveURL(/search=zzzz-nothing/);
    await expect(page.getByText('No instances match these filters')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(`${REGISTER}?${FY}`);
    await expect.poll(() => count(page)).toBe(all);
  });

  test('an approver selects the waiting rows and approves them', async ({ page }) => {
    // Every due date from April 2023, so all of the approver's waiting rows are in the view.
    await signIn(
      page,
      'approver@demo.test',
      `${REGISTER}?dueFrom=2023-04-01&workflowState=SUBMITTED`,
    );
    const table = page.getByRole('table', { name: 'Register' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await table.getByRole('checkbox', { name: 'Select all rows' }).check();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText(/^Approved \d+ instances?\.$/)).toBeVisible();
    await checkPage(page);
  });

  test('an owner sees their rows with no approve or export', async ({ page }) => {
    await signIn(page, 'owner@demo.test', `${REGISTER}?${FY}`);
    const table = page.getByRole('table', { name: 'Register' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await expect(table.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);
  });

  test('the period picker narrows the register to a quarter', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${REGISTER}?${FY}`);
    await expect(
      page.getByRole('table', { name: 'Register' }).getByRole('row').nth(1),
    ).toBeVisible();
    const year = await count(page);
    await page.goto(`${REGISTER}?${FY}&q=Q1`);
    await expect.poll(() => count(page)).toBeLessThan(year);
    const dates = await page
      .getByRole('table', { name: 'Register' })
      .getByRole('cell')
      .filter({ hasText: /^\d{1,2} [A-Z][a-z]{2} \d{4}$/ })
      .allInnerTexts();
    // Q1 of FY 2023-24 is April to June 2023.
    for (const date of dates) expect(date).toMatch(/ (Apr|May|Jun) 2023$/);
  });

  test('a saved view brings back its filters and density', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${REGISTER}?${FY}&status=COMPLIED`);
    await page.getByRole('button', { name: 'Compact rows' }).click();
    await page.getByRole('button', { name: /^View: / }).click();
    await page.getByRole('menuitem', { name: 'Save current view…' }).click();
    await page.getByRole('textbox', { name: /View name/ }).fill('Complied, compact');
    await page.getByRole('button', { name: 'Save view' }).click();
    await expect(page.getByRole('button', { name: 'View: Complied, compact' })).toBeVisible();

    await page.goto(`${REGISTER}?${FY}`);
    await page.getByRole('button', { name: /^View: / }).click();
    await page.getByRole('menuitemradio', { name: 'Complied, compact' }).click();
    await expect(page).toHaveURL(/status=COMPLIED/);
    await expect(page.getByRole('button', { name: 'Comfortable rows' })).toBeVisible();
  });
});

test.describe('register at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('fits the screen and still filters', async ({ page }) => {
    await signIn(page, 'approver@demo.test', `${REGISTER}?${FY}`);
    await expect(
      page.getByRole('table', { name: 'Register' }).getByRole('row').nth(1),
    ).toBeVisible();
    await checkPage(page);
    await page.getByRole('button', { name: 'Filters' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});
